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
import { AlarmEventRepository } from '../../src/alarm/alarm-event-repository.js';
import { AlarmEventService } from '../../src/alarm/alarm-event-service.js';
import { SirenRepository } from '../../src/alarm/siren-repository.js';

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

  it('logs a startup warning when constructed with no siren node configured', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    buildHarness(null);

    const warnEntry = logSpy.mock.calls
      .map((call) => JSON.parse(call[0] as string) as Record<string, unknown>)
      .find((entry) => entry.level === 'warn');
    expect(warnEntry).toMatchObject({
      module: 'alarm/siren',
      message: expect.stringContaining('no siren enrolled'),
    });

    logSpy.mockRestore();
  });

  it('does not log a startup warning when a siren node is configured', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    buildHarness(5);

    const warnEntry = logSpy.mock.calls
      .map((call) => JSON.parse(call[0] as string) as Record<string, unknown>)
      .find((entry) => entry.level === 'warn');
    expect(warnEntry).toBeUndefined();

    logSpy.mockRestore();
  });
});

describe('Siren following alarm events', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function build() {
    const db = createDatabase(':memory:');
    const alarmEvents = new AlarmEventService(new AlarmEventRepository(db));
    const panelService = new PanelService(new AlarmPanelRepository(db), new EventRepository(db), { alarmEvents });
    const driver = new MockDriver();
    const sirenNode = new MockNode();
    driver.controller.nodes.add(5, sirenNode);
    new Siren(driver as unknown as Driver, panelService, { nodeId: 5, alarmEvents });
    return { panelService, alarmEvents, sirenNode };
  }

  const target = { commandClass: CommandClasses['Binary Switch'], property: 'targetValue' };

  it('turns the siren off when it is silenced, and the event stays open', () => {
    const { panelService, alarmEvents, sirenNode } = build();
    panelService.raiseEmergency('PANIC');
    expect(sirenNode.setValue).toHaveBeenLastCalledWith(target, true);

    panelService.silence();

    expect(sirenNode.setValue).toHaveBeenLastCalledWith(target, false);
    expect(alarmEvents.listActive()).toHaveLength(1);
  });

  it('stops by itself after 600 s and marks the event timed out, but keeps it open', async () => {
    const { panelService, alarmEvents, sirenNode } = build();
    panelService.raiseEmergency('PANIC');

    await vi.advanceTimersByTimeAsync(599_000);
    expect(sirenNode.setValue).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(sirenNode.setValue).toHaveBeenLastCalledWith(target, false);
    expect(alarmEvents.listActive()[0]).toMatchObject({ sirenState: 'timed_out', endedAt: null });
  });

  it('does not sound for a medical emergency', () => {
    const { panelService, sirenNode } = build();

    panelService.raiseEmergency('MEDICAL');

    expect(sirenNode.setValue).not.toHaveBeenCalled();
  });
});

describe('Siren with enrolled sirens', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function build() {
    const db = createDatabase(':memory:');
    const alarmEvents = new AlarmEventService(new AlarmEventRepository(db));
    const sirenRepo = new SirenRepository(db);
    const panelService = new PanelService(new AlarmPanelRepository(db), new EventRepository(db), { alarmEvents });
    const driver = new MockDriver();
    const nodes = { 5: new MockNode(), 6: new MockNode() };
    driver.controller.nodes.add(5, nodes[5]);
    driver.controller.nodes.add(6, nodes[6]);
    sirenRepo.upsert({ nodeId: 5, kind: 'BASE' });
    sirenRepo.upsert({ nodeId: 6, kind: 'OUTDOOR', durationSec: 60 });
    new Siren(driver as unknown as Driver, panelService, { nodeId: null, sirenRepo, alarmEvents });
    return { panelService, alarmEvents, sirenRepo, nodes };
  }

  const target = { commandClass: CommandClasses['Binary Switch'], property: 'targetValue' };

  it('sounds every enrolled siren, and the outdoor one stops after its own duration while the base keeps going', async () => {
    const { panelService, alarmEvents, nodes } = build();

    panelService.raiseEmergency('PANIC');
    expect(nodes[5].setValue).toHaveBeenLastCalledWith(target, true);
    expect(nodes[6].setValue).toHaveBeenLastCalledWith(target, true);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(nodes[6].setValue).toHaveBeenLastCalledWith(target, false);
    expect(nodes[5].setValue).toHaveBeenCalledTimes(1);
    expect(alarmEvents.listActive()[0]?.sirenState).toBe('sounding');

    await vi.advanceTimersByTimeAsync(540_000);
    expect(nodes[5].setValue).toHaveBeenLastCalledWith(target, false);
    expect(alarmEvents.listActive()[0]?.sirenState).toBe('timed_out');
    expect(nodes[6].setValue).toHaveBeenCalledTimes(2); // not switched off a second time
  });

  it('switches a siren off when it is un-enrolled mid-alarm, and sounds one enrolled mid-alarm', () => {
    const { panelService, sirenRepo, nodes } = build();
    panelService.raiseEmergency('PANIC');

    sirenRepo.delete(6);
    expect(nodes[6].setValue).toHaveBeenLastCalledWith(target, false);

    sirenRepo.upsert({ nodeId: 6, kind: 'DOME' });
    expect(nodes[6].setValue).toHaveBeenLastCalledWith(target, true);
  });
});
