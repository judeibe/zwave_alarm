import type { RequestHandler } from 'express';
import { rateLimit } from 'express-rate-limit';
import { ApiError } from '../api/app.js';
import { createLogger } from '../config/logger.js';

const logger = createLogger('auth/rate-limit');

export interface LoginRateLimitOptions {
  /** Failed login attempts allowed per IP per window. Defaults to 5. */
  limit?: number;
  windowMs?: number;
}

const DEFAULT_LIMIT = 5;
const DEFAULT_WINDOW_MS = 60_000;

/**
 * Per-IP throttle for `POST /api/v1/auth/login`, independent of (and in
 * addition to) the per-account lockout policy (FR-016, src/auth/lockout-service.ts):
 * that policy can only attribute a failed attempt to a user it can identify,
 * and login identifies a user purely by the code that matched — so a wrong
 * code never reaches it. This limiter is what bounds code-guessing at login.
 *
 * Only failed attempts (status >= 400) count against the budget, so a
 * household member logging in normally is never throttled. Over the limit the
 * request is rejected with `429` in the contract's standard error format.
 * State is in-memory per process, which fits this single-instance service.
 *
 * Behind a reverse proxy, set Express's `trust proxy` so `req.ip` is the real
 * client rather than the proxy, otherwise every client shares one budget.
 */
export function createLoginRateLimiter(options: LoginRateLimitOptions = {}): RequestHandler {
  return rateLimit({
    windowMs: options.windowMs ?? DEFAULT_WINDOW_MS,
    limit: options.limit ?? DEFAULT_LIMIT,
    skipSuccessfulRequests: true,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    handler: (req, _res, next) => {
      logger.warn('login rate limit exceeded', { ip: req.ip });
      next(new ApiError(429, 'too_many_requests', 'Too many login attempts. Try again in a minute.'));
    },
  });
}
