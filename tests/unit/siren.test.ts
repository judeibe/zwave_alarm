import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CommandClasses } from '@zwave-js/core';
import { SetValueStatus } from 'zwave-js';
import type { Driver } from 'zwave-js';
import { createDatabase } from '../../src/db/schema.js';
import { AlarmPanelRepository } from '../../src/alarm/panel-repository.js';
import { EventRepository } from '../../src/events/event-repository.js';
import { ZoneRepository } from '../../src/db/repositories/zone-repository.js';
import { SensorRepository } from '../../src/db/repositories/sensor-repository.js';
import { PanelService } from '../../src/alarm/panel-service.js';
import { Siren } from '../../src/alarm/siren.js';

const EXIT_DELAY_MS = 1_000;
const ENTRY_DELAY_MS = 1_000;

class MockNode {
  setValue = vi.fn().mockResolvedValue({ status: SetValueStatus.Success });
}

class MockNodeMap {
  private readonly byId = new Map<number, MockNode>();

  add(id: number, node: MockNode): void {
    this.byId.set(id, node);
  }

  get(id: number): MockNode | undefined {
    return this.byId.get(id);
  }
}

class MockController {
  nodes = new MockNodeMap();
}

class MockDriver {
  controller = new MockController();
}

function buildHarness(sirenNodeId: number | null) {
  const db = createDatabase(':memory:');
  const panelRepo = new AlarmPanelRepository(db);
  const eventRepo = new EventRepository(db);
  const zoneRepo = new ZoneRepository(db);
  const sensorRepo = new SensorRepository(db);
  const panelService = new PanelService(panelRepo, eventRepo, {
    exitDelayMs: EXIT_DELAY_MS,
    entryDelayMs: ENTRY_DELAY_MS,
  });

  const zone = zoneRepo.create('Front Door');
  const lifeSafetySensor = sensorRepo.create({
    zwaveNodeId: 2,
    zoneId: zone.id,
    name: 'Smoke detector',
    category: 'life-safety',
  });

  const driver = new MockDriver();
  const sirenNode = new MockNode();
  if (sirenNodeId !== null) {
    driver.controller.nodes.add(sirenNodeId, sirenNode);
  }

  new Siren(driver as unknown as Driver, panelService, { nodeId: sirenNodeId });

  return { panelService, sirenNode, lifeSafetySensor };
}

describe('Siren', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('turns the configured siren node on when the panel transitions to alarm_triggered', () => {
    const { panelService, sirenNode, lifeSafetySensor } = buildHarness(5);

    panelService.reportSensorBreach(lifeSafetySensor);
    expect(panelService.getState().mode).toBe('alarm_triggered');

    // node.setValue() is invoked synchronously by the async setSirenState() before its first await,
    // so it's already been called by the time the synchronous reportSensorBreach() call returns.
    expect(sirenNode.setValue).toHaveBeenCalledTimes(1);
    expect(sirenNode.setValue).toHaveBeenCalledWith(
      { commandClass: CommandClasses['Binary Switch'], property: 'targetValue' },
      true,
    );
  });

  it('turns the siren back off once the panel is disarmed', async () => {
    const { panelService, sirenNode, lifeSafetySensor } = buildHarness(5);

    panelService.reportSensorBreach(lifeSafetySensor);
    expect(sirenNode.setValue).toHaveBeenCalledTimes(1);

    await panelService.disarm({ source: 'native' });

    expect(sirenNode.setValue).toHaveBeenCalledTimes(2);
    expect(sirenNode.setValue).toHaveBeenNthCalledWith(
      2,
      { commandClass: CommandClasses['Binary Switch'], property: 'targetValue' },
      false,
    );
  });

  it('does not resend a command for unrelated panel changes while already triggered', () => {
    const { panelService, sirenNode, lifeSafetySensor } = buildHarness(5);

    panelService.reportSensorBreach(lifeSafetySensor);
    expect(sirenNode.setValue).toHaveBeenCalledTimes(1);

    // A second life-safety trigger while already alarm_triggered is still a 'panel_changed' emission
    // (triggerAlarm() always commits), but the siren's own active flag should suppress a resend.
    panelService.reportSensorBreach(lifeSafetySensor);
    expect(sirenNode.setValue).toHaveBeenCalledTimes(1);
  });

  it('logs and skips silently when no siren node is configured', () => {
    const { panelService, lifeSafetySensor } = buildHarness(null);

    expect(() => panelService.reportSensorBreach(lifeSafetySensor)).not.toThrow();
    expect(panelService.getState().mode).toBe('alarm_triggered');
  });

  it('logs and skips when the configured node id is not present on the network', () => {
    const { panelService, lifeSafetySensor } = buildHarness(99);
    // Node 99 was never added to the mock driver's node map.

    expect(() => panelService.reportSensorBreach(lifeSafetySensor)).not.toThrow();
    expect(panelService.getState().mode).toBe('alarm_triggered');
  });
});
