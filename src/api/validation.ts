import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { z } from 'zod';
import { ApiError } from './app.js';
import {
  OUTDOOR_MAX_DURATION_SEC,
  OUTDOOR_MIN_DURATION_SEC,
  SIREN_KINDS,
} from '../alarm/siren-repository.js';
import { MAX_EVENT_PAGE, SECURITY_EVENT_TYPES } from '../events/event-repository.js';
import { isValidTimeZone, WEEKDAYS } from '../auth/guest-schedule.js';
import { SENSOR_PLACEMENTS } from '../db/repositories/sensor-repository.js';
import { MODE_DELAY_MAX_SEC, MODE_DELAY_MIN_SEC } from '../db/repositories/mode-config-repository.js';

// Upper bounds keep a hostile body from feeding an unbounded string to scrypt/SQLite.
const MAX_CODE_LENGTH = 128;
const MAX_NAME_LENGTH = 100;

const code = z.string().min(1, 'must not be empty').max(MAX_CODE_LENGTH);
/** A code being created or changed: exactly four digits (Ring spec, Access). Codes already stored stay valid. */
const newCode = z.string().regex(/^\d{4}$/, 'must be exactly 4 digits');
const name = z.string().min(1, 'must not be empty').max(MAX_NAME_LENGTH);

/** `POST /api/v1/auth/login` and `POST /api/v1/panel/disarm` bodies. */
export const codeBodySchema = z.object({ code });

/**
 * `PUT /api/v1/users/{userId}/code` and `PUT .../duress-code` body: a new four-digit code. `confirmCode` is the
 * second entry the spec asks for; when sent it must equal `code`.
 */
export const newCodeBodySchema = z
  .object({ code: newCode, confirmCode: z.string().optional() })
  .refine((body) => body.confirmCode === undefined || body.confirmCode === body.code, {
    message: '"confirmCode" must match "code"',
    path: ['confirmCode'],
  });

/** `POST /api/v1/panel/arm` body. */
export const ARM_SOURCES = ['app', 'keypad', 'lock', 'schedule', 'alexa'] as const;

/**
 * `POST /api/v1/panel/arm` body. `bypass` lists the sensor ids the caller confirms to bypass for this arm
 * session; `source` defaults to `app`. `lock` and `schedule` bypass faulted sensors without confirmation.
 */
export const armBodySchema = z.object({
  mode: z.enum(['armed_away', 'armed_home']),
  bypass: z.array(z.string().min(1)).max(256).optional(),
  source: z.enum(ARM_SOURCES).optional(),
});

const description = z.string().max(500);
const nonEmpty = (body: object): boolean => Object.keys(body).length > 0;
const NON_EMPTY_MESSAGE = 'must include at least one field to change';

/** `POST /api/v1/zones` body. */
export const createZoneBodySchema = z.object({ name, description: description.nullable().optional() });

/** `PATCH /api/v1/zones/{zoneId}` body. */
export const updateZoneBodySchema = z
  .object({ name, description: description.nullable() })
  .partial()
  .refine(nonEmpty, NON_EMPTY_MESSAGE);

const placement = z.enum(SENSOR_PLACEMENTS);
const alarmKind = z.enum(['SMOKE', 'CO', 'FLOOD_FREEZE']);
const armedFlags = z.object({ home: z.boolean(), away: z.boolean() }).partial().refine(nonEmpty, NON_EMPTY_MESSAGE);

/**
 * `PATCH /api/v1/sensors/{sensorId}` body. `armed` is per mode: `{ home?, away? }`. `placement` applies to
 * intrusion sensors only (the route rejects it for life-safety).
 */
export const updateSensorBodySchema = z
  .object({ name, category: z.enum(['intrusion', 'life-safety']), zoneId: z.string().min(1), placement, armed: armedFlags, alertsOnly: z.boolean(), alarmKind })
  .partial()
  .refine(nonEmpty, NON_EMPTY_MESSAGE);

/** `POST /api/v1/zones/{zoneId}/sensors` body. */
export const assignSensorBodySchema = z.object({
  zwaveNodeId: z.number().int().positive(),
  name,
  category: z.enum(['intrusion', 'life-safety']),
  placement: placement.optional(),
  armed: armedFlags.optional(),
  alertsOnly: z.boolean().optional(),
  alarmKind: alarmKind.optional(),
});

/**
 * `POST /api/v1/panel/panic` body: the app's panic / fire / medical / SOS buttons. `service` only matters for
 * `SOS`, where it picks who is requested (default `police`).
 */
export const panicBodySchema = z.object({
  type: z.enum(['PANIC', 'FIRE', 'MEDICAL', 'SOS']),
  service: z.enum(['police', 'fire', 'medical']).optional(),
});

