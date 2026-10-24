import { Router, type Request, type Response } from 'express';
import { ApiError } from '../app.js';
import { asyncHandler } from '../async-handler.js';
import { lockScheduleBodySchemas, lockScheduleEnabledBodySchema, lockSettingsBodySchema, lockUserCodeBodySchema, validateBody } from '../validation.js';
import { requireAuth, requireRole } from '../../auth/authorize.js';
import {
  LockCommunicationError,
  LockNotFoundError,
  LockNotSecureError,
  LockUnsupportedError,
  SCHEDULE_KINDS,
  type LockService,
  type ScheduleKind,
  type SettingsChange,
  type UserCodeStatus,
} from '../../locks/lock-service.js';
import { LockValueError } from '../../locks/schlage.js';

export interface LockRouteDeps {
  lockService: LockService;
}

/** Maps the lock domain's errors onto the API's error statuses; anything else is a server error. */
function toApiError(err: unknown): unknown {
  if (err instanceof LockNotFoundError) {
    return new ApiError(404, 'not_found', err.message);
  }
  if (err instanceof LockValueError || err instanceof LockUnsupportedError) {
    return new ApiError(400, 'bad_request', err.message);
  }
  if (err instanceof LockNotSecureError) {
    return new ApiError(409, 'lock_not_secure', err.message);
  }
  if (err instanceof LockCommunicationError) {
    return new ApiError(502, 'lock_unavailable', err.message);
  }
  return err;
}

function parseNodeId(value: string): number {
  const nodeId = Number(value);
  if (!Number.isInteger(nodeId) || nodeId < 1) {
    throw new ApiError(400, 'bad_request', 'nodeId must be a positive integer.');
  }
  return nodeId;
}

function parseUserId(value: string): number {
  const userId = Number(value);
  if (!Number.isInteger(userId)) {
    throw new ApiError(400, 'bad_request', 'userId must be an integer.');
  }
  return userId;
}

function parseKind(value: string): ScheduleKind {
  if (!(SCHEDULE_KINDS as readonly string[]).includes(value)) {
    throw new ApiError(404, 'not_found', `Unknown schedule kind "${value}"; expected one of: ${SCHEDULE_KINDS.join(', ')}.`);
  }
  return value as ScheduleKind;
}

/**
 * The Schlage lock endpoints (contracts/locks.md): settings, diagnostics, user codes and Schedule
 * Entry Lock schedules. Nothing here knows a configuration parameter number; that is `LockService`.
 * Every route needs the administrator or member role, and none ever returns a stored user code.
 */
