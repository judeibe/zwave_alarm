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

/** The slice of `HaLinkRepository` (T031, src/db/repositories/ha-link-repository.ts) that `requireHaToken` needs. */
export interface HaLinkLookup {
  findByTokenHash(apiTokenHash: string): { id: string; userId: string; label: string } | undefined;
}

/**
 * Set once at app bootstrap (src/api/app.ts's `createApp`, given a real
 * `HaLinkRepository`) so `requireHaToken` below can resolve real tokens.
 * Left `undefined` in isolated tests of this module that only exercise the
 * header-parsing path (tests/unit/token.test.ts) — every token is then
 * unrecognized, same as this module's original pre-Phase-03 stub.
 */
let haLinkLookup: HaLinkLookup | undefined;

/** Wires a real `ha_links` lookup into `requireHaToken` (replaces the Phase 01 stub, T032). */
export function configureHaLinkAuth(lookup: HaLinkLookup): void {
  haLinkLookup = lookup;
}

function lookupHaLinkByTokenHash(tokenHash: string): HaLink | undefined {
  return haLinkLookup?.findByTokenHash(tokenHash);
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
