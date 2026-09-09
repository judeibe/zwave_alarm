import { Router } from 'express';
import { ApiError } from '../app.js';
import { requireAuth, requireRole } from '../../auth/authorize.js';
import type { EventRepository, ListSecurityEventsOptions } from '../../events/event-repository.js';

export interface EventRouteDeps {
  eventRepo: EventRepository;
}

/** Parses `?since=` into an epoch-ms number, or throws 400 if present but not a valid one. */
function parseSince(value: unknown): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string' || value.length === 0) {
    throw new ApiError(400, 'bad_request', '"since" must be a numeric epoch-ms timestamp.');
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new ApiError(400, 'bad_request', '"since" must be a numeric epoch-ms timestamp.');
  }
  return parsed;
}

/** Parses `?limit=` into a positive integer, or throws 400 if present but not a valid one. */
function parseLimit(value: unknown): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string' || value.length === 0) {
    throw new ApiError(400, 'bad_request', '"limit" must be a positive integer.');
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new ApiError(400, 'bad_request', '"limit" must be a positive integer.');
  }
  return parsed;
}

/**
 * `GET /api/v1/events?since=&limit=` (contracts/rest-api.md's "Events"
 * section), wired to T020's EventRepository. Gated the same as the other
 * read-only status endpoints (GET /panel, GET /zones): `administrator` or
 * `member`, matching FR-010a's role model — a guest has no documented need
 * to read the security event log.
 */
export function createEventRouter({ eventRepo }: EventRouteDeps): Router {
  const router = Router();

  router.get('/events', requireAuth, requireRole('administrator', 'member'), (req, res) => {
    const options: ListSecurityEventsOptions = {
      since: parseSince(req.query.since),
      limit: parseLimit(req.query.limit),
    };
    res.status(200).json(eventRepo.list(options));
  });

  return router;
}
