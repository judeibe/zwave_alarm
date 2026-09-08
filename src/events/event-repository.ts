import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { Repository } from '../db/repository.js';

export type SecurityEventType =
  | 'armed'
  | 'disarmed'
  | 'breach'
  | 'alarm_triggered'
  | 'alarm_cleared'
  | 'device_fault'
  | 'lockout'
  | 'guest_code_used';
export type SecurityEventSource = 'user' | 'home_assistant' | 'system';

/** data-model.md's SecurityEvent entity — an append-only log (FR-011). */
export interface SecurityEvent {
  id: string;
  type: SecurityEventType;
  source: SecurityEventSource;
  sourceUserId: string | null;
  relatedZoneId: string | null;
  relatedSensorId: string | null;
  details: string | null;
  occurredAt: number;
}

export interface RecordSecurityEventInput {
  type: SecurityEventType;
  source: SecurityEventSource;
  sourceUserId?: string | null;
  relatedZoneId?: string | null;
  relatedSensorId?: string | null;
  details?: string | null;
}

export interface ListSecurityEventsOptions {
  /** Only return events at or after this timestamp (epoch ms). */
  since?: number;
  /** Caps the number of rows returned. */
  limit?: number;
}

interface SecurityEventRow {
  id: string;
  type: SecurityEventType;
  source: SecurityEventSource;
  source_user_id: string | null;
  related_zone_id: string | null;
  related_sensor_id: string | null;
  details: string | null;
  occurred_at: number;
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
  };
}

/** Repository for the `security_events` table (data-model.md's SecurityEvent entity). Append-only: no update/delete. */
export class EventRepository extends Repository {
  constructor(db: Database.Database) {
    super(db);
  }

  /** Appends a new SecurityEvent, stamping `occurredAt` with the current time. */
  record(input: RecordSecurityEventInput): SecurityEvent {
    const event: SecurityEvent = {
      id: randomUUID(),
      type: input.type,
      source: input.source,
      sourceUserId: input.sourceUserId ?? null,
      relatedZoneId: input.relatedZoneId ?? null,
      relatedSensorId: input.relatedSensorId ?? null,
      details: input.details ?? null,
      occurredAt: Date.now(),
    };
    this.run(
      `INSERT INTO security_events
         (id, type, source, source_user_id, related_zone_id, related_sensor_id, details, occurred_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      event.id,
      event.type,
      event.source,
      event.sourceUserId,
      event.relatedZoneId,
      event.relatedSensorId,
      event.details,
      event.occurredAt,
    );
    return event;
  }

  /** Returns events newest-first, optionally filtered to `occurredAt >= since` and capped at `limit` rows. */
  list(options: ListSecurityEventsOptions = {}): SecurityEvent[] {
    const { since, limit } = options;
    const clauses: string[] = [];
    const params: unknown[] = [];

    if (since !== undefined) {
      clauses.push('occurred_at >= ?');
      params.push(since);
    }

    let sql = 'SELECT * FROM security_events';
    if (clauses.length > 0) {
      sql += ` WHERE ${clauses.join(' AND ')}`;
    }
    sql += ' ORDER BY occurred_at DESC';
    if (limit !== undefined) {
      sql += ' LIMIT ?';
      params.push(limit);
    }

    return this.all<SecurityEventRow>(sql, ...params).map(toDomain);
  }
}
