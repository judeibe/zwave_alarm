import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { Repository } from '../db/repository.js';

/** The spec's eight alarm event types (Ring spec, Events). FIRE_MEDICAL is split by `service`. */
export const ALARM_EVENT_TYPES = [
  'BURGLARY',
  'SMOKE',
  'CO',
  'PANIC',
  'FIRE_MEDICAL',
  'DURESS',
  'SOS',
  'FLOOD_FREEZE',
] as const;
export type AlarmEventType = (typeof ALARM_EVENT_TYPES)[number];

export type EmergencyService = 'police' | 'fire' | 'medical';

/** `none` never had a siren, `stopped` was ended by a disarm, `timed_out` ran its full duration. */
export type SirenState = 'none' | 'sounding' | 'silenced' | 'timed_out' | 'stopped';

/**
 * Where the monitoring hand-off is. There is no monitoring centre behind this server, so `queued` means
 * "this is the point a signal would be sent". `held` is BURGLARY / SMOKE inside the 30 s cancel window.
 */
export type DispatchState = 'none' | 'held' | 'queued' | 'cancelled';

export interface AlarmEvent {
  id: string;
  type: AlarmEventType;
  service: EmergencyService | null;
  /** The sensor that raised it, when one did (it may since have been deleted). */
  triggerDeviceId: string | null;
  startedAt: number;
  sirenState: SirenState;
  dispatchState: DispatchState;
  cancelledAt: number | null;
  /** Set when a disarm closes the event; null while it is open. */
  endedAt: number | null;
  details: string | null;
}

export interface CreateAlarmEventInput {
  type: AlarmEventType;
  service?: EmergencyService | null;
  triggerDeviceId?: string | null;
  sirenState: SirenState;
  dispatchState: DispatchState;
  dispatchReleaseAt?: number | null;
  details?: string | null;
}

interface AlarmEventRow {
  id: string;
  type: AlarmEventType;
  service: EmergencyService | null;
  trigger_device_id: string | null;
  started_at: number;
  siren_state: SirenState;
  dispatch_state: DispatchState;
  dispatch_release_at: number | null;
  cancelled_at: number | null;
  ended_at: number | null;
  details: string | null;
}

function toDomain(row: AlarmEventRow): AlarmEvent {
  return {
    id: row.id,
    type: row.type,
    service: row.service,
    triggerDeviceId: row.trigger_device_id,
    startedAt: row.started_at,
    sirenState: row.siren_state,
    dispatchState: row.dispatch_state,
    cancelledAt: row.cancelled_at,
    endedAt: row.ended_at,
    details: row.details,
  };
}

export type AlarmEventChanges = Partial<Pick<AlarmEvent, 'sirenState' | 'dispatchState' | 'cancelledAt' | 'endedAt'>>;

/** Repository for the `alarm_events` table (the spec's AlarmEvent). */
export class AlarmEventRepository extends Repository {
  constructor(db: Database.Database) {
    super(db);
  }

  create(input: CreateAlarmEventInput): AlarmEvent {
    const event: AlarmEvent = {
      id: randomUUID(),
      type: input.type,
      service: input.service ?? null,
      triggerDeviceId: input.triggerDeviceId ?? null,
      startedAt: Date.now(),
      sirenState: input.sirenState,
      dispatchState: input.dispatchState,
      cancelledAt: null,
      endedAt: null,
      details: input.details ?? null,
    };
    this.run(
      `INSERT INTO alarm_events
         (id, type, service, trigger_device_id, started_at, siren_state, dispatch_state, dispatch_release_at, details)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      event.id,
      event.type,
      event.service,
      event.triggerDeviceId,
      event.startedAt,
      event.sirenState,
      event.dispatchState,
      input.dispatchReleaseAt ?? null,
      event.details,
    );
    return event;
  }

  findById(id: string): AlarmEvent | undefined {
    const row = this.get<AlarmEventRow>('SELECT * FROM alarm_events WHERE id = ?', id);
    return row ? toDomain(row) : undefined;
  }

  /** Merges `changes` onto the event; throws `alarm event <id> not found` when absent. */
  update(id: string, changes: AlarmEventChanges): AlarmEvent {
    const current = this.findById(id);
    if (!current) {
      throw new Error(`alarm event ${id} not found`);
    }
    const next: AlarmEvent = { ...current, ...changes };
    this.run(
      'UPDATE alarm_events SET siren_state = ?, dispatch_state = ?, cancelled_at = ?, ended_at = ? WHERE id = ?',
      next.sirenState,
      next.dispatchState,
      next.cancelledAt,
      next.endedAt,
      id,
    );
    return next;
  }

  /** Newest first. `activeOnly` keeps events no disarm has closed yet. */
  list(options: { activeOnly?: boolean; limit?: number } = {}): AlarmEvent[] {
    const where = options.activeOnly ? 'WHERE ended_at IS NULL' : '';
    return this.all<AlarmEventRow>(
      `SELECT * FROM alarm_events ${where} ORDER BY started_at DESC, rowid DESC LIMIT ?`,
      options.limit ?? 50,
    ).map(toDomain);
  }

  /** Events whose dispatch is still inside the cancel window, with when it closes. */
  listHeld(): { event: AlarmEvent; releaseAt: number }[] {
    return this.all<AlarmEventRow>("SELECT * FROM alarm_events WHERE dispatch_state = 'held'").map((row) => ({
      event: toDomain(row),
      releaseAt: row.dispatch_release_at ?? row.started_at,
    }));
  }
}
