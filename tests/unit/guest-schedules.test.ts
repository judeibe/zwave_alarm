import { describe, expect, it } from 'vitest';
import {
  isValidTimeZone,
  isWithinSchedules,
  scheduleCovers,
  type GuestSchedule,
  type Weekday,
} from '../../src/auth/guest-schedule.js';

const base = { id: 's', userId: 'u', name: 'n', createdAt: 0 };
const schedule = (over: Partial<GuestSchedule>): GuestSchedule => ({
  ...base,
  days: ['mon'],
  allDay: false,
  start: '09:00',
  end: '17:00',
  timeZone: 'UTC',
  ...over,
});

// 2026-10-26 is a Monday.
const at = (iso: string): number => Date.parse(iso);

describe('guest schedule windows', () => {
  it('covers the listed days between start (inclusive) and end (exclusive)', () => {
    const s = schedule({});

    expect(scheduleCovers(s, at('2026-10-26T09:00:00Z'))).toBe(true);
    expect(scheduleCovers(s, at('2026-10-26T16:59:00Z'))).toBe(true);
    expect(scheduleCovers(s, at('2026-10-26T17:00:00Z'))).toBe(false);
    expect(scheduleCovers(s, at('2026-10-26T08:59:00Z'))).toBe(false);
    expect(scheduleCovers(s, at('2026-10-27T10:00:00Z'))).toBe(false); // Tuesday
  });

  it('covers the whole of a listed day when allDay', () => {
    const s = schedule({ allDay: true, start: null, end: null, days: ['mon', 'sun'] });

    expect(scheduleCovers(s, at('2026-10-26T00:00:00Z'))).toBe(true);
    expect(scheduleCovers(s, at('2026-10-26T23:59:00Z'))).toBe(true);
    expect(scheduleCovers(s, at('2026-10-27T00:00:00Z'))).toBe(false);
  });

  it('runs an overnight window into the next morning, attached to the day it starts', () => {
    const s = schedule({ start: '22:00', end: '06:00', days: ['fri'] });

    expect(scheduleCovers(s, at('2026-10-30T23:00:00Z'))).toBe(true); // Friday evening
    expect(scheduleCovers(s, at('2026-10-31T05:59:00Z'))).toBe(true); // Saturday morning
    expect(scheduleCovers(s, at('2026-10-31T06:00:00Z'))).toBe(false);
    expect(scheduleCovers(s, at('2026-10-30T05:00:00Z'))).toBe(false); // Friday morning belongs to Thursday's window
    expect(scheduleCovers(s, at('2026-10-31T23:00:00Z'))).toBe(false); // Saturday evening
  });

  it('reads the clock in the schedule\'s own time zone', () => {
    // 14:30Z on a Monday is 09:30 in Chicago (CDT, UTC-5) and 15:30 in London... but 23:30 in Tokyo.
    const chicago = schedule({ timeZone: 'America/Chicago', start: '09:00', end: '10:00' });
    const tokyo = schedule({ timeZone: 'Asia/Tokyo', start: '09:00', end: '10:00' });

    expect(scheduleCovers(chicago, at('2026-10-26T14:30:00Z'))).toBe(true);
    expect(scheduleCovers(tokyo, at('2026-10-26T14:30:00Z'))).toBe(false);
    expect(scheduleCovers(tokyo, at('2026-10-26T00:30:00Z'))).toBe(true);
  });

  it('gives a guest with no schedule unlimited access, and with schedules needs one to match', () => {
    const monday = schedule({ days: ['mon' as Weekday] });

    expect(isWithinSchedules([], at('2026-10-27T03:00:00Z'))).toBe(true);
    expect(isWithinSchedules([monday], at('2026-10-27T03:00:00Z'))).toBe(false);
    expect(isWithinSchedules([monday, schedule({ days: ['tue'], start: '01:00', end: '05:00' })], at('2026-10-27T03:00:00Z'))).toBe(true);
  });

  it('validates IANA time zone names', () => {
    expect(isValidTimeZone('America/Chicago')).toBe(true);
    expect(isValidTimeZone('Mars/Olympus')).toBe(false);
  });
});
