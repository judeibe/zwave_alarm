import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { ApiError } from '../api/app.js';
import { requireHaToken } from './token.js';
import type { UserRole } from './user-repository.js';

/**
 * Resolves the authenticated caller's role from whichever auth path
 * succeeded: the native dashboard's session (`req.session.role`, set by
 * T027's login route), or a Home Assistant bearer-token link. HA links are
 * only ever issued by an administrator (contracts/rest-api.md's
 * `POST /api/v1/ha-links` is administrator-only), so a request authenticated
 * that way is treated as administrator-privileged once `requireHaToken`'s
 * real lookup (deferred to Phase 03, src/auth/token.ts) actually resolves a
 * link — today that lookup always misses, so this branch is unreachable in
 * practice, matching Phase 02's "zero dependency on Home Assistant" scope.
 */
function resolveRole(req: Request): UserRole | undefined {
  if (req.session?.role !== undefined) {
    return req.session.role;
  }
  return req.haLink ? 'administrator' : undefined;
}

/**
 * Gates a route on either a valid native-dashboard session or a valid Home
 * Assistant bearer token (contracts/rest-api.md: "session cookie ... or
 * Authorization: Bearer <token>" — FR-009). Tries the session first since
 * it's the cheaper, more common native-dashboard path; falls back to
 * `requireHaToken`'s bearer-token check only when no session is present, so
 * a request with neither still gets `requireHaToken`'s own 401.
 */
export const requireAuth: RequestHandler = (req: Request, res: Response, next: NextFunction): void => {
  if (req.session?.userId !== undefined) {
    next();
    return;
  }
  requireHaToken(req, res, next);
};

/**
 * Gates a route on the caller's role (FR-010a), on top of `requireAuth`
 * having already run. Responds `403` via the shared ApiError -> error
 * middleware pipeline (src/api/app.ts) when authenticated but not one of
 * `allowedRoles`.
 */
export function requireRole(...allowedRoles: UserRole[]): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const role = resolveRole(req);
    if (role === undefined || !allowedRoles.includes(role)) {
      next(new ApiError(403, 'forbidden', 'You do not have permission to perform this action.'));
      return;
    }
    next();
  };
}
