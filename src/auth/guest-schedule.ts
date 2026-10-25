import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { Repository } from '../db/repository.js';

export const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
export type Weekday = (typeof WEEKDAYS)[number];

/**
 * When a guest's code works at the keypad (Ring spec, Access). `start` / `end` are `HH:MM`, 24 h, in `timeZone`
 * (an IANA name; null means the server's own time zone). An `end` at or before `start` is an overnight window:
 * it begins on the listed day and runs into the next morning. `allDay` ignores `start` and `end`.
 */
export interface GuestSchedule {
  id: string;
  userId: string;
  name: string;
  days: Weekday[];
  allDay: boolean;
  start: string | null;
  end: string | null;
  timeZone: string | null;
  createdAt: number;
}

interface GuestScheduleRow {
  id: string;
  user_id: string;
  name: string;
  days: string;
  all_day: number;
  start_time: string | null;
  end_time: string | null;
  time_zone: string | null;
  created_at: number;
}

function toDomain(row: GuestScheduleRow): GuestSchedule {
  return {
    id: row.id,
    userId: row.user_id,
    name: row.name,
    days: JSON.parse(row.days) as Weekday[],
    allDay: row.all_day === 1,
    start: row.start_time,
    end: row.end_time,
    timeZone: row.time_zone,
    createdAt: row.created_at,
  };
}

export type GuestScheduleInput = Pick<GuestSchedule, 'name' | 'days' | 'allDay' | 'start' | 'end' | 'timeZone'>;

/** True when `zone` is an IANA time zone this runtime knows. */
export function isValidTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

const minutesOf = (time: string): number => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));

/** The weekday and minutes-since-midnight of `at` in `timeZone` (the server's own zone when null). */
function localParts(at: number, timeZone: string | null): { day: number; minutes: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    ...(timeZone ? { timeZone } : {}),
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(at));
  const get = (type: string): string => parts.find((part) => part.type === type)?.value ?? '';
  const day = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(get('weekday'));
  return { day, minutes: Number(get('hour')) * 60 + Number(get('minute')) };
}

/** Whether `at` falls inside this schedule's window. */
export function scheduleCovers(schedule: GuestSchedule, at: number): boolean {
  const { day, minutes } = localParts(at, schedule.timeZone);
  const today = WEEKDAYS[day];
  if (schedule.allDay || schedule.start === null || schedule.end === null) {
    return schedule.days.includes(today);
  }
  const start = minutesOf(schedule.start);
  const end = minutesOf(schedule.end);
  if (start < end) {
    return schedule.days.includes(today) && minutes >= start && minutes < end;
  }
  // Overnight: the evening part belongs to the listed day, the morning part to the day after it.
  const yesterday = WEEKDAYS[(day + 6) % 7];
  return (schedule.days.includes(today) && minutes >= start) || (schedule.days.includes(yesterday) && minutes < end);
}

/**
 * A guest with no schedule has unlimited access; with schedules, the code works only inside one of them
 * (Ring spec, Access: "No schedule = unlimited access").
 */
export function isWithinSchedules(schedules: GuestSchedule[], at: number): boolean {
  return schedules.length === 0 || schedules.some((schedule) => scheduleCovers(schedule, at));
}

/** Repository for the `guest_schedules` table. */
export class GuestScheduleRepository extends Repository {
  constructor(db: Database.Database) {
    super(db);
  }

  listForUser(userId: string): GuestSchedule[] {
    return this.all<GuestScheduleRow>(
      'SELECT * FROM guest_schedules WHERE user_id = ? ORDER BY created_at ASC, id ASC',
      userId,
    ).map(toDomain);
  }

  findById(userId: string, id: string): GuestSchedule | undefined {
    const row = this.get<GuestScheduleRow>('SELECT * FROM guest_schedules WHERE id = ? AND user_id = ?', id, userId);
    return row ? toDomain(row) : undefined;
  }

  create(userId: string, input: GuestScheduleInput): GuestSchedule {
    const schedule: GuestSchedule = { id: randomUUID(), userId, ...input, createdAt: Date.now() };
    this.run(
      `INSERT INTO guest_schedules (id, user_id, name, days, all_day, start_time, end_time, time_zone, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      schedule.id,
      userId,
      schedule.name,
      JSON.stringify(schedule.days),
      schedule.allDay ? 1 : 0,
      schedule.start,
      schedule.end,
      schedule.timeZone,
      schedule.createdAt,
    );
    return schedule;
  }

  update(schedule: GuestSchedule): GuestSchedule {
    this.run(
      `UPDATE guest_schedules SET name = ?, days = ?, all_day = ?, start_time = ?, end_time = ?, time_zone = ?
       WHERE id = ? AND user_id = ?`,
      schedule.name,
      JSON.stringify(schedule.days),
      schedule.allDay ? 1 : 0,
      schedule.start,
      schedule.end,
      schedule.timeZone,
      schedule.id,
      schedule.userId,
    );
    return schedule;
  }

  /** Returns true when a schedule was removed. */
  delete(userId: string, id: string): boolean {
    return this.run('DELETE FROM guest_schedules WHERE id = ? AND user_id = ?', id, userId).changes > 0;
  }
}
