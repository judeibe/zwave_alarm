import type { NextFunction, Request, Response } from 'express';
import { ApiError } from '../api/app.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function hostOf(url: string): string | null {
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

/**
 * CSRF defence for the cookie-authenticated dashboard: a state-changing request that a browser
 * sends with a session cookie must come from this server's own origin. `SameSite=Lax` already keeps
 * cross-site POSTs from carrying the cookie; this closes the same-site-but-different-origin gap
 * (a sibling subdomain or another local port) by comparing the `Origin` (or `Referer`) host to `Host`.
 *
 * Requests with no `Origin` and no `Referer` are non-browser clients (curl, the HA integration), which
 * can't be driven cross-site, and bearer-token requests carry no ambient credential, so both pass.
 */
export function verifySameOrigin(req: Request, _res: Response, next: NextFunction): void {
  if (SAFE_METHODS.has(req.method) || req.headers.authorization !== undefined) {
    next();
    return;
  }
  const source = req.headers.origin ?? req.headers.referer;
  if (source === undefined) {
    next();
    return;
  }
  if (hostOf(source) !== req.headers.host) {
    next(new ApiError(403, 'forbidden', 'Cross-origin request rejected.'));
    return;
  }
  next();
}
