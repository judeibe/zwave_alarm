import type { Request } from 'express';
import type { SecurityEventSource } from '../events/event-repository.js';

/** Who made a request, in the terms the history log records: the event `source` and the user behind it. */
export function callerIdentity(req: Request): { source: SecurityEventSource; sourceUserId: string | null } {
  if (req.haLink) {
    return { source: 'home_assistant', sourceUserId: req.haLink.userId ?? null };
  }
  return { source: 'user', sourceUserId: req.session?.userId ?? null };
}
