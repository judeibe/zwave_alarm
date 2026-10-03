import { Router } from 'express';
import { requireAuth, requireRole } from '../../auth/authorize.js';
import type { LockoutService } from '../../auth/lockout-service.js';
import type { LockoutPolicyUpdate } from '../../auth/lockout-policy-repository.js';
import { lockoutPolicyUpdateSchema, validateBody } from '../validation.js';

export interface LockoutPolicyRouteDeps {
  lockoutService: LockoutService;
}

/**
 * `GET /api/v1/lockout-policy` and `PATCH /api/v1/lockout-policy`
 * (contracts/rest-api.md's "Lockout Policy" section) — administrator only (FR-010a).
 *
 * FR-016: after a small number of consecutive wrong disarm codes the account is locked for a
 * cooldown, and an administrator MUST be able to choose instead to treat the failures as an active
 * alarm. PATCH accepts any subset of `failedAttemptThreshold`, `cooldownSeconds` and
 * `onThresholdExceeded` (`lockout` | `trigger_alarm`) and returns the resulting policy.
 */
export function createLockoutPolicyRouter({ lockoutService }: LockoutPolicyRouteDeps): Router {
  const router = Router();

  router.get('/lockout-policy', requireAuth, requireRole('administrator'), (_req, res) => {
    res.status(200).json(lockoutService.getPolicy());
  });

  router.patch(
    '/lockout-policy',
    requireAuth,
    requireRole('administrator'),
    validateBody(lockoutPolicyUpdateSchema),
    (req, res) => {
      res.status(200).json(lockoutService.updatePolicy(req.body as LockoutPolicyUpdate));
    },
  );

  return router;
}
