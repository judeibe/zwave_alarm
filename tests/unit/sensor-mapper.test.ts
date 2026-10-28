import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { CommandClasses } from '@zwave-js/core';
import type { Driver } from 'zwave-js';
import { createDatabase } from '../../src/db/schema.js';
import { AlarmPanelRepository } from '../../src/alarm/panel-repository.js';
import { EventRepository } from '../../src/events/event-repository.js';
import { ZoneRepository } from '../../src/db/repositories/zone-repository.js';
import { SensorRepository } from '../../src/db/repositories/sensor-repository.js';
import { PanelService } from '../../src/alarm/panel-service.js';
import { SensorMapper } from '../../src/zwave/sensor-mapper.js';

class MockNode extends EventEmitter {
  constructor(public readonly id: number) {
    super();
  }
}

class MockNodeMap {
  private readonly byId = new Map<number, MockNode>();

  add(node: MockNode): void {
    this.byId.set(node.id, node);
  }

  forEach(callback: (node: MockNode) => void): void {
    this.byId.forEach(callback);
  }
}

class MockController extends EventEmitter {
  nodes = new MockNodeMap();
}

class MockDriver {
  controller = new MockController();
}

function buildMapper(options?: { lowBatteryThresholdPercent?: number; quickExitOnHeartbeat?: boolean }) {
  const db = createDatabase(':memory:');
  const panelRepo = new AlarmPanelRepository(db);
  const eventRepo = new EventRepository(db);
  const zoneRepo = new ZoneRepository(db);
  const sensorRepo = new SensorRepository(db);
  const panelService = new PanelService(panelRepo, eventRepo, { exitDelayMs: 1, entryDelayMs: 100_000 });

  const zone = zoneRepo.create('Front Door');
  const intrusionSensor = sensorRepo.create({
    zwaveNodeId: 10,
    zoneId: zone.id,
    name: 'Door contact',
    category: 'intrusion',
  });
  const lifeSafetySensor = sensorRepo.create({
    zwaveNodeId: 20,
    zoneId: zone.id,
    name: 'Smoke detector',
    category: 'life-safety',
  });

  const driver = new MockDriver();
  const mapper = new SensorMapper(
    driver as unknown as Driver,
    sensorRepo,
    panelService,
    eventRepo,
    options,
  );

  return { driver, mapper, sensorRepo, eventRepo, panelService, zone, intrusionSensor, lifeSafetySensor };
}

function attachAndStart(driver: MockDriver, mapper: SensorMapper, nodeIds: number[]): Map<number, MockNode> {
  const nodes = new Map<number, MockNode>();
  for (const id of nodeIds) {
    const node = new MockNode(id);
    driver.controller.nodes.add(node);
    nodes.set(id, node);
  }
  mapper.start();
  return nodes;
}

const HEARTBEAT = { type: 9, label: 'System', event: 5, eventLabel: 'Heartbeat' };

