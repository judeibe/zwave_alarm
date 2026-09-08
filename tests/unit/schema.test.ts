import { describe, expect, it } from 'vitest';
import { createDatabase, runMigrations } from '../../src/db/schema.js';

const ALL_TABLES = [
  'zones',
  'users',
  'sensor_devices',
  'security_events',
  'alarm_panel',
  'lockout_policy',
  'ha_links',
];

describe('db schema', () => {
  it('creates every table from data-model.md', () => {
    const db = createDatabase(':memory:');
    const tableNames = (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]
    ).map((row) => row.name);

    for (const table of ALL_TABLES) {
      expect(tableNames).toContain(table);
    }
  });

  it('records the applied migration and is idempotent on re-run', () => {
    const db = createDatabase(':memory:');
    const applied = db.prepare('SELECT id FROM schema_migrations').all();
    expect(applied).toEqual([{ id: '001_init' }]);

    // Running again must not error (CREATE TABLE would fail if re-applied) or duplicate rows.
    expect(() => runMigrations(db)).not.toThrow();
    expect(db.prepare('SELECT id FROM schema_migrations').all()).toEqual([{ id: '001_init' }]);
  });

  it('enforces foreign keys between zones and sensor_devices', () => {
    const db = createDatabase(':memory:');
    expect(() =>
      db
        .prepare(
          `INSERT INTO sensor_devices
             (id, zwave_node_id, zone_id, name, category, current_state, connectivity_status, updated_at)
           VALUES ('sensor-1', 1, 'missing-zone', 'Front Door', 'intrusion', 'normal', 'online', 0)`,
        )
        .run(),
    ).toThrow(/FOREIGN KEY constraint failed/);
  });

  it('rejects a sensor_devices.category value outside the documented enum', () => {
    const db = createDatabase(':memory:');
    db.prepare("INSERT INTO zones (id, name, created_at) VALUES ('zone-1', 'Garage', 0)").run();

    expect(() =>
      db
        .prepare(
          `INSERT INTO sensor_devices
             (id, zwave_node_id, zone_id, name, category, current_state, connectivity_status, updated_at)
           VALUES ('sensor-1', 1, 'zone-1', 'Garage Door', 'not-a-real-category', 'normal', 'online', 0)`,
        )
        .run(),
    ).toThrow(/CHECK constraint failed/);
  });

  it('only allows the fixed singleton id on alarm_panel and lockout_policy', () => {
    const db = createDatabase(':memory:');

    expect(() =>
      db
        .prepare("INSERT INTO alarm_panel (id, mode, updated_at) VALUES ('not-panel', 'disarmed', 0)")
        .run(),
    ).toThrow(/CHECK constraint failed/);

    expect(() =>
      db.prepare("INSERT INTO alarm_panel (id, mode, updated_at) VALUES ('panel', 'disarmed', 0)").run(),
    ).not.toThrow();

    expect(() =>
      db.prepare("INSERT INTO lockout_policy (id) VALUES ('not-policy')").run(),
    ).toThrow(/CHECK constraint failed/);
  });
});
