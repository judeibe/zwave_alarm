import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { z } from 'zod';
import { ApiError } from './app.js';

// Upper bounds keep a hostile body from feeding an unbounded string to scrypt/SQLite.
const MAX_CODE_LENGTH = 128;
const MAX_NAME_LENGTH = 100;

const code = z.string().min(1, 'must not be empty').max(MAX_CODE_LENGTH);
const name = z.string().min(1, 'must not be empty').max(MAX_NAME_LENGTH);

/** `POST /api/v1/auth/login` and `POST /api/v1/panel/disarm` bodies. */
export const codeBodySchema = z.object({ code });

/** `POST /api/v1/panel/arm` body. */
export const armBodySchema = z.object({ mode: z.enum(['armed_away', 'armed_home']) });

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

/** `PATCH /api/v1/sensors/{sensorId}` body. */
export const updateSensorBodySchema = z
  .object({ name, category: z.enum(['intrusion', 'life-safety']), zoneId: z.string().min(1) })
  .partial()
  .refine(nonEmpty, NON_EMPTY_MESSAGE);

/** `POST /api/v1/zones/{zoneId}/sensors` body. */
export const assignSensorBodySchema = z.object({
  zwaveNodeId: z.number().int().positive(),
  name,
  category: z.enum(['intrusion', 'life-safety']),
});

/** contracts/rest-api.md documents `guestExpiresAt` as a string; an epoch-ms number is also accepted. */
const guestExpiresAt = z
  .union([
    z.number(),
    z.string().refine((value) => !Number.isNaN(Date.parse(value)), 'must be an ISO date string'),
  ])
  .transform((value) => (typeof value === 'number' ? value : Date.parse(value)));

const haId = z.string().min(1).max(MAX_NAME_LENGTH);
const role = z.enum(['administrator', 'member', 'guest']);

/** `POST /api/v1/users` body. `code` may be omitted; the user then has no code until `PUT /users/{id}/code`. */
export const createUserBodySchema = z.object({
  name,
  role,
  code: code.optional(),
  haPersonId: haId.optional(),
  haUserId: haId.optional(),
  guestExpiresAt: guestExpiresAt.optional(),
  guestZoneId: z.string().min(1).optional(),
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
export const eventsQuerySchema = z.object({
  since: numericString.pipe(z.number()).optional(),
  limit: numericString.pipe(z.number().int().positive()).optional(),
});

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
