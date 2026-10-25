import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { Repository } from '../repository.js';

export type SensorCategory = 'intrusion' | 'life-safety';
export type SensorState = 'normal' | 'breached';
export type ConnectivityStatus = 'online' | 'offline';

export const SENSOR_PLACEMENTS = ['MAIN_DOOR', 'SECONDARY_DOOR', 'WINDOW', 'ENTRYWAY', 'ROOM', 'GLASS_BREAK'] as const;
/** Where an intrusion sensor sits (Ring spec, Triggers): MAIN_DOOR and ENTRYWAY get the entry delay, the rest alarm at once. */
export type SensorPlacement = (typeof SENSOR_PLACEMENTS)[number];

export interface SensorArmed {
  armedHome: boolean;
  armedAway: boolean;
}

/** Spec defaults: motion (ENTRYWAY, ROOM) is armed AWAY only; everything else is armed in HOME and AWAY. */
export function defaultArmed(placement: SensorPlacement | null): SensorArmed {
  const motion = placement === 'ENTRYWAY' || placement === 'ROOM';
  return { armedHome: !motion, armedAway: true };
}

/** Intrusion sensors default to MAIN_DOOR, which keeps the entry delay every intrusion sensor had before placements existed. */
export function defaultPlacement(category: SensorCategory): SensorPlacement | null {
  return category === 'intrusion' ? 'MAIN_DOOR' : null;
}

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
  /** Null for life-safety sensors, which have no placement. */
  placement: SensorPlacement | null;
  /** Armed while the panel is in armed_home. Always false-equivalent for alertsOnly sensors. */
  armedHome: boolean;
  armedAway: boolean;
  /** Notify only; never raises an alarm (the spec's Outdoor Contact Sensor "alerts only" setting). */
  alertsOnly: boolean;
  updatedAt: number;
}

export interface CreateSensorInput {
  zwaveNodeId: number;
  zoneId: string;
  name: string;
  category: SensorCategory;
  placement?: SensorPlacement | null;
  armedHome?: boolean;
  armedAway?: boolean;
  alertsOnly?: boolean;
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
  placement: SensorPlacement | null;
  armed_home: number;
  armed_away: number;
  alerts_only: number;
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
    placement: row.placement,
    armedHome: row.armed_home === 1,
    armedAway: row.armed_away === 1,
    alertsOnly: row.alerts_only === 1,
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

    const placement = input.category === 'intrusion' ? (input.placement ?? defaultPlacement('intrusion')) : null;
    const armed = defaultArmed(placement);
    const sensor: SensorDevice = {
      id: randomUUID(),
      zwaveNodeId: input.zwaveNodeId,
      zoneId: input.zoneId,
      name: input.name,
      category: input.category,
      currentState: 'normal',
      batteryLevel: null,
      connectivityStatus: 'online',
      placement,
      armedHome: input.armedHome ?? armed.armedHome,
      armedAway: input.armedAway ?? armed.armedAway,
      alertsOnly: input.alertsOnly ?? false,
      updatedAt: Date.now(),
    };
    this.run(
      `INSERT INTO sensor_devices
         (id, zwave_node_id, zone_id, name, category, current_state, battery_level, connectivity_status,
          placement, armed_home, armed_away, alerts_only, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      sensor.id,
      sensor.zwaveNodeId,
      sensor.zoneId,
      sensor.name,
      sensor.category,
      sensor.currentState,
      sensor.batteryLevel,
      sensor.connectivityStatus,
      sensor.placement,
      sensor.armedHome ? 1 : 0,
      sensor.armedAway ? 1 : 0,
      sensor.alertsOnly ? 1 : 0,
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

  findById(id: string): SensorDevice | undefined {
    const row = this.get<SensorDeviceRow>('SELECT * FROM sensor_devices WHERE id = ?', id);
    return row ? toDomain(row) : undefined;
  }

  /**
   * Changes a sensor's name, category, zone, placement, armed flags and/or alertsOnly; throws `sensor <id> not found`
   * when absent. A new placement without explicit armed flags resets them to that placement's spec defaults, and
   * clearing alertsOnly on a sensor with no placement gives it MAIN_DOOR (the spec's Outdoor Contact rule).
   */
  updateConfig(
    id: string,
    changes: Partial<Pick<SensorDevice, 'name' | 'category' | 'zoneId' | 'placement' | 'armedHome' | 'armedAway' | 'alertsOnly'>>,
  ): SensorDevice {
    const current = this.findById(id);
    if (!current) {
      throw new Error(`sensor ${id} not found`);
    }
    const next: SensorDevice = { ...current, ...changes, updatedAt: Date.now() };
    if (next.category === 'life-safety') {
      next.placement = null;
      next.alertsOnly = false;
    } else if (next.placement === null) {
      next.placement = defaultPlacement('intrusion');
    }
    if (next.placement !== current.placement && changes.armedHome === undefined && changes.armedAway === undefined) {
      Object.assign(next, defaultArmed(next.placement));
    }
    this.run(
      `UPDATE sensor_devices
       SET name = ?, category = ?, zone_id = ?, placement = ?, armed_home = ?, armed_away = ?, alerts_only = ?, updated_at = ?
       WHERE id = ?`,
      next.name,
      next.category,
      next.zoneId,
      next.placement,
      next.armedHome ? 1 : 0,
      next.armedAway ? 1 : 0,
      next.alertsOnly ? 1 : 0,
      next.updatedAt,
      id,
    );
    return next;
  }

  /** Unassigns a sensor (the zwave-js node itself is untouched). */
  delete(id: string): void {
    // The event log is append-only: keep past events, drop only their link to the removed sensor.
    this.transaction(() => {
      this.run('UPDATE security_events SET related_sensor_id = NULL WHERE related_sensor_id = ?', id);
      this.run('DELETE FROM sensor_devices WHERE id = ?', id);
    })();
  }

  /** Looks up the sensor assigned to a given zwave-js node, if any (T024's sensor-mapper resolves nodes this way). */
  findByNodeId(zwaveNodeId: number): SensorDevice | undefined {
    const row = this.get<SensorDeviceRow>('SELECT * FROM sensor_devices WHERE zwave_node_id = ?', zwaveNodeId);
    return row ? toDomain(row) : undefined;
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
