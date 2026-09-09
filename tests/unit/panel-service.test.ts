import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDatabase } from '../../src/db/schema.js';
import { AlarmPanelRepository } from '../../src/alarm/panel-repository.js';
import { EventRepository } from '../../src/events/event-repository.js';
import { ZoneRepository } from '../../src/db/repositories/zone-repository.js';
import { SensorRepository } from '../../src/db/repositories/sensor-repository.js';
import { UserRepository } from '../../src/auth/user-repository.js';
import { PanelService, PanelStateError } from '../../src/alarm/panel-service.js';
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
