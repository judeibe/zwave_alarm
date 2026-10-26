import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CommandClasses } from '@zwave-js/core';
import { createDatabase } from '../../src/db/schema.js';
import { AlarmPanelRepository } from '../../src/alarm/panel-repository.js';
import { AlarmEventRepository } from '../../src/alarm/alarm-event-repository.js';
import { AlarmEventService } from '../../src/alarm/alarm-event-service.js';
import { EventRepository } from '../../src/events/event-repository.js';
import { ZoneRepository } from '../../src/db/repositories/zone-repository.js';
import { SensorRepository } from '../../src/db/repositories/sensor-repository.js';
import { ModeConfigRepository } from '../../src/db/repositories/mode-config-repository.js';
import { PanelService } from '../../src/alarm/panel-service.js';
import { UserRepository } from '../../src/auth/user-repository.js';
import { LockoutPolicyRepository } from '../../src/auth/lockout-policy-repository.js';
import { LockoutService } from '../../src/auth/lockout-service.js';
import { KeypadService } from '../../src/keypads/keypad-service.js';
import { BYPASS_CONFIRM_WINDOW_MS, KeypadController } from '../../src/keypads/keypad-controller.js';
import { ringKeypadV2Adapter } from '../../src/keypads/adapters/ring-keypad-v2.adapter.js';

const NODE = 12;
const indicatorWrite = (property: number, propertyKey: number, value: number) => ({
  commandClass: CommandClasses.Indicator,
  endpoint: 0,
  property,
  propertyKey,
  value,
});
const entryControl = (eventType: number, eventData?: string) => ({
  commandClass: CommandClasses['Entry Control'],
  args: { eventType, eventData },
});
const ARM_AWAY = 5;
const ARM_HOME = 6;

function build(options: { requireCodeToArm?: boolean } = {}) {
  const db = createDatabase(':memory:');
  const eventRepo = new EventRepository(db);
  const userRepo = new UserRepository(db);
  const sensorRepo = new SensorRepository(db);
  const modeConfig = new ModeConfigRepository(db);
  modeConfig.ensureSeeded({ entryDelaySec: 30, exitDelaySec: 45 });
  const alarmEvents = new AlarmEventService(new AlarmEventRepository(db));
  const panelService = new PanelService(new AlarmPanelRepository(db), eventRepo, { modeConfig, sensorRepo, alarmEvents });
  const lockoutService = new LockoutService(userRepo, new LockoutPolicyRepository(db), eventRepo, panelService);
  const writes: { nodeId: number; writes: unknown[] }[] = [];
  const keypads = new KeypadService((nodeId, w) => {
    writes.push({ nodeId, writes: w });
    return Promise.resolve();
  });
  keypads.add(NODE, ringKeypadV2Adapter);
  let offset = 0;
  new KeypadController(keypads, panelService, userRepo, lockoutService, eventRepo, new ZoneRepository(db), {
    requireCodeToArm: () => options.requireCodeToArm ?? false,
    alarmEvents,
    chirpVolume: () => 55,
    now: () => Date.now() + offset,
  }).start();
  writes.length = 0;
  const wrote = (...expected: unknown[]) => writes.some((entry) => JSON.stringify(entry.writes) === JSON.stringify(expected));
  const zone = new ZoneRepository(db).create('House');
  const add = (name: string, extra: Partial<{ placement: 'WINDOW' | 'MAIN_DOOR'; chirpTone: 'none' | 'guitar' }> = {}) =>
    sensorRepo.create({ zwaveNodeId: 20 + sensorRepo.list().length, zoneId: zone.id, name, category: 'intrusion', placement: 'WINDOW', ...extra });
  return {
    panelService, alarmEvents, keypads, userRepo, sensorRepo, modeConfig, writes, wrote, add, advance: (ms: number) => void (offset += ms),
  };
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 20));

