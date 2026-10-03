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

/** `POST /api/v1/zones` body. */
export const createZoneBodySchema = z.object({ name });

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

/** `POST /api/v1/users` body. */
export const createUserBodySchema = z.object({
  name,
  role: z.enum(['administrator', 'member', 'guest']),
  code,
  guestExpiresAt: guestExpiresAt.optional(),
  guestZoneId: z.string().min(1).optional(),
});

/** `POST /api/v1/ha-links` body. */
export const createHaLinkBodySchema = z.object({ label: name });

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
