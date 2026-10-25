import { Router, type Request } from 'express';
import { ApiError } from '../app.js';
import { asyncHandler } from '../async-handler.js';
import {
  alarmEventsQuerySchema,
  armBodySchema,
  codeBodySchema,
  panicBodySchema,
  parsedQuery,
  updateModesBodySchema,
  validateBody,
  validateQuery,
} from '../validation.js';
import { isAuthRequired, requireAuth, requireRole } from '../../auth/authorize.js';
import { CommandRejectedError, type CommandSource } from '../../alarm/dispatcher.js';
import {
  NeedsBypassError,
  PanelStateError,
  UnknownBypassSensorError,
  type ArmMode,
  type ArmSource,
  type PanelService,
} from '../../alarm/panel-service.js';
import { isExpired, verifyCredential, type UserRepository } from '../../auth/user-repository.js';
import type { LockoutService } from '../../auth/lockout-service.js';
import type { AlarmEventService } from '../../alarm/alarm-event-service.js';
import type { EmergencyService } from '../../alarm/alarm-event-repository.js';
import type { EventRepository } from '../../events/event-repository.js';
import type { ZoneRepository } from '../../db/repositories/zone-repository.js';
import type { DriverState } from '../../zwave/driver.js';

export interface PanelRouteDeps {
  panelService: PanelService;
  userRepo: UserRepository;
  lockoutService: LockoutService;
  eventRepo: EventRepository;
  zoneRepo: ZoneRepository;
  /** Serves `GET /alarm-events`; omitted in tests that don't model alarm events. */
  alarmEvents?: AlarmEventService;
  /** Supplies the `driver` field of `GET /panel`; omitted in tests that don't model the Z-Wave driver. */
  driverState?: () => DriverState;
}

function commandSource(req: Request): CommandSource {
  return req.haLink || !req.session?.userId ? 'home_assistant' : 'native';
}

