import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDatabase } from '../../src/db/schema.js';
import { AlarmPanelRepository } from '../../src/alarm/panel-repository.js';
import { EventRepository } from '../../src/events/event-repository.js';
import { ZoneRepository } from '../../src/db/repositories/zone-repository.js';
import { SensorRepository, type SensorPlacement } from '../../src/db/repositories/sensor-repository.js';
import { ModeConfigRepository } from '../../src/db/repositories/mode-config-repository.js';
import { UserRepository } from '../../src/auth/user-repository.js';
import { NeedsBypassError, PanelService, PanelStateError, UnknownBypassSensorError } from '../../src/alarm/panel-service.js';
import { CommandRejectedError } from '../../src/alarm/dispatcher.js';

const EXIT_DELAY_MS = 1_000;
const ENTRY_DELAY_MS = 1_000;

function buildService() {
  const db = createDatabase(':memory:');
  const panelRepo = new AlarmPanelRepository(db);
  const eventRepo = new EventRepository(db);
  const zoneRepo = new ZoneRepository(db);
  const sensorRepo = new SensorRepository(db);
  const userRepo = new UserRepository(db);

  const service = new PanelService(panelRepo, eventRepo, {
    exitDelayMs: EXIT_DELAY_MS,
    entryDelayMs: ENTRY_DELAY_MS,
  });

  const zone = zoneRepo.create('Front Door');
  const intrusionSensor = sensorRepo.create({ zwaveNodeId: 1, zoneId: zone.id, name: 'Door contact', category: 'intrusion' });
  const lifeSafetySensor = sensorRepo.create({ zwaveNodeId: 2, zoneId: zone.id, name: 'Smoke detector', category: 'life-safety' });
  const user = userRepo.create({ name: 'Alice', role: 'administrator', code: '1234' });

  return { service, eventRepo, zone, intrusionSensor, lifeSafetySensor, userId: user.id };
}

