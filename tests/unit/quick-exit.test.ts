import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDatabase } from '../../src/db/schema.js';
import { AlarmPanelRepository } from '../../src/alarm/panel-repository.js';
import { EventRepository } from '../../src/events/event-repository.js';
import { ZoneRepository } from '../../src/db/repositories/zone-repository.js';
import { SensorRepository } from '../../src/db/repositories/sensor-repository.js';
import { PanelService, QUICK_EXIT_WINDOW_MS } from '../../src/alarm/panel-service.js';

async function armedService() {
  const db = createDatabase(':memory:');
  const service = new PanelService(new AlarmPanelRepository(db), new EventRepository(db), { exitDelayMs: 1000, entryDelayMs: 1000 });
  const zone = new ZoneRepository(db).create('Front');
  const sensors = new SensorRepository(db);
  const door = sensors.create({ zwaveNodeId: 1, zoneId: zone.id, name: 'Door', category: 'intrusion', quickExitEnabled: true });
  const other = sensors.create({ zwaveNodeId: 2, zoneId: zone.id, name: 'Back door', category: 'intrusion', quickExitEnabled: true });
  const smoke = sensors.create({ zwaveNodeId: 3, zoneId: zone.id, name: 'Smoke', category: 'life-safety' });
  await service.arm('armed_away', { source: 'native' });
  await vi.advanceTimersByTimeAsync(1000);
  expect(service.getState().mode).toBe('armed_away');
  return { service, door, other, smoke };
}

describe('quick exit', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('uses a 5 second window', () => {
    expect(QUICK_EXIT_WINDOW_MS).toBe(5000);
  });

  it('ignores a breach of that sensor inside the window', async () => {
    const { service, door } = await armedService();
    service.startQuickExit(door.id);
    await vi.advanceTimersByTimeAsync(QUICK_EXIT_WINDOW_MS - 1);

    expect(service.reportSensorBreach(door).mode).toBe('armed_away');
  });

  it('counts a breach once the window has ended', async () => {
    const { service, door } = await armedService();
    service.startQuickExit(door.id);
    await vi.advanceTimersByTimeAsync(QUICK_EXIT_WINDOW_MS);

    expect(service.reportSensorBreach(door).mode).toBe('alarm_pending');
  });

  it('does not cover other sensors, life-safety sensors or tamper', async () => {
    const { service, door, other, smoke } = await armedService();
    service.startQuickExit(door.id);

    expect(service.reportSensorTamper(door).mode).toBe('alarm_triggered');
    expect(service.reportSensorBreach(smoke).mode).toBe('alarm_triggered');
    expect(other.id).not.toBe(door.id);
  });

  it('does not cover another sensor', async () => {
    const { service, door, other } = await armedService();
    service.startQuickExit(door.id);

    expect(service.reportSensorBreach(other).mode).toBe('alarm_pending');
  });
});