function callerUserId(req: Request): string | undefined {
  return req.session?.userId ?? req.haLink?.userId;
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
export function createPanelRouter({
  panelService,
  userRepo,
  lockoutService,
  eventRepo,
  zoneRepo,
  alarmEvents,
  driverState,
}: PanelRouteDeps): Router {
  const router = Router();

  // The Z-Wave driver's state rides along so a client can tell "service up, driver down" from "service down".
  router.get('/panel', requireAuth, requireRole('administrator', 'member', 'installer'), (_req, res) => {
    const panel = panelService.getState();
    const body = { ...panel, modes: panelService.getModes() };
    res.status(200).json(driverState ? { ...body, driver: driverState() } : body);
  });

  // The app's panic / fire / medical / SOS buttons. Allowed in every mode, never gated by arming state.
  router.post(
    '/panel/panic',
    requireAuth,
    requireRole('administrator', 'member', 'installer'),
    validateBody(panicBodySchema),
    (req, res) => {
      const { type, service } = req.body as { type: 'PANIC' | 'FIRE' | 'MEDICAL' | 'SOS'; service?: EmergencyService };
      try {
        res.status(201).json(panelService.raiseEmergency(type, { service, details: `${type} requested from the app` }));
      } catch (err) {
        if (err instanceof PanelStateError) {
          throw new ApiError(503, 'unavailable', err.message);
        }
        throw err;
      }
    },
  );

  // Mutes the siren but leaves the alarm active and monitoring running. 409 when nothing is sounding.
  router.post('/panel/silence', requireAuth, requireRole('administrator', 'member', 'installer'), (_req, res) => {
    try {
      res.status(200).json({ silenced: panelService.silence() });
    } catch (err) {
      if (err instanceof PanelStateError) {
        throw new ApiError(409, 'conflict', err.message);
      }
      throw err;
    }
  });

  router.get(
    '/alarm-events',
    requireAuth,
    requireRole('administrator', 'member', 'installer'),
    validateQuery(alarmEventsQuerySchema),
    (_req, res) => {
      const { active, limit } = parsedQuery<{ active?: 'true' | 'false'; limit?: number }>(res);
      res.status(200).json(alarmEvents?.list({ activeOnly: active === 'true', limit }) ?? []);
    },
  );

  // Per-mode entry/exit delay (0-180 s). Keyed by armed mode: { armed_home: { entryDelaySec, exitDelaySec }, armed_away: {...} }.
  router.get('/modes', requireAuth, requireRole('administrator', 'member', 'installer'), (_req, res) => {
    res.status(200).json(panelService.getModes());
  });

  router.patch('/modes', requireAuth, requireRole('administrator'), validateBody(updateModesBodySchema), (req, res) => {
    res.status(200).json(panelService.updateModes(req.body as Parameters<PanelService['updateModes']>[0]));
  });

  router.post(
    '/panel/arm',
    requireAuth,
    requireRole('administrator', 'member', 'installer'),
    validateBody(armBodySchema),
    asyncHandler(async (req, res) => {
      const { mode, bypass, source: armSource } = req.body as { mode: ArmMode; bypass?: string[]; source?: ArmSource };

      try {
        const panel = await panelService.arm(mode, {
          source: commandSource(req),
          sourceUserId: callerUserId(req) ?? null,
          armSource,
          bypass,
        });
        res.status(200).json(panel);
      } catch (err) {
        if (err instanceof NeedsBypassError) {
          throw new ApiError(409, 'needs_bypass', err.message, { faulted: err.faulted });
        }
        if (err instanceof UnknownBypassSensorError) {
          throw new ApiError(400, 'bad_request', err.message, { sensorIds: err.sensorIds });
        }
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
    validateBody(codeBodySchema),
    asyncHandler(async (req, res) => {
      const { code } = req.body as { code: string };
      const userId = callerUserId(req);
      // With auth off there is no caller identity, so the code itself identifies the user. A wrong
      // code is a plain 401: there is no account to attribute a failed attempt to.
      const user = userId === undefined ? (isAuthRequired() ? undefined : userRepo.findByCode(code) ?? userRepo.findByDuressCode(code)) : userRepo.findById(userId);
      if (user === undefined) {
        throw new ApiError(401, 'unauthorized', isAuthRequired() ? 'A valid session is required to disarm.' : 'Invalid code.');
      }

      if (lockoutService.isLocked(user)) {
        throw new ApiError(423, 'locked', 'This account is locked. Try again later.');
      }
      if (isExpired(user, Date.now())) {
        throw new ApiError(401, 'unauthorized', `This ${user.role} code has expired.`);
      }

      // The owner's duress code disarms exactly like the normal one (the response doesn't differ), and then
      // quietly raises a DURESS event. Wrong-code lockout only counts codes that match neither.
      const isDuress =
        !verifyCredential(code, user.credentialHash) && user.duressHash !== null && verifyCredential(code, user.duressHash);
      if (!isDuress && !verifyCredential(code, user.credentialHash)) {
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
        const source = commandSource(req);

        if (user.role === 'guest') {
          // FR-011: a guest code being used is itself a security-relevant event.
          eventRepo.record({
            type: 'guest_code_used',
            source: 'user',
            sourceUserId: user.id,
            relatedZoneId: user.guestZoneId,
            details: user.guestZoneId === null ? 'Guest code used to disarm' : 'Zone-restricted guest code used to disarm',
          });
        }
        if (user.role === 'guest' && user.guestZoneId !== null) {
          // FR-010a: a zone-restricted guest only disarms their own zone, never the whole panel.
          const zoneName = zoneRepo.list().find((zone) => zone.id === user.guestZoneId)?.name ?? null;
          const panel = await panelService.disarmZone(user.guestZoneId, {
            source,
            sourceUserId: user.id,
            clearedBy: user.name,
            zoneName,
          });
          res.status(200).json(panel);
          return;
        }

        const panel = await panelService.disarm({
          source,
          sourceUserId: user.id,
          // FR-013/User Story 3: identity recorded on the alarm_cleared event is "Home Assistant"
          // for an HA-originated disarm, even though it's still attributable to a linked user.
          clearedBy: source === 'home_assistant' ? 'Home Assistant' : user.name,
        });
        if (isDuress) {
          panelService.raiseDuress(`Duress code used by ${user.name}`);
        }
        res.status(200).json(isDuress ? panelService.getState() : panel);
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
