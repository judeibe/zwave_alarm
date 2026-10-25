import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDatabase } from '../../src/db/schema.js';
import { AlarmPanelRepository } from '../../src/alarm/panel-repository.js';
import { AlarmEventRepository } from '../../src/alarm/alarm-event-repository.js';
import { AlarmEventService, CANCEL_WINDOW_MS, SIREN_DURATION_MS } from '../../src/alarm/alarm-event-service.js';
import { PanelService, PanelStateError } from '../../src/alarm/panel-service.js';
import { EventRepository } from '../../src/events/event-repository.js';
import { ZoneRepository } from '../../src/db/repositories/zone-repository.js';
import { SensorRepository } from '../../src/db/repositories/sensor-repository.js';

function build() {
  const db = createDatabase(':memory:');
  const alarmEvents = new AlarmEventService(new AlarmEventRepository(db));
  const sensorRepo = new SensorRepository(db);
  const panel = new PanelService(new AlarmPanelRepository(db), new EventRepository(db), {
    exitDelayMs: 1,
    entryDelayMs: 100_000,
    alarmEvents,
    sensorRepo,
  });
  const zone = new ZoneRepository(db).create('House');
  const add = (category: 'intrusion' | 'life-safety', node: number, alarmKind?: 'SMOKE' | 'CO' | 'FLOOD_FREEZE') =>
    sensorRepo.create({ zwaveNodeId: node, zoneId: zone.id, name: `n${String(node)}`, category, alarmKind, placement: 'WINDOW' });
  return { alarmEvents, panel, add };
}

describe('alarm events', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it.each([
    ['SMOKE', 'SMOKE', 'sounding', 'held'],
    ['CO', 'CO', 'sounding', 'queued'],
    ['FLOOD_FREEZE', 'FLOOD_FREEZE', 'none', 'none'],
  ] as const)('a %s sensor opens a %s event (siren %s, dispatch %s)', (kind, type, siren, dispatch) => {
    const { alarmEvents, panel, add } = build();

    panel.reportSensorBreach(add('life-safety', 2, kind));

    expect(alarmEvents.listActive()).toMatchObject([{ type, sirenState: siren, dispatchState: dispatch }]);
    expect(panel.getState().mode).toBe(siren === 'none' ? 'disarmed' : 'alarm_triggered');
  });

  it('an armed intrusion breach becomes a BURGLARY held for the cancel window, then queued', async () => {
    const { alarmEvents, panel, add } = build();
    const window = add('intrusion', 3);
    await panel.arm('armed_away', { source: 'native' });
    await vi.advanceTimersByTimeAsync(5);

    panel.reportSensorBreach(window);
    expect(alarmEvents.listActive()[0]).toMatchObject({ type: 'BURGLARY', triggerDeviceId: window.id, dispatchState: 'held' });

    await vi.advanceTimersByTimeAsync(CANCEL_WINDOW_MS);
    expect(alarmEvents.listActive()[0]?.dispatchState).toBe('queued');
  });

  it('a disarm inside the window cancels BURGLARY dispatch and stops the siren, outside it does not', async () => {
    const { alarmEvents, panel, add } = build();
    const window = add('intrusion', 3);
    await panel.arm('armed_away', { source: 'native' });
    await vi.advanceTimersByTimeAsync(5);
    panel.reportSensorBreach(window);

    await panel.disarm({ source: 'native' });

    expect(alarmEvents.list()[0]).toMatchObject({ dispatchState: 'cancelled', sirenState: 'stopped' });
    expect(alarmEvents.list()[0]?.cancelledAt).not.toBeNull();
    expect(alarmEvents.list()[0]?.endedAt).not.toBeNull();
    expect(alarmEvents.listActive()).toEqual([]);

    await panel.arm('armed_away', { source: 'native' });
    await vi.advanceTimersByTimeAsync(5);
    panel.reportSensorBreach(window);
    await vi.advanceTimersByTimeAsync(CANCEL_WINDOW_MS + 1);
    await panel.disarm({ source: 'native' });
    expect(alarmEvents.list()[0]).toMatchObject({ dispatchState: 'queued', cancelledAt: null, sirenState: 'stopped' });
  });

  it('CO still dispatches after a disarm', async () => {
    const { alarmEvents, panel, add } = build();
    panel.reportSensorBreach(add('life-safety', 2, 'CO'));

    await panel.disarm({ source: 'native' });

    expect(alarmEvents.list()[0]).toMatchObject({ type: 'CO', dispatchState: 'queued', sirenState: 'stopped' });
  });

  it.each([
    ['PANIC', undefined, 'PANIC', 'police', 'sounding'],
    ['FIRE', undefined, 'FIRE_MEDICAL', 'fire', 'sounding'],
    ['MEDICAL', undefined, 'FIRE_MEDICAL', 'medical', 'none'],
    ['SOS', 'fire', 'SOS', 'fire', 'sounding'],
    ['SOS', undefined, 'SOS', 'police', 'sounding'],
  ] as const)('%s (%s) opens a %s event for %s with siren %s', (kind, service, type, expectedService, siren) => {
    const { panel } = build();

    const event = panel.raiseEmergency(kind, { service });

    expect(event).toMatchObject({ type, service: expectedService, sirenState: siren, dispatchState: 'queued' });
  });

  it('silence mutes the siren but keeps the alarm and the panel in alarm', () => {
    const { alarmEvents, panel } = build();
    panel.raiseEmergency('PANIC');

    const silenced = panel.silence();

    expect(silenced).toHaveLength(1);
    expect(alarmEvents.listActive()[0]).toMatchObject({ sirenState: 'silenced', endedAt: null });
    expect(panel.getState().mode).toBe('alarm_triggered');
    expect(() => panel.silence()).toThrow(PanelStateError);
  });

  it('a disarm closes a silent event even though the panel was already disarmed', async () => {
    const { alarmEvents, panel } = build();
    panel.raiseEmergency('MEDICAL');
    expect(panel.getState().mode).toBe('disarmed');

    await panel.disarm({ source: 'native' });

    expect(alarmEvents.listActive()).toEqual([]);
  });

  it('emits alarm_event on every change', async () => {
    const { alarmEvents, panel } = build();
    const seen: string[] = [];
    alarmEvents.on('alarm_event', (event: { sirenState: string }) => seen.push(event.sirenState));

    panel.raiseEmergency('PANIC');
    panel.silence();
    await panel.disarm({ source: 'native' });

    expect(seen).toEqual(['sounding', 'silenced', 'stopped']);
  });

  it('times a sounding siren out after 600 s on resume if it ran while the service was down', () => {
    const { alarmEvents, panel } = build();
    panel.raiseEmergency('PANIC');
    vi.setSystemTime(Date.now() + SIREN_DURATION_MS + 1);

    alarmEvents.resume();

    expect(alarmEvents.listActive()[0]?.sirenState).toBe('timed_out');
  });
});
