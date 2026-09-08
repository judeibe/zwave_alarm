import { createHash } from 'node:crypto';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { ApiError } from '../api/app.js';

/**
 * Populated on `req` by `requireHaToken` once a bearer token resolves to a
 * real `ha_links` row. Mirrors `src/auth/session.ts`'s pattern of attaching
 * the authenticated identity to the request for downstream route handlers.
 */
export interface HaLink {
  id: string;
  userId: string;
  label: string;
}

declare module 'express-serve-static-core' {
  interface Request {
    haLink?: HaLink;
  }
}

const BEARER_PREFIX = 'Bearer ';

/** SHA-256 hex digest of a raw bearer token, matching `ha_links.api_token_hash` (src/db/schema.ts). */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * TODO(Phase 03): replace with a real lookup against the `ha_links` table
 * (src/db/schema.ts) once its repository exists — match on `api_token_hash`,
 * update `last_seen_at`, and treat a `connection_status: 'disconnected'` row
 * as invalid too. Until then every token is unrecognized, so `requireHaToken`
 * always rejects — this is intentional per T014's scope (middleware only).
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- signature documents the real lookup's shape; the stub ignores its argument.
function lookupHaLinkByTokenHash(_tokenHash: string): HaLink | undefined {
  return undefined;
}

function extractBearerToken(header: string | undefined): string | undefined {
  if (header === undefined || !header.startsWith(BEARER_PREFIX)) {
    return undefined;
  }
  const token = header.slice(BEARER_PREFIX.length).trim();
  return token === '' ? undefined : token;
}

/**
 * Gates a route on a valid `Authorization: Bearer <token>` header for Home
 * Assistant links (FR-009's HA auth path, per research.md section 8).
 * Responds `401` via the shared ApiError -> error-middleware pipeline
 * (src/api/app.ts) when the header is missing/malformed or the hashed token
 * doesn't resolve to a known `ha_links` row.
 */
export const requireHaToken: RequestHandler = (req: Request, _res: Response, next: NextFunction): void => {
  const token = extractBearerToken(req.header('authorization'));
  if (token === undefined) {
    next(new ApiError(401, 'unauthorized', 'A valid Bearer token is required.'));
    return;
  }

  const haLink = lookupHaLinkByTokenHash(hashToken(token));
  if (haLink === undefined) {
    next(new ApiError(401, 'unauthorized', 'Invalid or unknown Home Assistant token.'));
    return;
  }

  req.haLink = haLink;
  next();
};
