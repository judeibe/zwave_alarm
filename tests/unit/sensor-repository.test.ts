import { describe, expect, it } from 'vitest';
import { createDatabase } from '../../src/db/schema.js';
import { ZoneRepository } from '../../src/db/repositories/zone-repository.js';
import { SensorRepository } from '../../src/db/repositories/sensor-repository.js';

describe('SensorRepository', () => {
  it('creates a sensor with defaults: normal state, online, no battery reading', () => {
    const db = createDatabase(':memory:');
    const zone = new ZoneRepository(db).create('Front Door');
    const repo = new SensorRepository(db);

    const sensor = repo.create({ zwaveNodeId: 5, zoneId: zone.id, name: 'Door Sensor', category: 'intrusion' });

    expect(sensor.id).toBeTruthy();
    expect(sensor.zwaveNodeId).toBe(5);
    expect(sensor.zoneId).toBe(zone.id);
    expect(sensor.category).toBe('intrusion');
    expect(sensor.currentState).toBe('normal');
    expect(sensor.batteryLevel).toBeNull();
    expect(sensor.connectivityStatus).toBe('online');
    expect(typeof sensor.updatedAt).toBe('number');
  });

  it('rejects assigning a zwaveNodeId that is already assigned to a zone', () => {
    const db = createDatabase(':memory:');
    const zones = new ZoneRepository(db);
    const zoneA = zones.create('Front Door');
    const zoneB = zones.create('Garage');
    const repo = new SensorRepository(db);
    repo.create({ zwaveNodeId: 5, zoneId: zoneA.id, name: 'Door Sensor', category: 'intrusion' });

    expect(() =>
      repo.create({ zwaveNodeId: 5, zoneId: zoneB.id, name: 'Duplicate Sensor', category: 'intrusion' }),
    ).toThrow(/already assigned/);
  });

  it('rejects a sensor assigned to a zone that does not exist via the foreign key', () => {
    const db = createDatabase(':memory:');
    const repo = new SensorRepository(db);

    expect(() =>
      repo.create({ zwaveNodeId: 5, zoneId: 'missing-zone', name: 'Door Sensor', category: 'intrusion' }),
    ).toThrow(/FOREIGN KEY constraint failed/);
  });

  it('merges a partial state update and stamps updatedAt without touching other fields', () => {
    const db = createDatabase(':memory:');
    const zone = new ZoneRepository(db).create('Front Door');
    const repo = new SensorRepository(db);
    const sensor = repo.create({ zwaveNodeId: 5, zoneId: zone.id, name: 'Door Sensor', category: 'intrusion' });

    const updated = repo.updateState(sensor.id, { currentState: 'breached' });

    expect(updated.currentState).toBe('breached');
    expect(updated.connectivityStatus).toBe('online');
    expect(updated.batteryLevel).toBeNull();
    expect(updated.updatedAt).toBeGreaterThanOrEqual(sensor.updatedAt);
  });

  it('reports connectivity/battery faults independently of breach state (FR-012)', () => {
    const db = createDatabase(':memory:');
    const zone = new ZoneRepository(db).create('Front Door');
    const repo = new SensorRepository(db);
    const sensor = repo.create({ zwaveNodeId: 5, zoneId: zone.id, name: 'Door Sensor', category: 'intrusion' });

    const faulted = repo.updateState(sensor.id, {
      currentState: 'breached',
      connectivityStatus: 'offline',
      batteryLevel: 5,
    });

    expect(faulted.currentState).toBe('breached');
    expect(faulted.connectivityStatus).toBe('offline');
    expect(faulted.batteryLevel).toBe(5);
  });

  it('throws when updating a sensor that does not exist', () => {
    const repo = new SensorRepository(createDatabase(':memory:'));

    expect(() => repo.updateState('missing-sensor', { currentState: 'breached' })).toThrow(/not found/);
  });

  it('listByZone returns only sensors assigned to that zone', () => {
    const db = createDatabase(':memory:');
    const zones = new ZoneRepository(db);
    const zoneA = zones.create('Front Door');
    const zoneB = zones.create('Garage');
    const repo = new SensorRepository(db);
    const sensorA = repo.create({ zwaveNodeId: 5, zoneId: zoneA.id, name: 'Door Sensor', category: 'intrusion' });
    repo.create({ zwaveNodeId: 6, zoneId: zoneB.id, name: 'Garage Sensor', category: 'intrusion' });

    const result = repo.listByZone(zoneA.id);

    expect(result.map((s) => s.id)).toEqual([sensorA.id]);
  });

  it('list returns all sensors across all zones', () => {
    const db = createDatabase(':memory:');
    const zones = new ZoneRepository(db);
    const zoneA = zones.create('Front Door');
    const zoneB = zones.create('Garage');
    const repo = new SensorRepository(db);
    const sensorA = repo.create({ zwaveNodeId: 5, zoneId: zoneA.id, name: 'Door Sensor', category: 'intrusion' });
    const sensorB = repo.create({
      zwaveNodeId: 6,
      zoneId: zoneB.id,
      name: 'Smoke Detector',
      category: 'life-safety',
    });

    const result = repo.list();

    expect(result.map((s) => s.id).sort()).toEqual([sensorA.id, sensorB.id].sort());
  });
});
