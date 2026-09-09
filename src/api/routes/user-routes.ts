import { Router } from 'express';
import { ApiError } from '../app.js';
import { requireAuth, requireRole } from '../../auth/authorize.js';
import type { CreateUserInput, User, UserRepository } from '../../auth/user-repository.js';

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

/** Accepts an epoch-ms number or an ISO date string (contracts/rest-api.md documents the body field as a string). */
function parseGuestExpiresAt(value: unknown): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) {
      return parsed;
    }
  }
  throw new ApiError(400, 'bad_request', '"guestExpiresAt" must be an ISO date string or epoch-ms number.');
}

function requireCreateUserBody(body: unknown): CreateUserInput {
  const { name, role, code, guestExpiresAt, guestZoneId } = (body ?? {}) as Record<string, unknown>;

  if (typeof name !== 'string' || name.length === 0) {
    throw new ApiError(400, 'bad_request', 'Body must include a non-empty "name" string.');
  }
  if (role !== 'administrator' && role !== 'member' && role !== 'guest') {
    throw new ApiError(400, 'bad_request', 'Body must include "role": "administrator", "member", or "guest".');
  }
  if (typeof code !== 'string' || code.length === 0) {
    throw new ApiError(400, 'bad_request', 'Body must include a non-empty "code" string.');
  }
  if (guestZoneId !== undefined && typeof guestZoneId !== 'string') {
    throw new ApiError(400, 'bad_request', '"guestZoneId" must be a string if provided.');
  }

  return {
    name,
    role,
    code,
    guestExpiresAt: parseGuestExpiresAt(guestExpiresAt),
    guestZoneId,
  };
}

/**
 * `GET/POST /api/v1/users`, `DELETE /api/v1/users/{userId}` (contracts/rest-api.md's
 * "Users" section), wired to T021's UserRepository — administrator only
 * (FR-010a). Responses always strip `credentialHash`.
 */
export function createUserRouter({ userRepo }: UserRouteDeps): Router {
  const router = Router();

  router.get('/users', requireAuth, requireRole('administrator'), (_req, res) => {
    res.status(200).json(userRepo.list().map(toPublicUser));
  });

  router.post('/users', requireAuth, requireRole('administrator'), (req, res) => {
    const input = requireCreateUserBody(req.body);
    try {
      const user = userRepo.create(input);
      res.status(201).json(toPublicUser(user));
    } catch (err) {
      if (err instanceof Error && err.message.includes('guest')) {
        throw new ApiError(400, 'bad_request', err.message);
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