describe('PanelService', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('arm() starts the exit delay immediately, resolving right away with the arming state', async () => {
    const { service, eventRepo, userId } = buildService();

    const armPromise = service.arm('armed_away', { source: 'native', sourceUserId: userId });
    const arming = await armPromise;
    expect(arming.mode).toBe('arming');
    expect(arming.pendingDelayEndsAt).not.toBeNull();
    expect(eventRepo.list()).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(EXIT_DELAY_MS);

    const finalState = service.getState();
    expect(finalState.mode).toBe('armed_away');
    expect(finalState.pendingDelayEndsAt).toBeNull();

    const events = eventRepo.list();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'armed', source: 'user', sourceUserId: userId });
  });

  it('disarm() during the exit delay cancels arming and returns to disarmed without an alarm_cleared event', async () => {
    const { service, eventRepo, userId } = buildService();

    await service.arm('armed_home', { source: 'native' });
    expect(service.getState().mode).toBe('arming');

    const disarmed = await service.disarm({ source: 'native', sourceUserId: userId });
    expect(disarmed.mode).toBe('disarmed');

    // Advancing past the original exit delay must not resurrect the arm.
    await vi.advanceTimersByTimeAsync(EXIT_DELAY_MS);
    expect(service.getState().mode).toBe('disarmed');

    const events = eventRepo.list();
    expect(events.map((e) => e.type)).toEqual(['disarmed']);
  });

  it('rejects arm() when the panel is not currently disarmed', async () => {
    const { service } = buildService();

    await service.arm('armed_away', { source: 'native' });
    await vi.advanceTimersByTimeAsync(EXIT_DELAY_MS);
    expect(service.getState().mode).toBe('armed_away');

    await expect(service.arm('armed_home', { source: 'native' })).rejects.toBeInstanceOf(PanelStateError);
  });

  it('an intrusion breach while armed starts the entry delay, then triggers the alarm if not disarmed', async () => {
    const { service, eventRepo, intrusionSensor } = buildService();

    await service.arm('armed_away', { source: 'native' });
    await vi.advanceTimersByTimeAsync(EXIT_DELAY_MS);

    const pending = service.reportSensorBreach(intrusionSensor);
    expect(pending.mode).toBe('alarm_pending');
    expect(pending.pendingDelayEndsAt).not.toBeNull();
    expect(pending.triggeredBy).not.toBeNull();

    await vi.advanceTimersByTimeAsync(ENTRY_DELAY_MS);
    const triggered = service.getState();
    expect(triggered.mode).toBe('alarm_triggered');

    const types = eventRepo.list().map((e) => e.type);
    expect(types).toEqual(['alarm_triggered', 'breach', 'armed']);
  });

  it('disarming during the entry delay clears the pending alarm and records alarm_cleared', async () => {
    const { service, eventRepo, intrusionSensor, userId } = buildService();

    await service.arm('armed_away', { source: 'native' });
    await vi.advanceTimersByTimeAsync(EXIT_DELAY_MS);
    service.reportSensorBreach(intrusionSensor);
    expect(service.getState().mode).toBe('alarm_pending');

    const disarmed = await service.disarm({ source: 'native', sourceUserId: userId });
    expect(disarmed.mode).toBe('disarmed');
    expect(disarmed.triggeredBy).toBeNull();

    // The entry delay must not fire an alarm after the disarm.
    await vi.advanceTimersByTimeAsync(ENTRY_DELAY_MS);
    expect(service.getState().mode).toBe('disarmed');

    const types = eventRepo.list().map((e) => e.type);
    expect(types).toEqual(['alarm_cleared', 'breach', 'armed']);
  });

  it('records who cleared a triggered alarm on the alarm_cleared event', async () => {
    const { service, eventRepo, lifeSafetySensor, userId } = buildService();

    service.reportSensorBreach(lifeSafetySensor);
    expect(service.getState().mode).toBe('alarm_triggered');

    await service.disarm({ source: 'native', sourceUserId: userId, clearedBy: 'Alice' });

    const clearedEvent = eventRepo.list().find((e) => e.type === 'alarm_cleared');
    expect(clearedEvent?.details).toBe('Cleared by Alice');
  });

  it('records "Home Assistant" as who cleared a triggered alarm when disarmed via HA', async () => {
    const { service, eventRepo, lifeSafetySensor, userId } = buildService();

    service.reportSensorBreach(lifeSafetySensor);
    expect(service.getState().mode).toBe('alarm_triggered');

    await service.disarm({ source: 'home_assistant', sourceUserId: userId, clearedBy: 'Home Assistant' });

    const clearedEvent = eventRepo.list().find((e) => e.type === 'alarm_cleared');
    expect(clearedEvent?.details).toBe('Cleared by Home Assistant');
  });

  it('a plain disarm (not clearing an alarm) records no clearedBy details even if provided', async () => {
    const { service, eventRepo, userId } = buildService();

    await service.arm('armed_away', { source: 'native' });
    await vi.advanceTimersByTimeAsync(EXIT_DELAY_MS);

    await service.disarm({ source: 'native', sourceUserId: userId, clearedBy: 'Alice' });

    const disarmedEvent = eventRepo.list().find((e) => e.type === 'disarmed');
    expect(disarmedEvent?.details).toBeNull();
  });

  it('an intrusion breach while disarmed is ignored (armed-state-gated per FR-003)', () => {
    const { service, eventRepo, intrusionSensor } = buildService();

    const result = service.reportSensorBreach(intrusionSensor);
    expect(result.mode).toBe('disarmed');
    expect(eventRepo.list()).toHaveLength(0);
  });

  it('a life-safety sensor triggers the alarm immediately from any mode, bypassing delays (FR-015)', () => {
    const { service, eventRepo, lifeSafetySensor, zone } = buildService();

    const triggered = service.reportSensorBreach(lifeSafetySensor);
    expect(triggered.mode).toBe('alarm_triggered');
    expect(triggered.pendingDelayEndsAt).toBeNull();

    const events = eventRepo.list();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'alarm_triggered',
      relatedZoneId: zone.id,
      relatedSensorId: lifeSafetySensor.id,
    });
  });

  it('triggerAlarm() cancels an in-flight exit delay so arming cannot resurrect after a life-safety trigger', async () => {
    const { service, lifeSafetySensor } = buildService();

    await service.arm('armed_away', { source: 'native' });
    expect(service.getState().mode).toBe('arming');

    service.reportSensorBreach(lifeSafetySensor);
    expect(service.getState().mode).toBe('alarm_triggered');

    await vi.advanceTimersByTimeAsync(EXIT_DELAY_MS);
    expect(service.getState().mode).toBe('alarm_triggered');
  });

  it('disarm() while already disarmed is a no-op that records no event', async () => {
    const { service, eventRepo } = buildService();

    const result = await service.disarm({ source: 'native' });
    expect(result.mode).toBe('disarmed');
    expect(eventRepo.list()).toHaveLength(0);
  });

  it('commands are wired through the dispatcher: a racing home_assistant command loses to native (FR-014)', async () => {
    const { service } = buildService();
    const now = Date.now();

    const nativeArm = service.arm('armed_away', { source: 'native', requestedAt: now });
    const haDisarm = service.disarm({ source: 'home_assistant', requestedAt: now + 100 });

    await expect(haDisarm).rejects.toBeInstanceOf(CommandRejectedError);
    await expect(nativeArm).resolves.toMatchObject({ mode: 'arming' });
  });
});