describe('SensorMapper System/Heartbeat (the sensor button)', () => {
  async function armedHome(options: { quickExitOnHeartbeat: boolean }, quickExit = true) {
    const built = buildMapper(options);
    built.sensorRepo.updateConfig(built.intrusionSensor.id, { quickExitEnabled: quickExit });
    built.sensorRepo.updateConfig(built.lifeSafetySensor.id, {});
    const nodes = attachAndStart(built.driver, built.mapper, [10, 20]);
    await built.panelService.arm('armed_home', { source: 'native' });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(built.panelService.getState().mode).toBe('armed_home');
    return { ...built, nodes };
  }
  const press = (nodes: Map<number, MockNode>, id = 10) => nodes.get(id)!.emit('notification', {}, CommandClasses.Notification, HEARTBEAT);
  const breach = (sensorId: string, panelService: PanelService, sensorRepo: SensorRepository) =>
    panelService.reportSensorBreach(sensorRepo.findById(sensorId)!).mode;

  it('is never a breach, even with the trigger off', async () => {
    const { nodes, sensorRepo, panelService } = await armedHome({ quickExitOnHeartbeat: false });
    press(nodes);

    expect(sensorRepo.findByNodeId(10)?.currentState).toBe('normal');
    expect(panelService.getState().mode).toBe('armed_home');
    expect(breach(sensorRepo.findByNodeId(10)!.id, panelService, sensorRepo)).toBe('alarm_pending'); // no window opened
  });

  it('opens the quick-exit window on an enabled sensor when the trigger is on', async () => {
    const { nodes, sensorRepo, panelService } = await armedHome({ quickExitOnHeartbeat: true });
    press(nodes);

    expect(breach(sensorRepo.findByNodeId(10)!.id, panelService, sensorRepo)).toBe('armed_home');
  });

  it('ignores a sensor with quick exit disabled', async () => {
    const { nodes, sensorRepo, panelService } = await armedHome({ quickExitOnHeartbeat: true }, false);
    press(nodes);

    expect(breach(sensorRepo.findByNodeId(10)!.id, panelService, sensorRepo)).toBe('alarm_pending');
  });

  it('ignores a life-safety sensor', async () => {
    const { nodes, sensorRepo, panelService, lifeSafetySensor } = await armedHome({ quickExitOnHeartbeat: true });
    press(nodes, 20);

    expect(sensorRepo.findById(lifeSafetySensor.id)?.currentState).toBe('normal');
    expect(breach(lifeSafetySensor.id, panelService, sensorRepo)).toBe('alarm_triggered');
  });

  it('restarts the window on a repeated press, and ends it 5000 ms after the last one', async () => {
    const { nodes, sensorRepo, panelService } = await armedHome({ quickExitOnHeartbeat: true });
    vi.useFakeTimers();
    try {
      const id = sensorRepo.findByNodeId(10)!.id;
      press(nodes);
      await vi.advanceTimersByTimeAsync(3000);
      press(nodes);
      await vi.advanceTimersByTimeAsync(4999); // 7999 ms after the first press, 4999 after the second
      expect(breach(id, panelService, sensorRepo)).toBe('armed_home');
      await vi.advanceTimersByTimeAsync(1); // exactly 5000 ms after the second
      expect(breach(id, panelService, sensorRepo)).toBe('alarm_pending');
    } finally {
      vi.useRealTimers();
    }
  });

  it('does nothing unless the panel is armed Home', async () => {
    const built = buildMapper({ quickExitOnHeartbeat: true });
    built.sensorRepo.updateConfig(built.intrusionSensor.id, { quickExitEnabled: true });
    const nodes = attachAndStart(built.driver, built.mapper, [10]);
    press(nodes); // disarmed
    await built.panelService.arm('armed_away', { source: 'native' });
    await new Promise((resolve) => setTimeout(resolve, 5));
    press(nodes); // armed away

    expect(breach(built.intrusionSensor.id, built.panelService, built.sensorRepo)).toBe('alarm_pending');
  });

  it('ends the window when the door closes', async () => {
    const { nodes, sensorRepo, panelService } = await armedHome({ quickExitOnHeartbeat: true });
    const id = sensorRepo.findByNodeId(10)!.id;
    const send = (event: number) => nodes.get(10)!.emit('notification', {}, CommandClasses.Notification, { type: 7, label: 'Home Security', event });
    press(nodes);
    send(2); // door opened inside the window: no alarm
    expect(panelService.getState().mode).toBe('armed_home');
    send(0); // door closed: armed again
    send(2);

    expect(panelService.getState().mode).toBe('alarm_pending');
    expect(id).toBe(sensorRepo.findByNodeId(10)!.id);
  });
});

