import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { Repository } from '../db/repository.js';
import { createLogger } from '../config/logger.js';
import { localClock, type Weekday } from '../auth/guest-schedule.js';
import type { EventRepository } from '../events/event-repository.js';
import type { PanelService } from './panel-service.js';

const logger = createLogger('alarm/mode-schedule');

export type ScheduledMode = 'disarmed' | 'armed_home' | 'armed_away';

/** An owner-defined schedule that sets the panel's mode at a time of day (Ring spec, Arming). */
export interface ModeSchedule {
  id: string;
  name: string;
  mode: ScheduledMode;
  /** `HH:MM`, 24 h, in `timeZone`. */
  time: string;
  days: Weekday[];
  enabled: boolean;
  /** IANA name, or null for the server's own zone. */
  timeZone: string | null;
  createdAt: number;
  lastRunAt: number | null;
}

interface ModeScheduleRow {
  id: string;
  name: string;
  mode: ScheduledMode;
  time_of_day: string;
  days: string;
  enabled: number;
  time_zone: string | null;
  created_at: number;
  last_run_at: number | null;
}

function toDomain(row: ModeScheduleRow): ModeSchedule {
  return {
    id: row.id,
    name: row.name,
    mode: row.mode,
    time: row.time_of_day,
    days: JSON.parse(row.days) as Weekday[],
    enabled: row.enabled === 1,
    timeZone: row.time_zone,
    createdAt: row.created_at,
    lastRunAt: row.last_run_at,
  };
}

export type ModeScheduleInput = Pick<ModeSchedule, 'name' | 'mode' | 'time' | 'days' | 'enabled' | 'timeZone'>;

/**
 * Repository for the `mode_schedules` table. Emits `'mode_schedule_changed'` (the schedule) when one is
 * created or edited and `'mode_schedule_removed'` (its id) when deleted, for the WebSocket stream.
 */
export class ModeScheduleRepository extends Repository {
  constructor(db: Database.Database) {
    super(db);
  }

  list(): ModeSchedule[] {
    return this.all<ModeScheduleRow>('SELECT * FROM mode_schedules ORDER BY created_at ASC, id ASC').map(toDomain);
  }

  findById(id: string): ModeSchedule | undefined {
    const row = this.get<ModeScheduleRow>('SELECT * FROM mode_schedules WHERE id = ?', id);
    return row ? toDomain(row) : undefined;
  }

  /**
   * The enabled schedule that would fire at the same moment as `candidate` (same `HH:MM` and time zone on a
   * shared weekday), other than `candidate` itself. Two of those would be ambiguous, so they are rejected.
   */
  findConflict(candidate: Pick<ModeSchedule, 'id' | 'time' | 'days' | 'enabled' | 'timeZone'>): ModeSchedule | undefined {
    if (!candidate.enabled) {
      return undefined;
    }
    return this.list().find(
      (other) =>
        other.id !== candidate.id &&
        other.enabled &&
        other.time === candidate.time &&
        other.timeZone === candidate.timeZone &&
        other.days.some((day) => candidate.days.includes(day)),
    );
  }

