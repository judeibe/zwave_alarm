import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { Repository } from '../db/repository.js';

export const SECURITY_EVENT_TYPES = [
  'armed',
  'disarmed',
  'breach',
  'alarm_triggered',
  'alarm_cleared',
  'device_fault',
  'lockout',
  'guest_code_used',
  // History kinds added in phase 5 (Ring spec, HistoryEvent):
  'bypassed',
  'tamper',
  'tamper_cleared',
  'siren_silenced',
  'code_added',
  'code_changed',
  'code_removed',
  'duress_code_set',
  'duress_code_removed',
  'guest_schedule_added',
  'guest_schedule_updated',
  'guest_schedule_removed',
  'mode_schedule_added',
  'mode_schedule_updated',
  'mode_schedule_removed',
  'mode_schedule_applied',
  'mode_schedule_skipped',
  // Locks (phase 6a):
  'lock_locked',
  'lock_unlocked',
  'lock_jammed',
  'lock_offline',
  'lock_online',
] as const;
export type SecurityEventType = (typeof SECURITY_EVENT_TYPES)[number];
export type SecurityEventSource = 'user' | 'home_assistant' | 'system';

/** The spec's HistoryEvent: an append-only log of who did what to which device (FR-011). */
export interface SecurityEvent {
  id: string;
  type: SecurityEventType;
  source: SecurityEventSource;
  sourceUserId: string | null;
  relatedZoneId: string | null;
  relatedSensorId: string | null;
  details: string | null;
  occurredAt: number;
  /** Display name of who did it: a user, "Home Assistant", "Schedule: <name>" or "System". */
  actor: string | null;
  /** The device concerned: a sensor id, or `node-<n>` for a lock, siren or keypad. Survives deleting the device. */
  deviceId: string | null;
  deviceName: string | null;
}

export interface RecordSecurityEventInput {
  type: SecurityEventType;
  source: SecurityEventSource;
  sourceUserId?: string | null;
  relatedZoneId?: string | null;
  relatedSensorId?: string | null;
  details?: string | null;
  /** Defaults to the user's name, "Home Assistant" or "System", from `sourceUserId` / `source`. */
  actor?: string | null;
  /** Defaults to `relatedSensorId`. */
  deviceId?: string | null;
  /** Defaults to the sensor's name when `deviceId` is a sensor. */
  deviceName?: string | null;
}

export interface ListSecurityEventsOptions {
  /** Only return events at or after this timestamp (epoch ms). */
  since?: number;
  /** Only return events before this timestamp (epoch ms). */
  until?: number;
  /** Only these event types. */
  types?: SecurityEventType[];
  deviceId?: string;
  /** Only events caused by this user. */
  userId?: string;
  /** Paging cursor: an event id; returns only events older than it. */
  before?: string;
  /** Caps the number of rows returned (default and maximum 500). */
  limit?: number;
}

export const MAX_EVENT_PAGE = 500;

interface SecurityEventRow {
  id: string;
  type: SecurityEventType;
  source: SecurityEventSource;
  source_user_id: string | null;
  related_zone_id: string | null;
  related_sensor_id: string | null;
  details: string | null;
  occurred_at: number;
  actor: string | null;
  device_id: string | null;
  device_name: string | null;
}

function toDomain(row: SecurityEventRow): SecurityEvent {
  return {
    id: row.id,
    type: row.type,
    source: row.source,
    sourceUserId: row.source_user_id,
    relatedZoneId: row.related_zone_id,
    relatedSensorId: row.related_sensor_id,
    details: row.details,
    occurredAt: row.occurred_at,
    actor: row.actor,
    deviceId: row.device_id,
    deviceName: row.device_name,
  };
}

/**
 * Repository for the `security_events` table (data-model.md's SecurityEvent
 * entity). Append-only: no update/delete.
 *
 * Emits `'event_recorded'` (the new SecurityEvent) on every `record()` call
 * so `src/api/ws-broadcaster.ts` (T029) can push `event.recorded` to
 * WebSocket clients without every caller (PanelService, SensorMapper,
 * LockoutService, routes) needing to broadcast it themselves.
 */
export class EventRepository extends Repository {
  constructor(db: Database.Database) {
    super(db);
  }

