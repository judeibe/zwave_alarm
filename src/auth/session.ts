import session from 'express-session';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { config } from '../config/index.js';
import { ApiError } from '../api/app.js';
import type { UserRole } from './user-repository.js';

/**
 * Login (Phase 02, T027) sets these on `req.session` after validating a
 * disarm code; `requireSession` below treats their presence as "logged in".
 * The role lives on the session (rather than being re-fetched per request)
 * so FR-010a's per-action role check has it available without a DB hit.
 */
declare module 'express-session' {
  interface SessionData {
    userId: string;
    role: UserRole;
  }
}

/**
 * express-session configured with SESSION_SECRET from config (FR-009, the
 * native-dashboard auth path per research.md section 8). Mount once via
 * `app.use(sessionMiddleware)` ahead of any route that reads/writes
 * `req.session`, including the login route itself.
 */
export const sessionMiddleware: RequestHandler = session({
  secret: config.sessionSecret,
  name: 'zwave_alarm.sid',
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
  },
});

/**
 * Gates a route on a valid native-dashboard session. Responds `401` via the
 * shared ApiError -> error-middleware pipeline (src/api/app.ts) when no
 * `userId` has been set on the session for this cookie, i.e. no successful
 * login has happened yet (or the session has been cleared by logout).
 */
export function requireSession(req: Request, _res: Response, next: NextFunction): void {
  if (req.session?.userId === undefined) {
    next(new ApiError(401, 'unauthorized', 'A valid session is required.'));
    return;
  }
  next();
}
