import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { CommandClasses } from '@zwave-js/core';
import type { Driver } from 'zwave-js';
import { createDatabase } from '../../src/db/schema.js';
import { AlarmPanelRepository } from '../../src/alarm/panel-repository.js';
import { AlarmEventRepository } from '../../src/alarm/alarm-event-repository.js';
import { AlarmEventService } from '../../src/alarm/alarm-event-service.js';
import { EventRepository } from '../../src/events/event-repository.js';
import { ZoneRepository } from '../../src/db/repositories/zone-repository.js';
import { SensorRepository } from '../../src/db/repositories/sensor-repository.js';
import { PanelService, NeedsBypassError } from '../../src/alarm/panel-service.js';
import { SensorMapper } from '../../src/zwave/sensor-mapper.js';

class MockNode extends EventEmitter {
  constructor(public readonly id: number) {
    super();
  }
}

function build() {
  const db = createDatabase(':memory:');
  const eventRepo = new EventRepository(db);
  const sensorRepo = new SensorRepository(db);
  const alarmEvents = new AlarmEventService(new AlarmEventRepository(db));
  const panelService = new PanelService(new AlarmPanelRepository(db), eventRepo, {
    exitDelayMs: 1,
    entryDelayMs: 100_000,
    sensorRepo,
    alarmEvents,
  });
  const zone = new ZoneRepository(db).create('House');
  const sensor = sensorRepo.create({ zwaveNodeId: 10, zoneId: zone.id, name: 'Back door', category: 'intrusion', placement: 'WINDOW' });
  const node = new MockNode(10);
  const driver = { controller: Object.assign(new EventEmitter(), { nodes: { forEach: (cb: (n: MockNode) => void) => cb(node) } }) };
  const mapper = new SensorMapper(driver as unknown as Driver, sensorRepo, panelService, eventRepo);
  mapper.start();
  const faults: unknown[] = [];
  mapper.on('sensor_fault', (changed) => faults.push(changed));

  const tamperNotification = (event: number) =>
    node.emit('notification', {}, CommandClasses.Notification, { type: 7, label: 'Home Security', event, eventLabel: 'x' });
  const coverValue = (newValue: number) =>
    node.emit('value updated', { id: 10 }, {
      commandClass: CommandClasses.Notification,
      commandClassName: 'Notification',
      property: 'Home Security',
      propertyKey: 'Cover status',
      newValue,
      prevValue: 0,
    });
  return { panelService, alarmEvents, sensorRepo, eventRepo, sensor, faults, tamperNotification, coverValue };
}

describe('tamper handling', () => {
  it('marks the sensor tampered (not breached), records a device_fault and emits sensor_fault; clears on idle', () => {
    const { sensorRepo, eventRepo, faults, tamperNotification, panelService } = build();

    tamperNotification(3);

    expect(sensorRepo.findByNodeId(10)).toMatchObject({ tampered: true, currentState: 'normal' });
    expect(eventRepo.list().some((event) => event.type === 'device_fault' && event.details === 'tamper')).toBe(true);
    expect(faults).toHaveLength(1);
    expect(panelService.getState().mode).toBe('disarmed');

    tamperNotification(0);
    expect(sensorRepo.findByNodeId(10)?.tampered).toBe(false);
  });

  it('reads the Cover status value as tamper as well, and clears when the cover is back', () => {
    const { sensorRepo, coverValue } = build();

    coverValue(3);
    expect(sensorRepo.findByNodeId(10)).toMatchObject({ tampered: true, currentState: 'normal' });

    coverValue(0);
    expect(sensorRepo.findByNodeId(10)?.tampered).toBe(false);
  });

  it('raises a BURGLARY at once while armed, ignoring the entry delay and the armed flags', async () => {
    const { panelService, alarmEvents, sensor, sensorRepo, tamperNotification } = build();
    sensorRepo.updateConfig(sensor.id, { armedAway: false });
    await panelService.arm('armed_away', { source: 'native' });
    await new Promise((resolve) => setTimeout(resolve, 5));

    tamperNotification(3);

    expect(panelService.getState().mode).toBe('alarm_triggered');
    expect(alarmEvents.listActive()[0]).toMatchObject({
      type: 'BURGLARY',
      triggerDeviceId: sensor.id,
      details: 'Tamper: Back door',
    });
  });

  it('does not alarm for a bypassed sensor', async () => {
    const { panelService, sensor, tamperNotification } = build();
    await panelService.arm('armed_away', { source: 'native', bypass: [sensor.id] });
    await new Promise((resolve) => setTimeout(resolve, 5));

    tamperNotification(3);

    expect(panelService.getState().mode).toBe('armed_away');
  });

  it('makes a tampered sensor a "tampered" fault that blocks arming until it is bypassed', async () => {
    const { panelService, sensor, tamperNotification } = build();
    tamperNotification(3);

    const error = await panelService.arm('armed_away', { source: 'native' }).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(NeedsBypassError);
    expect((error as NeedsBypassError).faulted).toEqual([
      { sensorId: sensor.id, name: 'Back door', zoneId: sensor.zoneId, reason: 'tampered' },
    ]);
  });
});