export function createLockRouter({ lockService }: LockRouteDeps): Router {
  const router = Router();
  const guard = [requireAuth, requireRole('administrator', 'member')];

  /** Wraps a handler so a lock error becomes its API error and a missing lock is a 404 up front. */
  const lockHandler = (handler: (nodeId: number, req: Request, res: Response) => Promise<void>) =>
    asyncHandler(async (req, res) => {
      const nodeId = parseNodeId(String(req.params.nodeId));
      try {
        await handler(nodeId, req, res);
      } catch (err) {
        throw toApiError(err);
      }
    });

  router.get('/locks', ...guard, (_req, res) => {
    res.status(200).json({ locks: lockService.list() });
  });

  // Paired but not enrolled locks, so an administrator can pick one to add. Never used to create devices.
  router.get('/locks/available', ...guard, requireRole('administrator'), (_req, res) => {
    res.status(200).json({ locks: lockService.listAvailable() });
  });

  router.put(
    '/locks/:nodeId/enrollment',
    ...guard,
    requireRole('administrator'),
    lockHandler(async (nodeId, _req, res) => {
      res.status(200).json(await lockService.enroll(nodeId));
    }),
  );

  router.delete(
    '/locks/:nodeId/enrollment',
    ...guard,
    requireRole('administrator'),
    lockHandler((nodeId, _req, res) => {
      lockService.unenroll(nodeId);
      res.status(204).end();
      return Promise.resolve();
    }),
  );

  router.get(
    '/locks/:nodeId',
    ...guard,
    lockHandler(async (nodeId, _req, res) => {
      res.status(200).json(lockService.get(nodeId));
    }),
  );

  router.post(
    '/locks/:nodeId/refresh',
    ...guard,
    lockHandler(async (nodeId, _req, res) => {
      res.status(200).json(await lockService.refresh(nodeId));
    }),
  );

  router.patch(
    '/locks/:nodeId/settings',
    ...guard,
    validateBody(lockSettingsBodySchema),
    lockHandler(async (nodeId, req, res) => {
      res.status(200).json(await lockService.updateSettings(nodeId, req.body as SettingsChange));
    }),
  );

  router.get(
    '/locks/:nodeId/users',
    ...guard,
    lockHandler(async (nodeId, _req, res) => {
      res.status(200).json({ users: await lockService.listUsers(nodeId) });
    }),
  );

  router.put(
    '/locks/:nodeId/users/:userId/code',
    ...guard,
    validateBody(lockUserCodeBodySchema),
    lockHandler(async (nodeId, req, res) => {
      const { code, status } = req.body as { code: string; status?: UserCodeStatus };
      res.status(200).json(await lockService.setUserCode(nodeId, parseUserId(String(req.params.userId)), code, status));
    }),
  );

  router.delete(
    '/locks/:nodeId/users/:userId/code',
    ...guard,
    lockHandler(async (nodeId, req, res) => {
      await lockService.clearUserCode(nodeId, parseUserId(String(req.params.userId)));
      res.status(204).end();
    }),
  );

  router.get(
    '/locks/:nodeId/schedules',
    ...guard,
    lockHandler(async (nodeId, _req, res) => {
      res.status(200).json({ slots: await lockService.scheduleSlots(nodeId) });
    }),
  );

  router.put(
    '/locks/:nodeId/users/:userId/schedules/enabled',
    ...guard,
    validateBody(lockScheduleEnabledBodySchema),
    lockHandler(async (nodeId, req, res) => {
      const { enabled } = req.body as { enabled: boolean };
      await lockService.setScheduleEnabled(nodeId, parseUserId(String(req.params.userId)), enabled);
      res.status(204).end();
    }),
  );

  router.get(
    '/locks/:nodeId/users/:userId/schedules/:kind/:slotId',
    ...guard,
    lockHandler(async (nodeId, req, res) => {
      const kind = parseKind(String(req.params.kind));
      const schedule = await lockService.getSchedule(nodeId, kind, parseUserId(String(req.params.userId)), Number(req.params.slotId));
      res.status(200).json({ kind, userId: Number(req.params.userId), slotId: Number(req.params.slotId), schedule: schedule ?? null });
    }),
  );

  router.put(
    '/locks/:nodeId/users/:userId/schedules/:kind/:slotId',
    ...guard,
    lockHandler(async (nodeId, req, res) => {
      const kind = parseKind(String(req.params.kind));
      const parsed = lockScheduleBodySchemas[kind].safeParse(req.body);
      if (!parsed.success) {
        throw new ApiError(400, 'bad_request', `Invalid request body: ${parsed.error.issues.map((issue) => `"${issue.path.join('.')}": ${issue.message}`).join('; ')}`);
      }
      // The kind picks the schema, so the parsed shape is the matching schedule type.
      await lockService.setSchedule(nodeId, kind, parseUserId(String(req.params.userId)), Number(req.params.slotId), parsed.data as never);
      res.status(204).end();
    }),
  );

  router.delete(
    '/locks/:nodeId/users/:userId/schedules/:kind/:slotId',
    ...guard,
    lockHandler(async (nodeId, req, res) => {
      await lockService.clearSchedule(nodeId, parseKind(String(req.params.kind)), parseUserId(String(req.params.userId)), Number(req.params.slotId));
      res.status(204).end();
    }),
  );

  return router;
}
