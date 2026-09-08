import { describe, expect, it } from 'vitest';
import { createDatabase } from '../../src/db/schema.js';
import { ZoneRepository } from '../../src/db/repositories/zone-repository.js';

describe('ZoneRepository', () => {
  it('creates a zone with a generated id, the given name, and no sensors', () => {
    const repo = new ZoneRepository(createDatabase(':memory:'));

    const zone = repo.create('Front Door');

    expect(zone.id).toBeTruthy();
    expect(zone.name).toBe('Front Door');
    expect(typeof zone.createdAt).toBe('number');
    expect(zone.sensors).toEqual([]);
  });

  it('lists zones ordered by creation time with an empty sensors array when none are assigned', () => {
    const repo = new ZoneRepository(createDatabase(':memory:'));
    const first = repo.create('Front Door');
    const second = repo.create('Garage');

    const zones = repo.list();

    expect(zones.map((z) => z.id)).toEqual([first.id, second.id]);
    expect(zones[0].sensors).toEqual([]);
    expect(zones[1].sensors).toEqual([]);
  });

  it('joins sensor_devices rows onto their owning zone', () => {
    const db = createDatabase(':memory:');
    const repo = new ZoneRepository(db);
    const zone = repo.create('Front Door');
    db.prepare(
      `INSERT INTO sensor_devices
         (id, zwave_node_id, zone_id, name, category, current_state, battery_level, connectivity_status, updated_at)
       VALUES ('sensor-1', 5, ?, 'Door Sensor', 'intrusion', 'normal', 90, 'online', 0)`,
    ).run(zone.id);

    const zones = repo.list();

    expect(zones).toHaveLength(1);
    expect(zones[0].sensors).toEqual([
      {
        id: 'sensor-1',
        zwaveNodeId: 5,
        zoneId: zone.id,
        name: 'Door Sensor',
        category: 'intrusion',
        currentState: 'normal',
        batteryLevel: 90,
        connectivityStatus: 'online',
        updatedAt: 0,
      },
    ]);
  });

  it('deletes a zone by id', () => {
    const repo = new ZoneRepository(createDatabase(':memory:'));
    const zone = repo.create('Front Door');

    repo.delete(zone.id);

    expect(repo.list()).toEqual([]);
  });

  it('rejects deleting a zone that still has sensors assigned via the foreign key', () => {
    const db = createDatabase(':memory:');
    const repo = new ZoneRepository(db);
    const zone = repo.create('Front Door');
    db.prepare(
      `INSERT INTO sensor_devices
         (id, zwave_node_id, zone_id, name, category, current_state, battery_level, connectivity_status, updated_at)
       VALUES ('sensor-1', 5, ?, 'Door Sensor', 'intrusion', 'normal', NULL, 'online', 0)`,
    ).run(zone.id);

    expect(() => repo.delete(zone.id)).toThrow(/FOREIGN KEY constraint failed/);
  });
});
