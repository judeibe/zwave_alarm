import { Router, type NextFunction, type Request, type Response } from 'express';
import { ApiError } from '../app.js';
import {
  codeBodySchema,
  createUserBodySchema,
  parsedQuery,
  updateUserBodySchema,
  usersQuerySchema,
  validateBody,
  validateQuery,
} from '../validation.js';
import { requireAuth, requireRole } from '../../auth/authorize.js';
import { createLogger } from '../../config/logger.js';
import { hasCode, type CreateUserInput, type User, type UserRepository } from '../../auth/user-repository.js';

const logger = createLogger('api/users');

export interface UserRouteDeps {
  userRepo: UserRepository;
}

/** Public-facing User shape: never leaks `credentialHash` (contracts/rest-api.md's Users section). */
interface PublicUser {
  id: string;
  name: string;
  role: User['role'];
  hasCode: boolean;
  haPersonId: string | null;
  haUserId: string | null;
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
    hasCode: hasCode(user),
    haPersonId: user.haPersonId,
    haUserId: user.haUserId,
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

  router.get('/users', requireAuth, requireRole('administrator'), validateQuery(usersQuerySchema), (_req, res) => {
    const { haPersonId } = parsedQuery<{ haPersonId?: string }>(res);
    const users = userRepo.list().filter((user) => haPersonId === undefined || user.haPersonId === haPersonId);
    res.status(200).json(users.map(toPublicUser));
  });

  const isLastAdministrator = (userId: string): boolean => {
    const admins = userRepo.list().filter((user) => user.role === 'administrator');
    return admins.length === 1 && admins[0].id === userId;
  };

  const requireUser = (userId: string): User => {
    const user = userRepo.findById(userId);
    if (!user) {
      throw new ApiError(404, 'not_found', `User ${userId} does not exist.`);
    }
    return user;
  };

  /** Maps repository/DB failures on user create/update to the contract's statuses. */
  const mapUserWriteError = (err: unknown): never => {
    if (err instanceof Error && err.message.includes('guest')) {
      throw new ApiError(400, 'bad_request', err.message);
    }
    if (err instanceof Error && err.message.includes('FOREIGN KEY')) {
      throw new ApiError(400, 'bad_request', '"guestZoneId" does not refer to an existing zone.');
    }
    if (err instanceof Error && err.message.includes('users.ha_person_id')) {
      throw new ApiError(409, 'conflict', 'That Home Assistant person is already linked to another user.');
    }
    throw err;
  };

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
    if (res.locals.firstRunBootstrap === true && input.code === undefined) {
      throw new ApiError(400, 'bad_request', 'Invalid request body: "code": the first account needs a code.');
    }

    if (input.code !== undefined && userRepo.isCodeInUse(input.code)) {
      throw new ApiError(409, 'code_in_use', 'That code is already in use by another user.');
    }

    try {
      const user = userRepo.create(input);
      if (res.locals.firstRunBootstrap === true) {
        logger.info('first administrator created via first-run bootstrap', { userId: user.id });
      }
      res.status(201).json(toPublicUser(user));
    } catch (err) {
      mapUserWriteError(err);
    }
  });

  router.patch(
    '/users/:userId',
    requireAuth,
    requireRole('administrator'),
    validateBody(updateUserBodySchema),
    (req, res) => {
      const changes = req.body as Parameters<UserRepository['update']>[1];
      const user = requireUser(req.params.userId);
      if (changes.role !== undefined && changes.role !== 'administrator' && isLastAdministrator(user.id)) {
        throw new ApiError(409, 'last_administrator', 'The last administrator cannot be demoted.');
      }
      try {
        res.status(200).json(toPublicUser(userRepo.update(user.id, changes)));
      } catch (err) {
        mapUserWriteError(err);
      }
    },
  );

  router.put(
    '/users/:userId/code',
    requireAuth,
    requireRole('administrator'),
    validateBody(codeBodySchema),
    (req, res) => {
      const user = requireUser(req.params.userId);
      const { code } = req.body as { code: string };
      if (userRepo.isCodeInUse(code, user.id)) {
        throw new ApiError(409, 'code_in_use', 'That code is already in use by another user.');
      }
      userRepo.setCode(user.id, code);
      res.status(204).send();
    },
  );

  router.delete('/users/:userId/code', requireAuth, requireRole('administrator'), (req, res) => {
    const user = requireUser(req.params.userId);
    if (user.role === 'administrator' && isLastAdministrator(user.id)) {
      throw new ApiError(409, 'last_administrator', "The last administrator's code cannot be cleared.");
    }
    userRepo.setCode(user.id, null);
    res.status(204).send();
  });

  router.delete('/users/:userId', requireAuth, requireRole('administrator'), (req, res) => {
    userRepo.delete(req.params.userId);
    res.status(204).send();
  });

  return router;
}