  create(input: ModeScheduleInput): ModeSchedule {
    const schedule: ModeSchedule = { id: randomUUID(), ...input, createdAt: Date.now(), lastRunAt: null };
    this.run(
      `INSERT INTO mode_schedules (id, name, mode, time_of_day, days, enabled, time_zone, created_at, last_run_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
      schedule.id,
      schedule.name,
      schedule.mode,
      schedule.time,
      JSON.stringify(schedule.days),
      schedule.enabled ? 1 : 0,
      schedule.timeZone,
      schedule.createdAt,
    );
    this.emit('mode_schedule_changed', schedule);
    return schedule;
  }

  update(schedule: ModeSchedule): ModeSchedule {
    this.run(
      `UPDATE mode_schedules SET name = ?, mode = ?, time_of_day = ?, days = ?, enabled = ?, time_zone = ? WHERE id = ?`,
      schedule.name,
      schedule.mode,
      schedule.time,
      JSON.stringify(schedule.days),
      schedule.enabled ? 1 : 0,
      schedule.timeZone,
      schedule.id,
    );
    this.emit('mode_schedule_changed', schedule);
    return schedule;
  }

  markRun(id: string, at: number): void {
    this.run('UPDATE mode_schedules SET last_run_at = ? WHERE id = ?', at, id);
    const updated = this.findById(id);
    if (updated) {
      this.emit('mode_schedule_changed', updated);
    }
  }

  /** Returns true when a schedule was removed. */
  delete(id: string): boolean {
    const removed = this.run('DELETE FROM mode_schedules WHERE id = ?', id).changes > 0;
    if (removed) {
      this.emit('mode_schedule_removed', id);
    }
    return removed;
  }
}

const DEFAULT_INTERVAL_MS = 30_000;

/**
 * Applies the mode schedules: every 30 s it looks for an enabled schedule whose day and `HH:MM` match the
 * clock in its own time zone and runs it once for that minute. Arming uses `source: "schedule"`, so faulted
 * sensors are bypassed automatically (logged as bypassed by the schedule). A schedule that cannot run — the
 * panel is mid-alarm, or already in that mode — is recorded as `mode_schedule_skipped` and does nothing.
 * A minute that passed while the service was down is not replayed.
 */
export class ModeScheduleRunner {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private readonly now: () => number;
  private readonly intervalMs: number;

  constructor(
    private readonly repo: ModeScheduleRepository,
    private readonly panelService: PanelService,
    private readonly eventRepo: EventRepository,
    options: { intervalMs?: number; now?: () => number } = {},
  ) {
    this.now = options.now ?? Date.now;
    this.intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  }

  start(): void {
    if (this.timer) {
      return;
    }
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Runs every schedule that is due right now. Exposed for tests; `start()` calls it on a timer. */
  async tick(): Promise<void> {
    if (this.running) {
      return;
    }
    this.running = true;
    try {
      const now = this.now();
      for (const schedule of this.repo.list()) {
        if (!schedule.enabled) {
          continue;
        }
        const clock = localClock(now, schedule.timeZone);
        if (clock.time !== schedule.time || !schedule.days.includes(clock.weekday)) {
          continue;
        }
        if (schedule.lastRunAt !== null && Math.floor(schedule.lastRunAt / 60_000) === Math.floor(now / 60_000)) {
          continue; // already ran this minute
        }
        this.repo.markRun(schedule.id, now);
        await this.apply(schedule);
      }
    } finally {
      this.running = false;
    }
  }

  private record(type: 'mode_schedule_applied' | 'mode_schedule_skipped', schedule: ModeSchedule, details: string): void {
    this.eventRepo.record({ type, source: 'system', actor: `Schedule: ${schedule.name}`, details });
  }

  private async apply(schedule: ModeSchedule): Promise<void> {
    const actor = `Schedule: ${schedule.name}`;
    const panel = this.panelService.getState();
    try {
      if (panel.mode === 'alarm_pending' || panel.mode === 'alarm_triggered') {
        this.record('mode_schedule_skipped', schedule, `Skipped ${schedule.mode}: an alarm is in progress`);
        return;
      }
      if (schedule.mode === 'disarmed') {
        if (panel.mode === 'disarmed') {
          this.record('mode_schedule_skipped', schedule, 'Skipped disarmed: already disarmed');
          return;
        }
        await this.panelService.disarm({ source: 'native', actor, systemEvent: true });
      } else {
        if (panel.armedMode === schedule.mode && (panel.mode === schedule.mode || panel.mode === 'arming')) {
          this.record('mode_schedule_skipped', schedule, `Skipped ${schedule.mode}: already ${panel.mode === 'arming' ? 'arming' : 'armed'}`);
          return;
        }
        if (panel.mode !== 'disarmed') {
          await this.panelService.disarm({ source: 'native', actor, systemEvent: true });
        }
        await this.panelService.arm(schedule.mode, { source: 'native', armSource: 'schedule', actor, systemEvent: true });
      }
      this.record('mode_schedule_applied', schedule, `Set the panel to ${schedule.mode}`);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      logger.warn('mode schedule could not run', { scheduleId: schedule.id, reason });
      this.record('mode_schedule_skipped', schedule, `Skipped ${schedule.mode}: ${reason}`);
    }
  }
}
