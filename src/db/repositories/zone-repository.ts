import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { Repository } from '../repository.js';
import type { ConnectivityStatus, SensorCategory, SensorDevice, SensorState } from './sensor-repository.js';

export type { ConnectivityStatus, SensorCategory, SensorState };

/** A SensorDevice as joined onto its owning Zone (data-model.md's SensorDevice entity). */
export type ZoneSensor = SensorDevice;

export interface Zone {
  id: string;
  name: string;
  description: string | null;
  createdAt: number;
  sensors: ZoneSensor[];
}

interface ZoneSensorRow {
  id: string;
  name: string;
  description: string | null;
  created_at: number;
  sensor_id: string | null;
  sensor_zwave_node_id: number | null;
  sensor_zone_id: string | null;
  sensor_name: string | null;
  sensor_category: SensorCategory | null;
  sensor_current_state: SensorState | null;
  sensor_battery_level: number | null;
  sensor_connectivity_status: ConnectivityStatus | null;
  sensor_updated_at: number | null;
}

function toSensor(row: ZoneSensorRow): ZoneSensor {
  return {
    id: row.sensor_id as string,
    zwaveNodeId: row.sensor_zwave_node_id as number,
    zoneId: row.sensor_zone_id as string,
    name: row.sensor_name as string,
    category: row.sensor_category as SensorCategory,
    currentState: row.sensor_current_state as SensorState,
    batteryLevel: row.sensor_battery_level,
    connectivityStatus: row.sensor_connectivity_status as ConnectivityStatus,
    updatedAt: row.sensor_updated_at as number,
  };
}

/** Repository for the `zones` table (data-model.md's Zone entity) and its joined sensors. */
export class ZoneRepository extends Repository {
  constructor(db: Database.Database) {
    super(db);
  }

  create(name: string, description: string | null = null): Zone {
    const zone: Zone = { id: randomUUID(), name, description, createdAt: Date.now(), sensors: [] };
    this.run(
      'INSERT INTO zones (id, name, description, created_at) VALUES (?, ?, ?, ?)',
      zone.id,
      zone.name,
      zone.description,
      zone.createdAt,
    );
    return zone;
  }

  /** Looks up one zone with its sensors, or undefined. */
  findById(id: string): Zone | undefined {
    return this.list().find((zone) => zone.id === id);
  }

  /** Case-insensitive name lookup, used to keep zone names unique. */
  findByName(name: string): Zone | undefined {
    return this.list().find((zone) => zone.name.toLowerCase() === name.toLowerCase());
  }

  /** Applies `changes` to an existing zone; throws `zone <id> not found` when absent. */
  update(id: string, changes: { name?: string; description?: string | null }): Zone {
    const zone = this.findById(id);
    if (!zone) {
      throw new Error(`zone ${id} not found`);
    }
    const next = { ...zone, ...changes };
    this.run('UPDATE zones SET name = ?, description = ? WHERE id = ?', next.name, next.description, id);
    return next;
  }

  /** Lists all zones ordered by creation time, each with its sensor_devices joined in. */
  list(): Zone[] {
    const rows = this.all<ZoneSensorRow>(
      `SELECT
         z.id AS id, z.name AS name, z.description AS description, z.created_at AS created_at,
         s.id AS sensor_id, s.zwave_node_id AS sensor_zwave_node_id, s.zone_id AS sensor_zone_id,
         s.name AS sensor_name, s.category AS sensor_category, s.current_state AS sensor_current_state,
         s.battery_level AS sensor_battery_level, s.connectivity_status AS sensor_connectivity_status,
         s.updated_at AS sensor_updated_at
       FROM zones z
       LEFT JOIN sensor_devices s ON s.zone_id = z.id
       ORDER BY z.created_at ASC, s.updated_at ASC`,
    );

    const zonesById = new Map<string, Zone>();
    for (const row of rows) {
      let zone = zonesById.get(row.id);
      if (!zone) {
        zone = { id: row.id, name: row.name, description: row.description, createdAt: row.created_at, sensors: [] };
        zonesById.set(row.id, zone);
      }
      if (row.sensor_id) {
        zone.sensors.push(toSensor(row));
      }
    }
    return [...zonesById.values()];
  }

  delete(id: string): void {
    // The event log is append-only: keep past events, drop only their link to the removed zone.
    this.transaction(() => {
      this.run('UPDATE security_events SET related_zone_id = NULL WHERE related_zone_id = ?', id);
      this.run('DELETE FROM zones WHERE id = ?', id);
    })();
  }
}
