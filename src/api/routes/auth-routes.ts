import { Router } from 'express';
import { ApiError } from '../app.js';
import { codeBodySchema, validateBody } from '../validation.js';
import { createLoginRateLimiter, type LoginRateLimitOptions } from '../../auth/rate-limit.js';
import type { LockoutService } from '../../auth/lockout-service.js';
import type { UserRepository } from '../../auth/user-repository.js';

export interface AuthRouteDeps {
  userRepo: UserRepository;
  lockoutService: LockoutService;
  /** Overrides the login throttle (tests); production uses the defaults in src/auth/rate-limit.ts. */
  loginRateLimit?: LoginRateLimitOptions;
}

/**
 * `POST /api/v1/auth/login` / `POST /api/v1/auth/logout` (contracts/rest-api.md's
 * "Auth" section). Native dashboard only — a Home Assistant instance
 * authenticates via its own bearer token (src/auth/token.ts) and never calls
 * this route.
 *
 * Login identifies the caller purely by which stored credential hash the
 * given `code` matches (`UserRepository.findByCode`, T021) — there is no
 * separate username/id field in the request body. A code that matches no
 * account at all therefore has no user id to attribute a failed attempt to,
 * so unlike `POST /api/v1/panel/disarm` (which already has an authenticated
 * session identifying exactly who is retrying), a wrong code here is just a
 * plain 401 with no LockoutService (T025) bookkeeping — there is nothing to
 * increment. Code-guessing at login is instead bounded by a per-IP rate
 * limit (src/auth/rate-limit.ts). The "wrong code" flow the quickstart's
 * lockout scenario (section 6) actually exercises is disarm, not login.
 */
export function createAuthRouter({ userRepo, lockoutService, loginRateLimit }: AuthRouteDeps): Router {
  const router = Router();
  const loginLimiter = createLoginRateLimiter(loginRateLimit);

  router.post('/auth/login', loginLimiter, validateBody(codeBodySchema), (req, res) => {
    const { code } = req.body as { code: string };
    const user = userRepo.findByCode(code);

    if (user === undefined) {
      throw new ApiError(401, 'unauthorized', 'Invalid code.');
    }
    if (lockoutService.isLocked(user)) {
      throw new ApiError(423, 'locked', 'This account is locked. Try again later.');
    }
    if (user.role === 'guest' && user.guestExpiresAt !== null && user.guestExpiresAt <= Date.now()) {
      throw new ApiError(401, 'unauthorized', 'This guest code has expired.');
    }

    userRepo.resetFailedAttempts(user.id);
    req.session.userId = user.id;
    req.session.role = user.role;
    res.status(200).json({ id: user.id, name: user.name, role: user.role });
  });

  router.post('/auth/logout', (req, res) => {
    req.session.destroy((err) => {
      if (err) {
        res.status(500).json({ error: { code: 'internal_error', message: 'Failed to end the session.' } });
        return;
      }
      res.status(200).json({ status: 'ok' });
    });
  });

  return router;
}