describe('PanelService trigger evaluation (per-mode delays and placements)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function build(modeDelays = { entryDelaySec: 10, exitDelaySec: 5 }) {
    const db = createDatabase(':memory:');
    const modeConfig = new ModeConfigRepository(db);
    modeConfig.ensureSeeded(modeDelays);
    const panelRepo = new AlarmPanelRepository(db);
    const service = new PanelService(panelRepo, new EventRepository(db), { modeConfig });
    const zone = new ZoneRepository(db).create('House');
    const sensors = new SensorRepository(db);
    let node = 1;
    const add = (placement: SensorPlacement, extra: Partial<{ armedHome: boolean; armedAway: boolean; alertsOnly: boolean }> = {}) =>
      sensors.create({ zwaveNodeId: node++, zoneId: zone.id, name: placement, category: 'intrusion', placement, ...extra });
    return { service, modeConfig, add };
  }

  async function armed(service: PanelService, mode: 'armed_home' | 'armed_away', exitSec = 5) {
    await service.arm(mode, { source: 'native' });
    await vi.advanceTimersByTimeAsync(exitSec * 1000);
    expect(service.getState().mode).toBe(mode);
  }

  it('uses each mode\'s own exit delay', async () => {
    const { service, modeConfig } = build();
    modeConfig.update({ armed_home: { exitDelaySec: 30 } });

    const arming = await service.arm('armed_home', { source: 'native' });

    expect((arming.pendingDelayEndsAt ?? 0) - Date.now()).toBe(30_000);
  });

  it('starts the entry delay for MAIN_DOOR and ENTRYWAY, using the armed mode\'s entry delay', async () => {
    const { service, modeConfig, add } = build();
    modeConfig.update({ armed_away: { entryDelaySec: 20 } });
    await armed(service, 'armed_away');

    const pending = service.reportSensorBreach(add('MAIN_DOOR'));

    expect(pending.mode).toBe('alarm_pending');
    expect((pending.pendingDelayEndsAt ?? 0) - Date.now()).toBe(20_000);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(service.getState().mode).toBe('alarm_triggered');
  });

  it.each(['SECONDARY_DOOR', 'WINDOW', 'ROOM', 'GLASS_BREAK'] as const)('alarms at once for %s', async (placement) => {
    const { service, add } = build();
    await armed(service, 'armed_away');

    expect(service.reportSensorBreach(add(placement)).mode).toBe('alarm_triggered');
  });

  it('alarms at once for a MAIN_DOOR when the mode\'s entry delay is 0', async () => {
    const { service, add } = build({ entryDelaySec: 0, exitDelaySec: 5 });
    await armed(service, 'armed_away');

    expect(service.reportSensorBreach(add('MAIN_DOOR')).mode).toBe('alarm_triggered');
  });

  it('ignores a sensor that is not armed for the current mode, and one that is alerts-only', async () => {
    const { service, add } = build();
    await armed(service, 'armed_home');

    expect(service.reportSensorBreach(add('ROOM')).mode).toBe('armed_home'); // motion defaults to armed AWAY only
    expect(service.reportSensorBreach(add('WINDOW', { alertsOnly: true })).mode).toBe('armed_home');
    expect(service.reportSensorBreach(add('WINDOW', { armedHome: false })).mode).toBe('armed_home');
    expect(service.reportSensorBreach(add('WINDOW')).mode).toBe('alarm_triggered');
  });

  it('does not alarm during the exit delay', async () => {
    const { service, add } = build();
    await service.arm('armed_away', { source: 'native' });

    expect(service.reportSensorBreach(add('WINDOW')).mode).toBe('arming');
  });

  it('does not restart a running entry delay, but a SECONDARY_DOOR during it alarms at once', async () => {
    const { service, add } = build();
    await armed(service, 'armed_away');
    const first = service.reportSensorBreach(add('MAIN_DOOR'));
    await vi.advanceTimersByTimeAsync(4_000);

    const second = service.reportSensorBreach(add('ENTRYWAY'));
    expect(second.mode).toBe('alarm_pending');
    expect(second.pendingDelayEndsAt).toBe(first.pendingDelayEndsAt);

    expect(service.reportSensorBreach(add('SECONDARY_DOOR')).mode).toBe('alarm_triggered');
  });

  it('reports the modes and persists changes', () => {
    const { service } = build();

    expect(service.getModes()).toEqual({
      armed_home: { entryDelaySec: 10, exitDelaySec: 5 },
      armed_away: { entryDelaySec: 10, exitDelaySec: 5 },
    });
    expect(service.updateModes({ armed_home: { entryDelaySec: 0 } }).armed_home).toEqual({ entryDelaySec: 0, exitDelaySec: 5 });
  });
});

