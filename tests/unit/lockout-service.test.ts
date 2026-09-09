import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDatabase } from '../../src/db/schema.js';
import { AlarmPanelRepository } from '../../src/alarm/panel-repository.js';
import { EventRepository } from '../../src/events/event-repository.js';
import { UserRepository } from '../../src/auth/user-repository.js';
import { LockoutPolicyRepository } from '../../src/auth/lockout-policy-repository.js';
import { PanelService } from '../../src/alarm/panel-service.js';
import { LockoutService } from '../../src/auth/lockout-service.js';

function buildService() {
  const db = createDatabase(':memory:');
  const panelRepo = new AlarmPanelRepository(db);
  const eventRepo = new EventRepository(db);
  const userRepo = new UserRepository(db);
  const policyRepo = new LockoutPolicyRepository(db);
  const panelService = new PanelService(panelRepo, eventRepo);

  const lockoutService = new LockoutService(userRepo, policyRepo, eventRepo, panelService);

  const user = userRepo.create({ name: 'Alice', role: 'member', code: '1234' });

  return { lockoutService, userRepo, policyRepo, eventRepo, panelService, userId: user.id };
}

describe('LockoutService', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('increments failedAttemptCount without locking below the threshold', () => {
    const { lockoutService, userId } = buildService();

    const result = lockoutService.recordFailedAttempt(userId);

    expect(result.user.failedAttemptCount).toBe(1);
    expect(result.locked).toBe(false);
    expect(result.alarmTriggered).toBe(false);
    expect(result.user.lockedUntil).toBeNull();
  });

  it('locks the account and records a lockout event once the default threshold is reached', () => {
    const { lockoutService, eventRepo, userId } = buildService();

    let result;
    for (let i = 0; i < 5; i += 1) {
      result = lockoutService.recordFailedAttempt(userId);
    }

    expect(result!.locked).toBe(true);
    expect(result!.alarmTriggered).toBe(false);
    expect(result!.user.failedAttemptCount).toBe(5);
    expect(result!.user.lockedUntil).not.toBeNull();
    expect(result!.user.lockedUntil).toBeGreaterThan(Date.now());

    const events = eventRepo.list();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'lockout', source: 'system', sourceUserId: userId });
  });

  it('respects a configured failedAttemptThreshold', () => {
    const { lockoutService, policyRepo, userId } = buildService();
    policyRepo.updatePolicy({ failedAttemptThreshold: 2 });

    const first = lockoutService.recordFailedAttempt(userId);
    expect(first.locked).toBe(false);

    const second = lockoutService.recordFailedAttempt(userId);
    expect(second.locked).toBe(true);
  });

  it('locks for the configured cooldownSeconds', () => {
    const { lockoutService, policyRepo, userId } = buildService();
    policyRepo.updatePolicy({ failedAttemptThreshold: 1, cooldownSeconds: 60 });

    const now = Date.now();
    const result = lockoutService.recordFailedAttempt(userId);

    expect(result.user.lockedUntil).toBe(now + 60_000);
  });

  it('isLocked() is true while lockedUntil is in the future and false once it elapses', () => {
    const { lockoutService, policyRepo, userId, userRepo } = buildService();
    policyRepo.updatePolicy({ failedAttemptThreshold: 1, cooldownSeconds: 60 });

    const result = lockoutService.recordFailedAttempt(userId);
    expect(lockoutService.isLocked(result.user)).toBe(true);

    vi.advanceTimersByTime(60_001);
    const refreshed = userRepo.list().find((u) => u.id === userId)!;
    expect(lockoutService.isLocked(refreshed)).toBe(false);
  });

  it('triggers the alarm instead of locking when onThresholdExceeded is trigger_alarm, without a lockout event', () => {
    const { lockoutService, eventRepo, panelService, policyRepo, userId } = buildService();
    policyRepo.updatePolicy({ failedAttemptThreshold: 1, onThresholdExceeded: 'trigger_alarm' });

    const result = lockoutService.recordFailedAttempt(userId);

    expect(result.locked).toBe(false);
    expect(result.alarmTriggered).toBe(true);
    expect(result.user.lockedUntil).toBeNull();
    expect(panelService.getState().mode).toBe('alarm_triggered');

    const types = eventRepo.list().map((e) => e.type);
    expect(types).toEqual(['alarm_triggered']);
  });

  it('does not reset failedAttemptCount on its own; reset is left to a caller on successful disarm', () => {
    const { lockoutService, userRepo, userId } = buildService();

    lockoutService.recordFailedAttempt(userId);
    lockoutService.recordFailedAttempt(userId);
    expect(userRepo.list().find((u) => u.id === userId)!.failedAttemptCount).toBe(2);

    userRepo.resetFailedAttempts(userId);
    expect(userRepo.list().find((u) => u.id === userId)!.failedAttemptCount).toBe(0);
  });
});