describe('SensorMapper', () => {
  it('re-attaches to the new node objects when started again after the driver was restarted', async () => {
    const { driver, mapper, sensorRepo, panelService, intrusionSensor } = buildMapper();
    attachAndStart(driver, mapper, [intrusionSensor.zwaveNodeId]);

    // A restarted driver has a new controller with new node objects for the same node ids.
    driver.controller = new MockController();
    const restarted = attachAndStart(driver, mapper, [intrusionSensor.zwaveNodeId]);

    await panelService.arm('armed_away', { source: 'native' });
    await new Promise((resolve) => setTimeout(resolve, 5));
    restarted.get(10)!.emit('notification', {}, CommandClasses.Notification, {
      type: 6,
      label: 'Access Control',
      event: 22,
      eventLabel: 'Door/window open',
    });

    expect(sensorRepo.findByNodeId(10)?.currentState).toBe('breached');
  });

  describe('Notification CC (intrusion)', () => {
    it('marks the sensor breached and reports the breach to the panel service on the normal->breached edge', async () => {
      const { driver, mapper, sensorRepo, panelService, intrusionSensor } = buildMapper();
      const nodes = attachAndStart(driver, mapper, [intrusionSensor.zwaveNodeId]);

      await panelService.arm('armed_away', { source: 'native' });
      await new Promise((resolve) => setTimeout(resolve, 5));
      expect(panelService.getState().mode).toBe('armed_away');

      nodes.get(10)!.emit('notification', {}, CommandClasses.Notification, {
        type: 6,
        label: 'Access Control',
        event: 22,
        eventLabel: 'Door/window open',
      });

      expect(sensorRepo.findByNodeId(10)?.currentState).toBe('breached');
      expect(panelService.getState().mode).toBe('alarm_pending');
    });

    it('does not re-report an already-breached sensor (edge-triggered, per "changes state")', async () => {
      const { driver, mapper, sensorRepo, eventRepo, panelService, intrusionSensor } = buildMapper();
      const nodes = attachAndStart(driver, mapper, [intrusionSensor.zwaveNodeId]);

      await panelService.arm('armed_away', { source: 'native' });
      await new Promise((resolve) => setTimeout(resolve, 5));

      const emitBreach = () =>
        nodes.get(10)!.emit('notification', {}, CommandClasses.Notification, {
          type: 6,
          label: 'Access Control',
          event: 22,
          eventLabel: 'Door/window open',
        });

      emitBreach();
      emitBreach();
      emitBreach();

      expect(sensorRepo.findByNodeId(10)?.currentState).toBe('breached');
      expect(eventRepo.list().filter((e) => e.type === 'breach')).toHaveLength(1);
    });

    it('clears back to normal on an idle (event 0) notification without calling the panel service', async () => {
      const { driver, mapper, sensorRepo, intrusionSensor } = buildMapper();
      const nodes = attachAndStart(driver, mapper, [intrusionSensor.zwaveNodeId]);

      nodes.get(10)!.emit('notification', {}, CommandClasses.Notification, {
        type: 6,
        label: 'Access Control',
        event: 22,
        eventLabel: 'Door/window open',
      });
      expect(sensorRepo.findByNodeId(10)?.currentState).toBe('breached');

      nodes.get(10)!.emit('notification', {}, CommandClasses.Notification, {
        type: 6,
        label: 'Access Control',
        event: 0,
        eventLabel: 'State idle',
      });
      expect(sensorRepo.findByNodeId(10)?.currentState).toBe('normal');
    });

    it('ignores notifications from a node with no matching sensor', () => {
      const { driver, mapper } = buildMapper();
      const nodes = attachAndStart(driver, mapper, [10, 999]);

      expect(() =>
        nodes.get(999)!.emit('notification', {}, CommandClasses.Notification, {
          type: 6,
          label: 'Access Control',
          event: 22,
          eventLabel: 'Door/window open',
        }),
      ).not.toThrow();
    });
  });

  describe('life-safety bypass (FR-015)', () => {
    it('triggers the alarm immediately from a life-safety sensor notification, even while disarmed', () => {
      const { driver, mapper, panelService, lifeSafetySensor } = buildMapper();
      const nodes = attachAndStart(driver, mapper, [lifeSafetySensor.zwaveNodeId]);

      nodes.get(20)!.emit('notification', {}, CommandClasses.Notification, {
        type: 1,
        label: 'Smoke Alarm',
        event: 2,
        eventLabel: 'Smoke detected',
      });

      expect(panelService.getState().mode).toBe('alarm_triggered');
    });
  });

  describe('Binary Sensor CC', () => {
    it('marks breached on newValue true, and normal on newValue false', () => {
      const { driver, mapper, sensorRepo, intrusionSensor } = buildMapper();
      const nodes = attachAndStart(driver, mapper, [intrusionSensor.zwaveNodeId]);

      nodes.get(10)!.emit('value updated', { id: 10 }, {
        commandClass: CommandClasses['Binary Sensor'],
        commandClassName: 'Binary Sensor',
        property: 'Any',
        newValue: true,
        prevValue: false,
      });
      expect(sensorRepo.findByNodeId(10)?.currentState).toBe('breached');

      nodes.get(10)!.emit('value updated', { id: 10 }, {
        commandClass: CommandClasses['Binary Sensor'],
        commandClassName: 'Binary Sensor',
        property: 'Any',
        newValue: false,
        prevValue: true,
      });
      expect(sensorRepo.findByNodeId(10)?.currentState).toBe('normal');
    });
  });

  describe('Notification CC state values (zwave-js stores these instead of emitting "notification")', () => {
    const emitValue = (nodes: Map<number, MockNode>, property: string, propertyKey: string, newValue: unknown) =>
      nodes.get(10)!.emit('value updated', { id: 10 }, {
        commandClass: CommandClasses.Notification,
        commandClassName: 'Notification',
        property,
        propertyKey,
        newValue,
        prevValue: 0,
      });

    it('marks breached on a Home Security intrusion state and normal on idle (0)', () => {
      const { driver, mapper, sensorRepo, intrusionSensor } = buildMapper();
      const nodes = attachAndStart(driver, mapper, [intrusionSensor.zwaveNodeId]);

      emitValue(nodes, 'Home Security', 'Motion sensor status', 8);
      expect(sensorRepo.findByNodeId(10)?.currentState).toBe('breached');

      emitValue(nodes, 'Home Security', 'Motion sensor status', 0);
      expect(sensorRepo.findByNodeId(10)?.currentState).toBe('normal');
    });

    it('treats Access Control door open (22) as breached and closed (23) as normal', () => {
      const { driver, mapper, sensorRepo, intrusionSensor } = buildMapper();
      const nodes = attachAndStart(driver, mapper, [intrusionSensor.zwaveNodeId]);

      emitValue(nodes, 'Access Control', 'Door state', 22);
      expect(sensorRepo.findByNodeId(10)?.currentState).toBe('breached');

      emitValue(nodes, 'Access Control', 'Door state', 23);
      expect(sensorRepo.findByNodeId(10)?.currentState).toBe('normal');
    });

    it('ignores Access Control lock states and non-security notification types', () => {
      const { driver, mapper, sensorRepo, intrusionSensor } = buildMapper();
      const nodes = attachAndStart(driver, mapper, [intrusionSensor.zwaveNodeId]);

      emitValue(nodes, 'Access Control', 'Lock state', 1);
      emitValue(nodes, 'Power Management', 'Mains status', 2);
      expect(sensorRepo.findByNodeId(10)?.currentState).toBe('normal');
    });
  });

  describe('Battery CC fault detection (FR-012)', () => {
    it('records a device_fault on the ok->low edge but not on repeated low readings', () => {
      const { driver, mapper, sensorRepo, eventRepo, intrusionSensor } = buildMapper({ lowBatteryThresholdPercent: 20 });
      const nodes = attachAndStart(driver, mapper, [intrusionSensor.zwaveNodeId]);

      nodes.get(10)!.emit('value updated', { id: 10 }, {
        commandClass: CommandClasses.Battery,
        commandClassName: 'Battery',
        property: 'level',
        newValue: 80,
        prevValue: null,
      });
      expect(sensorRepo.findByNodeId(10)?.batteryLevel).toBe(80);
      expect(eventRepo.list().filter((e) => e.type === 'device_fault')).toHaveLength(0);

      nodes.get(10)!.emit('value updated', { id: 10 }, {
        commandClass: CommandClasses.Battery,
        commandClassName: 'Battery',
        property: 'level',
        newValue: 15,
        prevValue: 80,
      });
      expect(sensorRepo.findByNodeId(10)?.batteryLevel).toBe(15);
      expect(eventRepo.list().filter((e) => e.type === 'device_fault')).toHaveLength(1);

      nodes.get(10)!.emit('value updated', { id: 10 }, {
        commandClass: CommandClasses.Battery,
        commandClassName: 'Battery',
        property: 'level',
        newValue: 10,
        prevValue: 15,
      });
      expect(sensorRepo.findByNodeId(10)?.batteryLevel).toBe(10);
      expect(eventRepo.list().filter((e) => e.type === 'device_fault')).toHaveLength(1);
    });

    it('treats the "low" sentinel string as a low-battery fault clamped to the threshold', () => {
      const { driver, mapper, sensorRepo, eventRepo, intrusionSensor } = buildMapper({ lowBatteryThresholdPercent: 20 });
      const nodes = attachAndStart(driver, mapper, [intrusionSensor.zwaveNodeId]);

      nodes.get(10)!.emit('value updated', { id: 10 }, {
        commandClass: CommandClasses.Battery,
        commandClassName: 'Battery',
        property: 'level',
        newValue: 'low',
        prevValue: 90,
      });

      expect(sensorRepo.findByNodeId(10)?.batteryLevel).toBe(20);
      expect(eventRepo.list().filter((e) => e.type === 'device_fault')).toHaveLength(1);
    });

    it('treats a Battery CC "battery low" notification as an immediate low-battery fault', () => {
      const { driver, mapper, sensorRepo, eventRepo, intrusionSensor } = buildMapper({ lowBatteryThresholdPercent: 20 });
      const nodes = attachAndStart(driver, mapper, [intrusionSensor.zwaveNodeId]);

      nodes.get(10)!.emit('notification', {}, CommandClasses.Battery, {
        eventType: 'battery low',
        urgency: 0,
      });

      expect(sensorRepo.findByNodeId(10)?.batteryLevel).toBe(20);
      expect(eventRepo.list().filter((e) => e.type === 'device_fault')).toHaveLength(1);
    });
  });

  describe('connectivity fault detection (FR-012)', () => {
    it('marks the sensor offline and records a device_fault on "dead", then clears silently on "alive"', () => {
      const { driver, mapper, sensorRepo, eventRepo, intrusionSensor } = buildMapper();
      const nodes = attachAndStart(driver, mapper, [intrusionSensor.zwaveNodeId]);

      nodes.get(10)!.emit('dead', nodes.get(10), 'Awake');
      expect(sensorRepo.findByNodeId(10)?.connectivityStatus).toBe('offline');
      expect(eventRepo.list().filter((e) => e.type === 'device_fault')).toHaveLength(1);

      nodes.get(10)!.emit('alive', nodes.get(10), 'Dead');
      expect(sensorRepo.findByNodeId(10)?.connectivityStatus).toBe('online');
      expect(eventRepo.list().filter((e) => e.type === 'device_fault')).toHaveLength(1);
    });
  });

  describe('start()', () => {
    it('attaches to nodes included after start() via the controller "node added" event', () => {
      const { driver, mapper, sensorRepo, lifeSafetySensor } = buildMapper();
      mapper.start();

      const node = new MockNode(lifeSafetySensor.zwaveNodeId);
      driver.controller.nodes.add(node);
      driver.controller.emit('node added', node);

      node.emit('notification', {}, CommandClasses.Notification, {
        type: 1,
        label: 'Smoke Alarm',
        event: 2,
        eventLabel: 'Smoke detected',
      });

      expect(sensorRepo.findByNodeId(20)?.currentState).toBe('breached');
    });
  });
});

