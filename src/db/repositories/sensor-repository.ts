import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { Repository } from '../repository.js';

export type SensorCategory = 'intrusion' | 'life-safety';
export type SensorState = 'normal' | 'breached';
export type ConnectivityStatus = 'online' | 'offline';

/** data-model.md's SensorDevice entity. */
export interface SensorDevice {
  id: string;
  zwaveNodeId: number;
  zoneId: string;
  name: string;
  category: SensorCategory;
  currentState: SensorState;
  batteryLevel: number | null;
  connectivityStatus: ConnectivityStatus;
  updatedAt: number;
}

export interface CreateSensorInput {
  zwaveNodeId: number;
  zoneId: string;
  name: string;
  category: SensorCategory;
}

/** Fault fields (connectivity/battery) and breach state are reported separately (FR-012) but both update through this. */
export type SensorStateUpdate = Partial<
  Pick<SensorDevice, 'currentState' | 'batteryLevel' | 'connectivityStatus'>
>;

interface SensorDeviceRow {
  id: string;
  zwave_node_id: number;
  zone_id: string;
  name: string;
  category: SensorCategory;
  current_state: SensorState;
  battery_level: number | null;
  connectivity_status: ConnectivityStatus;
  updated_at: number;
}

function toDomain(row: SensorDeviceRow): SensorDevice {
  return {
    id: row.id,
    zwaveNodeId: row.zwave_node_id,
    zoneId: row.zone_id,
    name: row.name,
    category: row.category,
    currentState: row.current_state,
    batteryLevel: row.battery_level,
    connectivityStatus: row.connectivity_status,
    updatedAt: row.updated_at,
  };
}

/** Repository for the `sensor_devices` table (data-model.md's SensorDevice entity). */
export class SensorRepository extends Repository {
  constructor(db: Database.Database) {
    super(db);
  }

  /**
   * Assigns a zwave-js node to a zone with a category, defaulting to a
   * `normal`/`online` state. Rejects a node already assigned to any zone
   * (data-model.md: "a device cannot be assigned to more than one Zone at a
   * time", FR-010) — the `zoneId` foreign key itself is enforced by the
   * `sensor_devices.zone_id REFERENCES zones(id)` constraint.
   */
  create(input: CreateSensorInput): SensorDevice {
    const existing = this.get<{ id: string }>(
      'SELECT id FROM sensor_devices WHERE zwave_node_id = ?',
      input.zwaveNodeId,
    );
    if (existing) {
      throw new Error(`zwave node ${input.zwaveNodeId} is already assigned to a zone`);
    }

    const sensor: SensorDevice = {
      id: randomUUID(),
      zwaveNodeId: input.zwaveNodeId,
      zoneId: input.zoneId,
      name: input.name,
      category: input.category,
      currentState: 'normal',
      batteryLevel: null,
      connectivityStatus: 'online',
      updatedAt: Date.now(),
    };
    this.run(
      `INSERT INTO sensor_devices
         (id, zwave_node_id, zone_id, name, category, current_state, battery_level, connectivity_status, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      sensor.id,
      sensor.zwaveNodeId,
      sensor.zoneId,
      sensor.name,
      sensor.category,
      sensor.currentState,
      sensor.batteryLevel,
      sensor.connectivityStatus,
      sensor.updatedAt,
    );
    return sensor;
  }

  /** Merges `changes` (breach state and/or fault fields) onto the sensor and stamps updatedAt. */
  updateState(id: string, changes: SensorStateUpdate): SensorDevice {
    const row = this.get<SensorDeviceRow>('SELECT * FROM sensor_devices WHERE id = ?', id);
    if (!row) {
      throw new Error(`sensor ${id} not found`);
    }

    const next: SensorDevice = { ...toDomain(row), ...changes, updatedAt: Date.now() };
    this.run(
      `UPDATE sensor_devices
       SET current_state = ?, battery_level = ?, connectivity_status = ?, updated_at = ?
       WHERE id = ?`,
      next.currentState,
      next.batteryLevel,
      next.connectivityStatus,
      next.updatedAt,
      id,
    );
    return next;
  }

  listByZone(zoneId: string): SensorDevice[] {
    return this.all<SensorDeviceRow>(
      'SELECT * FROM sensor_devices WHERE zone_id = ? ORDER BY updated_at ASC',
      zoneId,
    ).map(toDomain);
  }

  list(): SensorDevice[] {
    return this.all<SensorDeviceRow>('SELECT * FROM sensor_devices ORDER BY updated_at ASC').map(toDomain);
  }
}