describe('keypad siren follows the alarm events', () => {
  it('sounds for a sounding event, and goes quiet on silence while the panel stays in alarm', async () => {
    const { panelService, wrote } = build();

    panelService.raiseEmergency('PANIC');
    await vi.waitFor(() => expect(wrote(indicatorWrite(13, 1, 1))).toBe(true));
    panelService.silence();

    await vi.waitFor(() => expect(wrote(indicatorWrite(13, 1, 0))).toBe(true));
    await vi.waitFor(() => expect(wrote(indicatorWrite(2, 1, 99))).toBe(true)); // back to the disarmed light
    expect(panelService.getState().mode).toBe('alarm_triggered');
  });

  it('goes quiet when the 600 s limit passes, and when a disarm ends the alarm', async () => {
    const { panelService, alarmEvents, writes } = build();

    panelService.raiseEmergency('PANIC');
    await settle();
    alarmEvents.timeOutSiren();
    await settle();
    const off = (): number => writes.filter((entry) => JSON.stringify(entry.writes) === JSON.stringify([indicatorWrite(13, 1, 0)])).length;
    expect(off()).toBe(1);

    panelService.raiseEmergency('FIRE');
    await settle();
    await panelService.disarm({ source: 'native' });
    await settle();
    expect(off()).toBe(2);
  });

  it('does not sound for silent events: medical, duress or flood', async () => {
    const { panelService, wrote } = build();

    panelService.raiseEmergency('MEDICAL');
    panelService.raiseDuress('test');
    await settle();

    expect(wrote(indicatorWrite(13, 1, 1))).toBe(false);
    expect(wrote(indicatorWrite(13, 1, 0))).toBe(false);
  });

  it('switches the siren on only once however many events pile up', async () => {
    const { panelService, writes } = build();

    panelService.raiseEmergency('PANIC');
    panelService.raiseEmergency('FIRE');
    await settle();

    const ons = writes.filter((entry) => JSON.stringify(entry.writes) === JSON.stringify([indicatorWrite(13, 1, 1)]));
    expect(ons).toHaveLength(1);
  });
});

describe('countdown tones', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('starts the exit delay with the mode\'s own number of seconds, then shows the armed mode', async () => {
    const { panelService, keypads, wrote } = build();

    keypads.receive(NODE, entryControl(ARM_AWAY));
    await vi.advanceTimersByTimeAsync(5);
    expect(wrote(indicatorWrite(18, 7, 45))).toBe(true);

    await vi.advanceTimersByTimeAsync(45_000);
    expect(panelService.getState().mode).toBe('armed_away');
    expect(wrote(indicatorWrite(11, 1, 99))).toBe(true);
  });

  it('starts the entry delay with the mode\'s entry seconds when a main door opens', async () => {
    const { panelService, keypads, wrote, add } = build();
    const door = add('Front door', { placement: 'MAIN_DOOR' });
    keypads.receive(NODE, entryControl(ARM_AWAY));
    await vi.advanceTimersByTimeAsync(45_100);

    panelService.reportSensorBreach(door);
    await vi.advanceTimersByTimeAsync(5);

    expect(panelService.getState().mode).toBe('alarm_pending');
    expect(wrote(indicatorWrite(17, 7, 30))).toBe(true);
  });
});