/** `GET /api/v1/alarm-events` query string. */
export const alarmEventsQuerySchema = z.object({
  active: z.enum(['true', 'false']).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

/**
 * `PUT /api/v1/sirens/{nodeId}` body: enrols a Z-Wave node as a siren. `durationSec` (60-600) is only
 * accepted for `OUTDOOR`, the one siren whose duration is configurable; BASE and DOME run a fixed 600 s.
 */
export const sirenBodySchema = z.object({
  kind: z.enum(SIREN_KINDS),
  name: name.optional(),
  durationSec: z.number().int().min(OUTDOOR_MIN_DURATION_SEC).max(OUTDOOR_MAX_DURATION_SEC).optional(),
});

const delaySeconds = z.number().int().min(MODE_DELAY_MIN_SEC).max(MODE_DELAY_MAX_SEC);
const modeDelays = z.object({ entryDelaySec: delaySeconds, exitDelaySec: delaySeconds }).partial().refine(nonEmpty, NON_EMPTY_MESSAGE);

/** `PATCH /api/v1/modes` body: per-mode entry/exit delay, 0-180 whole seconds. */
export const updateModesBodySchema = z
  .object({ armed_home: modeDelays, armed_away: modeDelays })
  .partial()
  .refine(nonEmpty, NON_EMPTY_MESSAGE);

/** contracts/rest-api.md documents `guestExpiresAt` as a string; an epoch-ms number is also accepted. */
const guestExpiresAt = z
  .union([
    z.number(),
    z.string().refine((value) => !Number.isNaN(Date.parse(value)), 'must be an ISO date string'),
  ])
  .transform((value) => (typeof value === 'number' ? value : Date.parse(value)));

const haId = z.string().min(1).max(MAX_NAME_LENGTH);
const role = z.enum(['administrator', 'member', 'guest', 'installer']);

/** `POST /api/v1/users` body. `code` may be omitted; the user then has no code until `PUT /users/{id}/code`. */
export const createUserBodySchema = z.object({
  name,
  role,
  code: newCode.optional(),
  confirmCode: z.string().optional(),
  haPersonId: haId.optional(),
  haUserId: haId.optional(),
  guestExpiresAt: guestExpiresAt.optional(),
  guestZoneId: z.string().min(1).optional(),
}).refine((body) => body.confirmCode === undefined || body.confirmCode === body.code, {
  message: '"confirmCode" must match "code"',
  path: ['confirmCode'],
});

/** `PATCH /api/v1/users/{userId}` body (never carries a code). `null` clears a nullable field. */
export const updateUserBodySchema = z
  .object({
    name,
    role,
    haPersonId: haId.nullable(),
    haUserId: haId.nullable(),
    guestExpiresAt: guestExpiresAt.nullable(),
    guestZoneId: z.string().min(1).nullable(),
  })
  .partial()
  .refine(nonEmpty, NON_EMPTY_MESSAGE);

const clockTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'must be HH:MM, 24 h');
const weekdays = z
  .array(z.enum(WEEKDAYS))
  .min(1, 'must name at least one day')
  .refine((days) => new Set(days).size === days.length, 'must not repeat a day');
const timeZone = z.string().refine(isValidTimeZone, 'must be an IANA time zone, e.g. America/Chicago');

/**
 * `POST /api/v1/users/{userId}/schedules` body. Unless `allDay` is true, both `start` and `end` (`HH:MM`) are
 * required; an `end` at or before `start` is an overnight window. `timeZone` defaults to the server's own.
 */
export const createScheduleBodySchema = z
  .object({
    name,
    days: weekdays,
    allDay: z.boolean().optional(),
    start: clockTime.optional(),
    end: clockTime.optional(),
    timeZone: timeZone.nullable().optional(),
  })
  .refine((body) => body.allDay === true || (body.start !== undefined && body.end !== undefined), {
    message: '"start" and "end" are required unless "allDay" is true',
    path: ['start'],
  });

/** `PATCH /api/v1/users/{userId}/schedules/{scheduleId}` body: any field above; the route re-checks the merged result. */
export const updateScheduleBodySchema = z
  .object({
    name,
    days: weekdays,
    allDay: z.boolean(),
    start: clockTime.nullable(),
    end: clockTime.nullable(),
    timeZone: timeZone.nullable(),
  })
  .partial()
  .refine(nonEmpty, NON_EMPTY_MESSAGE);

const lockAction = z.enum(['lock', 'unlock']).nullable();

/**
 * `PUT /api/v1/locks/{nodeId}/mode-settings` body: any of the three switches and any mode's action
 * (`"lock"`, `"unlock"` or `null` for none). Fields left out keep their value.
 */
export const lockModeSettingsBodySchema = z
  .object({
    armOnLockWithCode: z.boolean(),
    armOnOneTouch: z.boolean(),
    disarmOnUnlock: z.boolean(),
    actions: z.object({ disarmed: lockAction, armed_home: lockAction, armed_away: lockAction }).partial(),
  })
  .partial()
  .refine(nonEmpty, NON_EMPTY_MESSAGE);

const scheduledMode = z.enum(['disarmed', 'armed_home', 'armed_away']);

/**
 * `POST /api/v1/mode-schedules` body: set the panel to `mode` at `time` (`HH:MM`) on `days`, in `timeZone`
 * (an IANA name; null or omitted means the server's own zone). Enabled unless said otherwise.
 */
export const createModeScheduleBodySchema = z.object({
  name,
  mode: scheduledMode,
  time: clockTime,
  days: weekdays,
  enabled: z.boolean().optional(),
  timeZone: timeZone.nullable().optional(),
});

/** `PATCH /api/v1/mode-schedules/{id}` body: any field above; send only `enabled` to toggle it. */
export const updateModeScheduleBodySchema = z
  .object({ name, mode: scheduledMode, time: clockTime, days: weekdays, enabled: z.boolean(), timeZone: timeZone.nullable() })
  .partial()
  .refine(nonEmpty, NON_EMPTY_MESSAGE);

/** `GET /api/v1/users` query string. */
export const usersQuerySchema = z.object({ haPersonId: haId.optional() });

/** `GET /api/v1/zones/{zoneId}` ... `DELETE /api/v1/zones/{zoneId}` query string. */
export const deleteZoneQuerySchema = z.object({ force: z.enum(['true', 'false']).optional() });

/** `POST /api/v1/ha-links` body. */
export const createHaLinkBodySchema = z.object({ label: name });

/** `PATCH /api/v1/lockout-policy` body: any subset of the policy, but at least one field. */
export const lockoutPolicyUpdateSchema = z
  .object({
    failedAttemptThreshold: z.number().int().min(1).max(100),
    cooldownSeconds: z.number().int().min(1).max(86_400),
    onThresholdExceeded: z.enum(['lockout', 'trigger_alarm']),
  })
  .partial()
  .refine((body) => Object.keys(body).length > 0, 'must include at least one field to change');

/** `PATCH /api/v1/keypad-settings` body. */
export const keypadSettingsUpdateSchema = z
  .object({ requireCodeToArm: z.boolean() })
  .partial()
  .refine((body) => Object.keys(body).length > 0, 'must include at least one field to change');

/** `GET /api/v1/events` query string (`since` is epoch-ms, `limit` a positive integer). */
// `z.coerce.number()` alone would turn an empty `?since=` into 0, so require a non-empty string
// first; `z.number()` then rejects the NaN that a non-numeric string converts to.
const numericString = z.string().min(1, 'must not be empty').transform(Number);
const eventTypes = z
  .string()
  .min(1, 'must not be empty')
  .transform((value) => value.split(',').map((type) => type.trim()))
  .pipe(z.array(z.enum(SECURITY_EVENT_TYPES)).min(1));
const queryId = z.string().min(1).max(200);

/**
 * `GET /api/v1/events` query string. `type` is a comma-separated list of event types; `before` is an event id
 * (a paging cursor); `limit` is 1-500. The parsed result is `ListSecurityEventsOptions` (`type` becomes `types`).
 */
export const eventsQuerySchema = z
  .object({
    since: numericString.pipe(z.number()).optional(),
    until: numericString.pipe(z.number()).optional(),
    limit: numericString.pipe(z.number().int().min(1).max(MAX_EVENT_PAGE)).optional(),
    type: eventTypes.optional(),
    deviceId: queryId.optional(),
    userId: queryId.optional(),
    before: queryId.optional(),
  })
  .transform(({ type, ...rest }) => ({ ...rest, ...(type !== undefined && { types: type }) }));

function describeIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => (issue.path.length > 0 ? `"${issue.path.join('.')}": ${issue.message}` : issue.message))
    .join('; ');
}

