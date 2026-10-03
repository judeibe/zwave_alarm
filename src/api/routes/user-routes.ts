import { Router, type NextFunction, type Request, type Response } from 'express';
import { ApiError } from '../app.js';
import { createUserBodySchema, validateBody } from '../validation.js';
import { requireAuth, requireRole } from '../../auth/authorize.js';
import { createLogger } from '../../config/logger.js';
import type { CreateUserInput, User, UserRepository } from '../../auth/user-repository.js';

const logger = createLogger('api/users');

export interface UserRouteDeps {
  userRepo: UserRepository;
}

/** Public-facing User shape: never leaks `credentialHash` (contracts/rest-api.md's Users section). */
interface PublicUser {
  id: string;
  name: string;
  role: User['role'];
  guestExpiresAt: number | null;
  guestZoneId: string | null;
  failedAttemptCount: number;
  lockedUntil: number | null;
  createdAt: number;
}

function toPublicUser(user: User): PublicUser {
  return {
    id: user.id,
    name: user.name,
    role: user.role,
    guestExpiresAt: user.guestExpiresAt,
    guestZoneId: user.guestZoneId,
    failedAttemptCount: user.failedAttemptCount,
    lockedUntil: user.lockedUntil,
    createdAt: user.createdAt,
  };
}

/**
 * `GET/POST /api/v1/users`, `DELETE /api/v1/users/{userId}` (contracts/rest-api.md's
 * "Users" section), wired to T021's UserRepository — administrator only
 * (FR-010a). Responses always strip `credentialHash`.
 *
 * First-run bootstrap: every route needs an authenticated administrator, so a
 * fresh install would have no way to create the first one. While the `users`
 * table is empty, `POST /users` is therefore accepted without credentials, but
 * only to create an `administrator`; once any user exists it is
 * administrator-only like the rest. The emptiness check and the insert run in
 * the same synchronous tick (better-sqlite3 is synchronous), so two racing
 * first-run requests cannot both succeed.
 */
export function createUserRouter({ userRepo }: UserRouteDeps): Router {
  const router = Router();

  router.get('/users', requireAuth, requireRole('administrator'), (_req, res) => {
    res.status(200).json(userRepo.list().map(toPublicUser));
  });

  const requireAdminUnlessFirstRun = (req: Request, res: Response, next: NextFunction): void => {
    if (userRepo.list().length === 0) {
      res.locals.firstRunBootstrap = true;
      next();
      return;
    }
    requireAuth(req, res, (err?: unknown) => {
      if (err) {
        next(err);
        return;
      }
      requireRole('administrator')(req, res, next);
    });
  };

  router.post('/users', requireAdminUnlessFirstRun, validateBody(createUserBodySchema), (req, res) => {
    const input = req.body as CreateUserInput;
    if (res.locals.firstRunBootstrap === true && input.role !== 'administrator') {
      throw new ApiError(403, 'forbidden', 'The first account must be an administrator.');
    }

    try {
      const user = userRepo.create(input);
      if (res.locals.firstRunBootstrap === true) {
        logger.info('first administrator created via first-run bootstrap', { userId: user.id });
      }
      res.status(201).json(toPublicUser(user));
    } catch (err) {
      if (err instanceof Error && err.message.includes('guest')) {
        throw new ApiError(400, 'bad_request', err.message);
      }
      if (err instanceof Error && err.message.includes('FOREIGN KEY')) {
        throw new ApiError(400, 'bad_request', '"guestZoneId" does not refer to an existing zone.');
      }
      throw err;
    }
  });

  router.delete('/users/:userId', requireAuth, requireRole('administrator'), (req, res) => {
    userRepo.delete(req.params.userId);
    res.status(204).send();
  });

  return router;
}
