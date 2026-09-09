import type { User } from './user-repository.js';
import { UserRepository } from './user-repository.js';
import { LockoutPolicyRepository } from './lockout-policy-repository.js';
import { EventRepository } from '../events/event-repository.js';
import { PanelService } from '../alarm/panel-service.js';

export interface RecordFailedAttemptResult {
  user: User;
  /** True when this attempt pushed the account over the threshold and locked it (default `lockout` mode). */
  locked: boolean;
  /** True when this attempt pushed the count over the threshold and the policy's `trigger_alarm` mode fired instead of locking. */
  alarmTriggered: boolean;
}

/**
 * Failed disarm-attempt lockout enforcement (FR-016), wiring T021's User
 * repository, T022's LockoutPolicy repository, and T023's PanelService
 * together on every failed disarm attempt. Callers (T027's auth/disarm
 * routes) are responsible for checking `isLocked()` *before* even attempting
 * to verify a code, so a still-locked user's further guesses never reach
 * `recordFailedAttempt`.
 */
export class LockoutService {
  constructor(
    private readonly userRepo: UserRepository,
    private readonly policyRepo: LockoutPolicyRepository,
    private readonly eventRepo: EventRepository,
    private readonly panelService: PanelService,
  ) {}

  /** True while `user.lockedUntil` is set and still in the future. */
  isLocked(user: Pick<User, 'lockedUntil'>): boolean {
    return user.lockedUntil !== null && user.lockedUntil > Date.now();
  }

  /**
   * Increments `user.failedAttemptCount` (T021) for a wrong disarm-code
   * attempt. Once the count reaches the configured `failedAttemptThreshold`
   * (T022), applies the administrator-configured response exactly once per
   * qualifying attempt: the default `lockout` mode locks the account for
   * `cooldownSeconds` and records a `lockout` SecurityEvent; `trigger_alarm`
   * mode instead calls the panel service (T023) straight to
   * `alarm_triggered`, bypassing the lock entirely — that path already
   * records its own `alarm_triggered` SecurityEvent, so no separate
   * `lockout` event is written.
   *
   * `failedAttemptCount` is intentionally left untouched here: per
   * data-model.md it resets only "on success", i.e. via a caller's
   * subsequent `resetFailedAttempts()` on a correct disarm.
   */
  recordFailedAttempt(userId: string): RecordFailedAttemptResult {
    const user = this.userRepo.incrementFailedAttempts(userId);
    const policy = this.policyRepo.getPolicy();

    if (user.failedAttemptCount < policy.failedAttemptThreshold) {
      return { user, locked: false, alarmTriggered: false };
    }

    if (policy.onThresholdExceeded === 'trigger_alarm') {
      this.panelService.triggerAlarm({
        details: `Failed disarm-attempt threshold exceeded for user ${userId}`,
      });
      return { user, locked: false, alarmTriggered: true };
    }

    const lockedUser = this.userRepo.lock(userId, policy.cooldownSeconds);
    this.eventRepo.record({ type: 'lockout', source: 'system', sourceUserId: userId });
    return { user: lockedUser, locked: true, alarmTriggered: false };
  }
}