function parseOrThrow<T extends z.ZodType>(schema: T, input: unknown, where: 'body' | 'query'): z.output<T> {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new ApiError(400, 'bad_request', `Invalid request ${where}: ${describeIssues(result.error)}`);
  }
  return result.data;
}

/**
 * Validates `req.body` against `schema` and replaces it with the parsed
 * output (unknown keys stripped, transforms applied). A missing or
 * non-object body is rejected the same way as a malformed one. Failures go
 * through the shared error middleware as `400` with the contract's standard
 * `{ error: { code, message } }` shape.
 */
export function validateBody(schema: z.ZodType): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction): void => {
    try {
      req.body = parseOrThrow(schema, req.body, 'body');
      next();
    } catch (err) {
      next(err);
    }
  };
}

/**
 * Validates `req.query` against `schema`. Express 5 exposes `req.query` as a
 * read-only getter, so the parsed result is read back via `parsedQuery()`
 * from `res.locals` instead of replacing it.
 */
export function validateQuery(schema: z.ZodType): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    try {
      res.locals.query = parseOrThrow(schema, req.query, 'query');
      next();
    } catch (err) {
      next(err);
    }
  };
}

/** The value `validateQuery` stored for this request. */
export function parsedQuery<T>(res: Response): T {
  return res.locals.query as T;
}