describe('PanelService pre-arm check and bypass', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function build() {
    const db = createDatabase(':memory:');
    const modeConfig = new ModeConfigRepository(db);
    modeConfig.ensureSeeded({ entryDelaySec: 10, exitDelaySec: 5 });
    const sensorRepo = new SensorRepository(db);
    const eventRepo = new EventRepository(db);
    const service = new PanelService(new AlarmPanelRepository(db), eventRepo, { modeConfig, sensorRepo });
    const zone = new ZoneRepository(db).create('House');
    let node = 1;
    const add = (name: string, placement: SensorPlacement = 'WINDOW') =>
      sensorRepo.create({ zwaveNodeId: node++, zoneId: zone.id, name, category: 'intrusion', placement });
    const open = (id: string) => sensorRepo.updateState(id, { currentState: 'breached' });
    const offline = (id: string) => sensorRepo.updateState(id, { connectivityStatus: 'offline' });
    return { service, eventRepo, sensorRepo, add, open, offline };
  }

  it('arms straight away when nothing is faulted', async () => {
    const { service, add } = build();
    add('Window');

    const panel = await service.arm('armed_away', { source: 'native' });

    expect(panel).toMatchObject({ mode: 'arming', bypassedDeviceIds: [], armedMode: 'armed_away' });
    expect(panel.exitEndsAt).toBe(panel.pendingDelayEndsAt);
    expect(panel.entryEndsAt).toBeNull();
  });

  it('refuses with NeedsBypassError listing open and offline sensors, and changes nothing', async () => {
    const { service, add, open, offline } = build();
    const door = add('Back door');
    const window = add('Window');
    add('Fine');
    open(door.id);
    offline(window.id);

    const error = await service.arm('armed_away', { source: 'native', armSource: 'app' }).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(NeedsBypassError);
    expect((error as NeedsBypassError).faulted).toEqual([
      { sensorId: door.id, name: 'Back door', zoneId: door.zoneId, reason: 'open' },
      { sensorId: window.id, name: 'Window', zoneId: window.zoneId, reason: 'offline' },
    ]);
    expect(service.getState().mode).toBe('disarmed');
  });

  it('only counts sensors armed for the target mode (motion is not armed for home)', async () => {
    const { service, add, open } = build();
    open(add('Hall motion', 'ROOM').id);

    expect((await service.arm('armed_home', { source: 'native' })).mode).toBe('arming');
  });

  it('arms with a confirmed bypass, keeps it for the session, and stops the bypassed sensor alarming', async () => {
    const { service, eventRepo, add, open } = build();
    const door = add('Back door');
    open(door.id);

    const panel = await service.arm('armed_away', { source: 'native', bypass: [door.id] });
    await vi.advanceTimersByTimeAsync(5_000);

    expect(panel.bypassedDeviceIds).toEqual([door.id]);
    expect(service.getState().mode).toBe('armed_away');
    expect(service.reportSensorBreach({ ...door, currentState: 'breached' }).mode).toBe('armed_away');
    const armed = eventRepo.list().find((event) => event.type === 'armed');
    expect(armed?.details).toBe('Armed via app; bypassed Back door (open)');
  });

  it('still arms when every sensor is bypassed, and still alarms for a sensor that is not', async () => {
    const { service, add, open } = build();
    const door = add('Back door');
    const window = add('Window');
    open(door.id);
    await service.arm('armed_away', { source: 'native', bypass: [door.id] });
    await vi.advanceTimersByTimeAsync(5_000);

    expect(service.reportSensorBreach(window).mode).toBe('alarm_triggered');
  });

  it.each(['lock', 'schedule'] as const)('auto-bypasses faulted sensors for a %s source', async (armSource) => {
    const { service, add, open } = build();
    const door = add('Back door');
    open(door.id);

    const panel = await service.arm('armed_away', { source: 'native', armSource });

    expect(panel.bypassedDeviceIds).toEqual([door.id]);
  });

  it('clears the bypass on disarm', async () => {
    const { service, add, open } = build();
    const door = add('Back door');
    open(door.id);
    await service.arm('armed_away', { source: 'native', bypass: [door.id] });

    const panel = await service.disarm({ source: 'native' });

    expect(panel.bypassedDeviceIds).toEqual([]);
    expect(service.getState().bypassedDeviceIds).toEqual([]);
  });

  it('rejects a bypass naming an unknown sensor', async () => {
    const { service, add } = build();
    add('Window');

    await expect(service.arm('armed_away', { source: 'native', bypass: ['nope'] })).rejects.toBeInstanceOf(
      UnknownBypassSensorError,
    );
  });
});
