import { Router, type Request } from 'express';
import { ApiError } from '../app.js';
import { asyncHandler } from '../async-handler.js';
import { requireAuth, requireRole } from '../../auth/authorize.js';
import { CommandRejectedError, type CommandSource } from '../../alarm/dispatcher.js';
import { PanelStateError, type ArmMode, type PanelService } from '../../alarm/panel-service.js';
import { verifyCredential, type UserRepository } from '../../auth/user-repository.js';
import type { LockoutService } from '../../auth/lockout-service.js';

export interface PanelRouteDeps {
  panelService: PanelService;
  userRepo: UserRepository;
  lockoutService: LockoutService;
}

function commandSource(req: Request): CommandSource {
  return req.haLink ? 'home_assistant' : 'native';
}

function callerUserId(req: Request): string | undefined {
  return req.session?.userId ?? req.haLink?.userId;
}

function requireArmMode(body: unknown): ArmMode {
  const mode = (body as { mode?: unknown } | null)?.mode;
  if (mode !== 'armed_away' && mode !== 'armed_home') {
    throw new ApiError(400, 'bad_request', 'Body must include "mode": "armed_away" or "armed_home".');
  }
  return mode;
}

function requireCode(body: unknown): string {
  const code = (body as { code?: unknown } | null)?.code;
  if (typeof code !== 'string' || code.length === 0) {
    throw new ApiError(400, 'bad_request', 'Body must include a non-empty "code" string.');
  }
  return code;
}

/**
 * `GET /api/v1/panel`, `POST /api/v1/panel/arm`, `POST /api/v1/panel/disarm`
 * (contracts/rest-api.md's "Panel" section), wired to T023's PanelService,
 * T025's LockoutService, and T021's UserRepository.
 *
 * Disarm re-verifies the given `code` against the *already-authenticated
 * caller's own* stored credential (via `requireAuth`'s session/HA-token
 * identity), rather than scanning every user's hash the way login's
 * `findByCode` does. This is what makes LockoutService's per-user
 * `recordFailedAttempt(userId)` (T025) usable at all here: a scan-based
 * lookup can only ever resolve to "matches some user" or "matches nobody" —
 * verifyCredential() never fails for an already-identified row without
 * already knowing the row to check, so a repeated-wrong-code lockout is only
 * attributable when the caller's identity is established independently of
 * the code being tested. See auth-routes.ts's login handler for why that
 * doesn't extend to login itself.
 */
export function createPanelRouter({ panelService, userRepo, lockoutService }: PanelRouteDeps): Router {
  const router = Router();

  router.get('/panel', requireAuth, requireRole('administrator', 'member'), (_req, res) => {
    res.status(200).json(panelService.getState());
  });

  router.post(
    '/panel/arm',
    requireAuth,
    requireRole('administrator', 'member'),
    asyncHandler(async (req, res) => {
      const mode = requireArmMode(req.body);

      try {
        const panel = await panelService.arm(mode, {
          source: commandSource(req),
          sourceUserId: callerUserId(req) ?? null,
        });
        res.status(200).json(panel);
      } catch (err) {
        if (err instanceof CommandRejectedError) {
          throw new ApiError(409, 'conflict', err.message);
        }
        if (err instanceof PanelStateError) {
          throw new ApiError(409, 'conflict', err.message);
        }
        throw err;
      }
    }),
  );

  router.post(
    '/panel/disarm',
    requireAuth,
    asyncHandler(async (req, res) => {
      const code = requireCode(req.body);
      const userId = callerUserId(req);
      const user = userId === undefined ? undefined : userRepo.findById(userId);
      if (user === undefined) {
        throw new ApiError(401, 'unauthorized', 'A valid session is required to disarm.');
      }

      if (lockoutService.isLocked(user)) {
        throw new ApiError(423, 'locked', 'This account is locked. Try again later.');
      }
      if (user.role === 'guest' && user.guestExpiresAt !== null && user.guestExpiresAt <= Date.now()) {
        throw new ApiError(401, 'unauthorized', 'This guest code has expired.');
      }

      if (!verifyCredential(code, user.credentialHash)) {
        const result = lockoutService.recordFailedAttempt(user.id);
        if (result.locked) {
          throw new ApiError(423, 'locked', 'This account is locked. Try again later.');
        }
        if (result.alarmTriggered) {
          // LockoutPolicy.onThresholdExceeded === 'trigger_alarm': the panel
          // is already alarm_triggered by the time we get here (mirrors
          // contracts/rest-api.md's login-endpoint description of this mode).
          res.status(200).json(panelService.getState());
          return;
        }
        throw new ApiError(401, 'unauthorized', 'Invalid code.');
      }

      userRepo.resetFailedAttempts(user.id);
      try {
        const panel = await panelService.disarm({ source: commandSource(req), sourceUserId: user.id });
        res.status(200).json(panel);
      } catch (err) {
        if (err instanceof CommandRejectedError) {
          throw new ApiError(409, 'conflict', err.message);
        }
        throw err;
      }
    }),
  );

  return router;
}