describe('SensorMapper debug log', () => {
  function collectLog(run: () => void): string {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const previous = process.env.LOG_LEVEL;
    process.env.LOG_LEVEL = 'debug';
    try {
      run();
      return spy.mock.calls.map((call) => String(call[0])).join('\n');
    } finally {
      spy.mockRestore();
      if (previous === undefined) delete process.env.LOG_LEVEL;
      else process.env.LOG_LEVEL = previous;
    }
  }

  it('never writes an access code to the log: lock user codes and digits typed on a keypad', () => {
    const { driver, mapper, intrusionSensor } = buildMapper();
    const nodes = attachAndStart(driver, mapper, [intrusionSensor.zwaveNodeId]);
    const node = nodes.get(10)!;

    const output = collectLog(() => {
      node.emit('value updated', { id: 10 }, {
        commandClass: CommandClasses['User Code'],
        commandClassName: 'User Code',
        property: 'userCode',
        propertyKey: 1,
        prevValue: '4821',
        newValue: '9317',
      });
      node.emit('notification', {}, CommandClasses['Entry Control'], { eventType: 3, dataType: 2, eventData: '7305' });
    });

    expect(output).not.toMatch(/4821|9317|7305/);
    expect(output).toContain('[redacted]');
    expect(output).toContain('node value updated');
    expect(output).toContain('node notification');
  });

  it('still logs other values and notifications in full', () => {
    const { driver, mapper, intrusionSensor } = buildMapper();
    const nodes = attachAndStart(driver, mapper, [intrusionSensor.zwaveNodeId]);

    const output = collectLog(() => {
      nodes.get(10)!.emit('value updated', { id: 10 }, {
        commandClass: CommandClasses.Battery,
        commandClassName: 'Battery',
        property: 'level',
        prevValue: 91,
        newValue: 87,
      });
    });

    expect(output).toContain('"newValue":87');
    expect(output).toContain('"prevValue":91');
  });
});