/** `POST /api/v1/keypads/{nodeId}/chime` body. `sound` is checked against the keypad's own list by the service. */
export const chimeBodySchema = z.object({
  sound: z.string().min(1).max(MAX_NAME_LENGTH),
  volume: z.number().int().min(0).max(99).optional(),
});

const sensitivity = z.number().int().min(0).max(5);

/** `PATCH /api/v1/locks/{nodeId}/settings` body: any subset of the writable settings, at least one. */
export const lockSettingsBodySchema = z
  .object({
    beeper: z.boolean(),
    vacationMode: z.boolean(),
    lockAndLeave: z.boolean(),
    autoLock: z.boolean(),
    pinLength: z.number().int().min(4).max(8),
    alarmMode: z.enum(['off', 'alert', 'tamper', 'forced_entry']),
    alertSensitivity: sensitivity,
    tamperSensitivity: sensitivity,
    kickSensitivity: sensitivity,
    localControls: z.boolean(),
  })
  .partial()
  .strict()
  .refine(nonEmpty, NON_EMPTY_MESSAGE);

/** `PUT /api/v1/locks/{nodeId}/users/{userId}/code` body. The PIN length is checked against the lock's setting. */
export const lockUserCodeBodySchema = z.object({
  code: z.string().min(1, 'must not be empty').max(16),
  status: z.enum(['enabled', 'disabled']).optional(),
});

/** `PUT /api/v1/locks/{nodeId}/state` body: `true` throws the bolt, `false` retracts it. */
export const lockStateBodySchema = z.object({ locked: z.boolean() });

/** `PUT /api/v1/locks/{nodeId}/users/{userId}/schedules/enabled` body. */
export const lockScheduleEnabledBodySchema = z.object({ enabled: z.boolean() });

const hour = z.number().int().min(0).max(23);
const minute = z.number().int().min(0).max(59);
const weekday = z.number().int().min(0).max(6);

const weekDaySchedule = z
  .object({ weekday, startHour: hour, startMinute: minute, stopHour: hour, stopMinute: minute })
  .strict()
  .refine((s) => s.stopHour * 60 + s.stopMinute > s.startHour * 60 + s.startMinute, 'stop time must be after the start time');

const yearDaySchedule = z
  .object({
    startYear: z.number().int().min(0).max(99),
    startMonth: z.number().int().min(1).max(12),
    startDay: z.number().int().min(1).max(31),
    startHour: hour,
    startMinute: minute,
    stopYear: z.number().int().min(0).max(99),
    stopMonth: z.number().int().min(1).max(12),
    stopDay: z.number().int().min(1).max(31),
    stopHour: hour,
    stopMinute: minute,
  })
  .strict()
  .refine(
    (s) =>
      [s.stopYear, s.stopMonth, s.stopDay, s.stopHour, s.stopMinute].join(',') !== [s.startYear, s.startMonth, s.startDay, s.startHour, s.startMinute].join(',') &&
      (s.stopYear - s.startYear || s.stopMonth - s.startMonth || s.stopDay - s.startDay || s.stopHour - s.startHour || s.stopMinute - s.startMinute) > 0,
    'stop must be after the start',
  );

const dailyRepeatingSchedule = z
  .object({
    weekdays: z.array(weekday).min(1).max(7).refine((days) => new Set(days).size === days.length, 'must not repeat a weekday'),
    startHour: hour,
    startMinute: minute,
    durationHour: hour,
    durationMinute: minute,
  })
  .strict();

/** `PUT /api/v1/locks/{nodeId}/users/{userId}/schedules/{kind}/{slotId}` body, by `kind`. */
export const lockScheduleBodySchemas = {
  weekDay: weekDaySchedule,
  yearDay: yearDaySchedule,
  dailyRepeating: dailyRepeatingSchedule,
} as const;
