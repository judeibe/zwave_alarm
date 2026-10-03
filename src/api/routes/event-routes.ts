import { Router } from 'express';
import { eventsQuerySchema, parsedQuery, validateQuery } from '../validation.js';
import { requireAuth, requireRole } from '../../auth/authorize.js';
import type { EventRepository, ListSecurityEventsOptions } from '../../events/event-repository.js';

export interface EventRouteDeps {
  eventRepo: EventRepository;
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

  router.get('/events', requireAuth, requireRole('administrator', 'member'), validateQuery(eventsQuerySchema), (_req, res) => {
    res.status(200).json(eventRepo.list(parsedQuery<ListSecurityEventsOptions>(res)));
  });

  return router;
}
