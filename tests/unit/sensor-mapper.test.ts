import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
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

function buildMapper(options?: { lowBatteryThresholdPercent?: number }) {
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

describe('SensorMapper', () => {
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