  /** Appends a new SecurityEvent, stamping `occurredAt` with the current time and filling actor and device names. */
  record(input: RecordSecurityEventInput): SecurityEvent {
    if (!(SECURITY_EVENT_TYPES as readonly string[]).includes(input.type)) {
      throw new Error(`unknown security event type "${input.type}"`);
    }
    const sourceUserId = input.sourceUserId ?? null;
    const relatedSensorId = input.relatedSensorId ?? null;
    const deviceId = input.deviceId ?? relatedSensorId;
    const event: SecurityEvent = {
      id: randomUUID(),
      type: input.type,
      source: input.source,
      sourceUserId,
      relatedZoneId: input.relatedZoneId ?? null,
      relatedSensorId,
      details: input.details ?? null,
      occurredAt: Date.now(),
      actor: input.actor ?? this.defaultActor(input.source, sourceUserId),
      deviceId,
      deviceName: input.deviceName ?? this.defaultDeviceName(deviceId),
    };
    this.run(
      `INSERT INTO security_events
         (id, type, source, source_user_id, related_zone_id, related_sensor_id, details, occurred_at,
          actor, device_id, device_name)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      event.id,
      event.type,
      event.source,
      event.sourceUserId,
      event.relatedZoneId,
      event.relatedSensorId,
      event.details,
      event.occurredAt,
      event.actor,
      event.deviceId,
      event.deviceName,
    );
    this.emit('event_recorded', event);
    return event;
  }

  private defaultActor(source: SecurityEventSource, userId: string | null): string | null {
    if (userId !== null) {
      const user = this.get<{ name: string }>('SELECT name FROM users WHERE id = ?', userId);
      if (user) {
        return user.name;
      }
    }
    return source === 'home_assistant' ? 'Home Assistant' : source === 'system' ? 'System' : null;
  }

  private defaultDeviceName(deviceId: string | null): string | null {
    if (deviceId === null) {
      return null;
    }
    return this.get<{ name: string }>('SELECT name FROM sensor_devices WHERE id = ?', deviceId)?.name ?? null;
  }

  /** Looks up a single SecurityEvent by id (e.g. resolving AlarmPanel.triggeredBy's related zone/sensor). */
  findById(id: string): SecurityEvent | undefined {
    const row = this.get<SecurityEventRow>('SELECT * FROM security_events WHERE id = ?', id);
    return row ? toDomain(row) : undefined;
  }

  /**
   * Returns events newest-first, optionally filtered, and capped at `limit` (default and maximum 500). Page by
   * passing the last event's id as `before`.
   */
  list(options: ListSecurityEventsOptions = {}): SecurityEvent[] {
    const clauses: string[] = [];
    const params: unknown[] = [];

    if (options.since !== undefined) {
      clauses.push('occurred_at >= ?');
      params.push(options.since);
    }
    if (options.until !== undefined) {
      clauses.push('occurred_at < ?');
      params.push(options.until);
    }
    if (options.types && options.types.length > 0) {
      clauses.push(`type IN (${options.types.map(() => '?').join(', ')})`);
      params.push(...options.types);
    }
    if (options.deviceId !== undefined) {
      clauses.push('device_id = ?');
      params.push(options.deviceId);
    }
    if (options.userId !== undefined) {
      clauses.push('source_user_id = ?');
      params.push(options.userId);
    }
    if (options.before !== undefined) {
      const cursor = this.get<{ occurred_at: number; rid: number }>(
        'SELECT occurred_at, rowid AS rid FROM security_events WHERE id = ?',
        options.before,
      );
      if (cursor) {
        clauses.push('(occurred_at < ? OR (occurred_at = ? AND rowid < ?))');
        params.push(cursor.occurred_at, cursor.occurred_at, cursor.rid);
      } else {
        return []; // an unknown cursor pages past everything
      }
    }

    let sql = 'SELECT * FROM security_events';
    if (clauses.length > 0) {
      sql += ` WHERE ${clauses.join(' AND ')}`;
    }
    sql += ' ORDER BY occurred_at DESC, rowid DESC LIMIT ?';
    params.push(Math.min(options.limit ?? MAX_EVENT_PAGE, MAX_EVENT_PAGE));

    return this.all<SecurityEventRow>(sql, ...params).map(toDomain);
  }
}
