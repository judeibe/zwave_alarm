import { describe, expect, it } from 'vitest';
import { createDatabase } from '../../src/db/schema.js';
import { LockEnrollmentRepository } from '../../src/db/repositories/lock-enrollment-repository.js';

describe('LockEnrollmentRepository', () => {
  it('records, repeats and removes an enrollment', () => {
    const repo = new LockEnrollmentRepository(createDatabase(':memory:'));

    expect(repo.isEnrolled(5)).toBe(false);
    repo.enroll(5);
    repo.enroll(5);
    expect(repo.isEnrolled(5)).toBe(true);
    expect(repo.isEnrolled(6)).toBe(false);
    repo.unenroll(5);
    expect(repo.isEnrolled(5)).toBe(false);
  });
});
