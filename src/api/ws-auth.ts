import { ServerResponse, type IncomingMessage } from 'node:http';
import type { Request, RequestHandler, Response } from 'express';
import type { VerifyClientCallbackAsync } from 'ws';
import { hashToken, type HaLinkLookup } from '../auth/token.js';
import { createLogger } from '../config/logger.js';

const logger = createLogger('api/ws-auth');

const BEARER_PREFIX = 'Bearer ';

export interface WsAuthDeps {
  /** Resolves a bearer token's hash to a Home Assistant link (src/db/repositories/ha-link-repository.ts). */
  haLinkLookup: HaLinkLookup;
  /** The same express-session middleware the REST API uses, so one login covers both. */
  sessionMiddleware: RequestHandler;
}

/**
 * Loads the express-session for a raw HTTP upgrade request by running the
 * session middleware against it with a throwaway response. Nothing is ever
 * written (the stream is read-only and `saveUninitialized` is off), so the
 * response is never sent.
 */
function loadSession(
  sessionMiddleware: RequestHandler,
  req: IncomingMessage,
): Promise<Request['session'] | undefined> {
  return new Promise((resolve) => {
    sessionMiddleware(req as Request, new ServerResponse(req) as Response, () => {
      resolve((req as Request).session);
    });
  });
}

/**
 * `verifyClient` for the push channel (contracts/websocket-events.md:
 * "Authenticated the same way as the REST API (session cookie or bearer
 * token) at connect time", FR-009). A request is accepted when it carries
 *   - an `Authorization: Bearer <token>` header matching a stored HA link, or
 *   - a native-dashboard session cookie for an administrator or member —
 *     the same roles allowed to read `GET /api/v1/panel`, since the stream
 *     carries that same state; a guest session is refused.
 * Anything else is refused during the upgrade handshake with `401`, so an
 * unauthenticated client never receives a snapshot.
 */
export function createWsVerifyClient({ haLinkLookup, sessionMiddleware }: WsAuthDeps): VerifyClientCallbackAsync {
  return (info, callback) => {
    const req = info.req;

    const authorization = req.headers.authorization;
    if (authorization !== undefined) {
      const token = authorization.startsWith(BEARER_PREFIX) ? authorization.slice(BEARER_PREFIX.length).trim() : '';
      const accepted = token !== '' && haLinkLookup.findByTokenHash(hashToken(token)) !== undefined;
      if (!accepted) {
        logger.warn('websocket connection rejected', { reason: 'invalid bearer token', remoteAddress: req.socket.remoteAddress });
      }
      callback(accepted, accepted ? undefined : 401, accepted ? undefined : 'Unauthorized');
      return;
    }

    loadSession(sessionMiddleware, req)
      .then((session) => {
        const role = session?.role;
        const accepted = session?.userId !== undefined && (role === 'administrator' || role === 'member');
        if (!accepted) {
          logger.warn('websocket connection rejected', {
            reason: session?.userId === undefined ? 'no credentials' : 'role not permitted',
            remoteAddress: req.socket.remoteAddress,
          });
        }
        callback(accepted, accepted ? undefined : 401, accepted ? undefined : 'Unauthorized');
      })
      .catch((err: unknown) => {
        logger.error('websocket session lookup failed', { error: err instanceof Error ? err.message : String(err) });
        callback(false, 500, 'Internal Server Error');
      });
  };
}