describe('confirming a bypass at the keypad', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('asks first, and arming the same mode again within the window bypasses the open sensors', async () => {
    const { panelService, keypads, wrote, add, sensorRepo } = build();
    const window = add('Back window');
    sensorRepo.updateState(window.id, { currentState: 'breached' });

    keypads.receive(NODE, entryControl(ARM_AWAY));
    await vi.advanceTimersByTimeAsync(5);
    expect(wrote(indicatorWrite(16, 1, 1))).toBe(true); // bypass required
    expect(panelService.getState().mode).toBe('disarmed');

    keypads.receive(NODE, entryControl(ARM_AWAY));
    await vi.advanceTimersByTimeAsync(5);
    expect(panelService.getState()).toMatchObject({ mode: 'arming', armedMode: 'armed_away', bypassedDeviceIds: [window.id] });
  });

  it('declines after the window, and for a different mode', async () => {
    const { panelService, keypads, wrote, add, sensorRepo, advance } = build();
    const window = add('Back window');
    sensorRepo.updateState(window.id, { currentState: 'breached' });

    keypads.receive(NODE, entryControl(ARM_AWAY));
    await vi.advanceTimersByTimeAsync(5);
    advance(BYPASS_CONFIRM_WINDOW_MS + 1);
    keypads.receive(NODE, entryControl(ARM_AWAY));
    await vi.advanceTimersByTimeAsync(5);
    expect(panelService.getState().mode).toBe('disarmed'); // asked again, not armed

    keypads.receive(NODE, entryControl(ARM_HOME));
    await vi.advanceTimersByTimeAsync(5);
    expect(panelService.getState().mode).toBe('disarmed'); // a different mode is a new question
    expect(wrote(indicatorWrite(16, 1, 1))).toBe(true);
  });

  it('asks again when another sensor has opened since the prompt', async () => {
    const { panelService, keypads, add, sensorRepo } = build();
    const first = add('Back window');
    sensorRepo.updateState(first.id, { currentState: 'breached' });
    keypads.receive(NODE, entryControl(ARM_AWAY));
    await vi.advanceTimersByTimeAsync(5);

    const second = add('Garage');
    sensorRepo.updateState(second.id, { currentState: 'breached' });
    keypads.receive(NODE, entryControl(ARM_AWAY));
    await vi.advanceTimersByTimeAsync(5);

    expect(panelService.getState().mode).toBe('disarmed');
  });

  it('only the same user can confirm when arming needs a code', async () => {
    const { panelService, keypads, userRepo, add, sensorRepo } = build({ requireCodeToArm: true });
    userRepo.create({ name: 'Ada', role: 'administrator', code: '1234' });
    userRepo.create({ name: 'Bob', role: 'member', code: '5678' });
    const window = add('Back window');
    sensorRepo.updateState(window.id, { currentState: 'breached' });

    keypads.receive(NODE, entryControl(ARM_AWAY, '1234'));
    await vi.advanceTimersByTimeAsync(5);
    keypads.receive(NODE, entryControl(ARM_AWAY, '5678'));
    await vi.advanceTimersByTimeAsync(5);
    expect(panelService.getState().mode).toBe('disarmed');

    keypads.receive(NODE, entryControl(ARM_AWAY, '5678'));
    await vi.advanceTimersByTimeAsync(5);
    expect(panelService.getState()).toMatchObject({ mode: 'arming', bypassedDeviceIds: [window.id] });
  });
});

describe('sensor chirps', () => {
  it('chime on the keypads when a sensor trips in a mode with chirps on, at the keypad volume', async () => {
    const { panelService, modeConfig, add, wrote } = build();
    modeConfig.update({ disarmed: { chirpsEnabled: true } });
    const door = add('Back door');

    panelService.reportSensorBreach(door);

    await vi.waitFor(() => expect(wrote(indicatorWrite(96, 9, 55))).toBe(true)); // double_beep at volume 55
  });

  it('use the sensor\'s own tone, and none means silent', async () => {
    const { panelService, modeConfig, add, wrote, writes } = build();
    modeConfig.update({ disarmed: { chirpsEnabled: true } });

    panelService.reportSensorBreach(add('Gate', { chirpTone: 'guitar' }));
    await vi.waitFor(() => expect(wrote(indicatorWrite(97, 9, 55))).toBe(true));
    const before = writes.length;
    panelService.reportSensorBreach(add('Shed', { chirpTone: 'none' }));
    await settle();

    expect(writes.length).toBe(before);
  });

  it('stay quiet when the current mode has chirps off (the default), or the trip starts an alarm', async () => {
    const { panelService, modeConfig, add, writes } = build();
    const door = add('Back door');

    panelService.reportSensorBreach(door); // disarmed, chirps off by default
    await settle();
    expect(writes).toEqual([]);

    modeConfig.update({ armed_away: { chirpsEnabled: true } });
    await panelService.arm('armed_away', { source: 'native' });
    panelService.reportSensorBreach(add('Window')); // during the exit delay
    await settle();
    expect(writes.filter((entry) => JSON.stringify(entry.writes).includes('"property":96'))).toEqual([]);
  });
});
