import { Router, type NextFunction, type Request, type Response } from 'express';
import { ApiError } from '../app.js';
import {
  createScheduleBodySchema,
  createUserBodySchema,
  newCodeBodySchema,
  parsedQuery,
  updateScheduleBodySchema,
  updateUserBodySchema,
  usersQuerySchema,
  validateBody,
  validateQuery,
} from '../validation.js';
import { requireAuth, requireRole } from '../../auth/authorize.js';
import type { GuestSchedule, GuestScheduleInput, GuestScheduleRepository } from '../../auth/guest-schedule.js';
import { createLogger } from '../../config/logger.js';
import { hasCode, MAX_CODES, type CreateUserInput, type User, type UserRepository } from '../../auth/user-repository.js';

const logger = createLogger('api/users');

export interface UserRouteDeps {
  userRepo: UserRepository;
  /** Serves `/users/{id}/schedules`; the routes are only mounted when supplied. */
  guestSchedules?: GuestScheduleRepository;
}

/** Public-facing User shape: never leaks `credentialHash` (contracts/rest-api.md's Users section). */
interface PublicUser {
  id: string;
  name: string;
  role: User['role'];
  hasCode: boolean;
  /** Whether the owner has a duress code set. Never says what it is. */
  hasDuressCode: boolean;
  haPersonId: string | null;
  haUserId: string | null;
  /** When a guest's or installer's access ends (an installer's is 48 h from creation); null otherwise. */
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
    hasDuressCode: user.duressHash !== null,
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
export function createUserRouter({ userRepo, guestSchedules }: UserRouteDeps): Router {
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
    const input = { ...(req.body as CreateUserInput & { confirmCode?: string }) };
    delete input.confirmCode; // only checked by the body schema
    if (res.locals.firstRunBootstrap === true && input.role !== 'administrator') {
      throw new ApiError(403, 'forbidden', 'The first account must be an administrator.');
    }
    if (res.locals.firstRunBootstrap === true && input.code === undefined) {
      throw new ApiError(400, 'bad_request', 'Invalid request body: "code": the first account needs a code.');
    }

    if (input.code !== undefined && userRepo.isCodeInUse(input.code)) {
      throw new ApiError(409, 'code_in_use', 'That code is already in use by another user.');
    }
    if (input.code !== undefined && userRepo.countCodes() >= MAX_CODES) {
      throw new ApiError(409, 'code_limit', `A location holds at most ${String(MAX_CODES)} codes.`);
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
    validateBody(newCodeBodySchema),
    (req, res) => {
      const user = requireUser(req.params.userId);
      const { code } = req.body as { code: string };
      if (userRepo.isCodeInUse(code, user.id)) {
        throw new ApiError(409, 'code_in_use', 'That code is already in use by another user.');
      }
      if (!hasCode(user) && userRepo.countCodes() >= MAX_CODES) {
        throw new ApiError(409, 'code_limit', `A location holds at most ${String(MAX_CODES)} codes.`);
      }
      userRepo.setCode(user.id, code);
      res.status(204).send();
    },
  );

  // The owner's duress code: disarms like a normal code but quietly raises a DURESS alarm event (one per owner).
  router.put(
    '/users/:userId/duress-code',
    requireAuth,
    requireRole('administrator'),
    validateBody(newCodeBodySchema),
    (req, res) => {
      const user = requireUser(req.params.userId);
      if (user.role !== 'administrator') {
        throw new ApiError(400, 'bad_request', 'Only an administrator (the owner) can have a duress code.');
      }
      const { code } = req.body as { code: string };
      if (userRepo.isCodeInUse(code, undefined, { exceptDuressOf: user.id })) {
        throw new ApiError(409, 'code_in_use', 'That code is already in use by another user.');
      }
      if (user.duressHash === null && userRepo.countCodes() >= MAX_CODES) {
        throw new ApiError(409, 'code_limit', `A location holds at most ${String(MAX_CODES)} codes.`);
      }
      userRepo.setDuressCode(user.id, code);
      res.status(204).send();
    },
  );

  router.delete('/users/:userId/duress-code', requireAuth, requireRole('administrator'), (req, res) => {
    const user = requireUser(req.params.userId);
    userRepo.setDuressCode(user.id, null);
    res.status(204).send();
  });

  router.delete('/users/:userId/code', requireAuth, requireRole('administrator'), (req, res) => {
    const user = requireUser(req.params.userId);
    if (user.role === 'administrator' && isLastAdministrator(user.id)) {
      throw new ApiError(409, 'last_administrator', "The last administrator's code cannot be cleared.");
    }
    userRepo.setCode(user.id, null);
    res.status(204).send();
  });

  if (guestSchedules) {
    // When a guest's code works at the keypad. A guest with no schedule has unlimited access; schedules are
    // not enforced on locks or on the app (guests have no app account). Owner only.
    const requireGuest = (userId: string): User => {
      const user = requireUser(userId);
      if (user.role !== 'guest') {
        throw new ApiError(400, 'bad_request', 'Only a guest has access schedules.');
      }
      return user;
    };

    /** Applies the rules the body schema can't express across fields, and returns the clean input. */
    const checkedSchedule = (next: GuestScheduleInput): GuestScheduleInput => {
      if (next.allDay) {
        return { ...next, start: null, end: null };
      }
      if (next.start === null || next.end === null) {
        throw new ApiError(400, 'bad_request', '"start" and "end" are required unless "allDay" is true.');
      }
      if (next.start === next.end) {
        throw new ApiError(400, 'bad_request', '"start" and "end" must differ; use "allDay" for the whole day.');
      }
      return next;
    };

    router.get('/users/:userId/schedules', requireAuth, requireRole('administrator'), (req, res) => {
      res.status(200).json(guestSchedules.listForUser(requireGuest(req.params.userId).id));
    });

    router.post(
      '/users/:userId/schedules',
      requireAuth,
      requireRole('administrator'),
      validateBody(createScheduleBodySchema),
      (req, res) => {
        const user = requireGuest(req.params.userId);
        const body = req.body as Partial<GuestScheduleInput> & Pick<GuestScheduleInput, 'name' | 'days'>;
        const input = checkedSchedule({
          name: body.name,
          days: body.days,
          allDay: body.allDay ?? false,
          start: body.start ?? null,
          end: body.end ?? null,
          timeZone: body.timeZone ?? null,
        });
        res.status(201).json(guestSchedules.create(user.id, input));
      },
    );

    router.patch(
      '/users/:userId/schedules/:scheduleId',
      requireAuth,
      requireRole('administrator'),
      validateBody(updateScheduleBodySchema),
      (req, res) => {
        const user = requireGuest(req.params.userId);
        const current = guestSchedules.findById(user.id, req.params.scheduleId);
        if (!current) {
          throw new ApiError(404, 'not_found', `Schedule ${req.params.scheduleId} does not exist.`);
        }
        const merged = checkedSchedule({ ...current, ...(req.body as Partial<GuestScheduleInput>) });
        const updated: GuestSchedule = { ...current, ...merged };
        res.status(200).json(guestSchedules.update(updated));
      },
    );

    router.delete('/users/:userId/schedules/:scheduleId', requireAuth, requireRole('administrator'), (req, res) => {
      const user = requireGuest(req.params.userId);
      if (!guestSchedules.delete(user.id, req.params.scheduleId)) {
        throw new ApiError(404, 'not_found', `Schedule ${req.params.scheduleId} does not exist.`);
      }
      res.status(204).send();
    });
  }

  router.delete('/users/:userId', requireAuth, requireRole('administrator'), (req, res) => {
    userRepo.delete(req.params.userId);
    res.status(204).send();
  });

  return router;
}
