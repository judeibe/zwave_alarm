import { describe, expect, it } from 'vitest';
import { createDatabase } from '../../src/db/schema.js';
import { LockoutPolicyRepository } from '../../src/auth/lockout-policy-repository.js';

describe('LockoutPolicyRepository', () => {
  it('lazily creates the singleton row with documented defaults', () => {
    const repo = new LockoutPolicyRepository(createDatabase(':memory:'));

    const policy = repo.getPolicy();

    expect(policy.failedAttemptThreshold).toBe(5);
    expect(policy.cooldownSeconds).toBe(300);
    expect(policy.onThresholdExceeded).toBe('lockout');
  });

  it('returns the same row on repeated getPolicy() calls rather than re-creating it', () => {
    const repo = new LockoutPolicyRepository(createDatabase(':memory:'));

    const first = repo.getPolicy();
    const second = repo.getPolicy();

    expect(second).toEqual(first);
  });

  it('merges partial changes onto the current policy', () => {
    const repo = new LockoutPolicyRepository(createDatabase(':memory:'));
    repo.getPolicy();

    const updated = repo.updatePolicy({ failedAttemptThreshold: 3 });

    expect(updated.failedAttemptThreshold).toBe(3);
    expect(updated.cooldownSeconds).toBe(300);
    expect(updated.onThresholdExceeded).toBe('lockout');

    const reread = repo.getPolicy();
    expect(reread).toEqual(updated);
  });

  it('supports switching onThresholdExceeded to trigger_alarm', () => {
    const repo = new LockoutPolicyRepository(createDatabase(':memory:'));
    repo.getPolicy();

    const updated = repo.updatePolicy({ onThresholdExceeded: 'trigger_alarm' });

    expect(updated.onThresholdExceeded).toBe('trigger_alarm');
  });

  it('rejects an onThresholdExceeded value outside the documented enum at the database layer', () => {
    const repo = new LockoutPolicyRepository(createDatabase(':memory:'));
    repo.getPolicy();

    expect(() => repo.updatePolicy({ onThresholdExceeded: 'not-a-real-action' as never })).toThrow(
      /CHECK constraint failed/,
    );
  });
});
