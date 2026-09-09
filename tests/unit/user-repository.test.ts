import { describe, expect, it } from 'vitest';
import { createDatabase } from '../../src/db/schema.js';
import { ZoneRepository } from '../../src/db/repositories/zone-repository.js';
import { UserRepository, hashCredential, verifyCredential } from '../../src/auth/user-repository.js';

describe('hashCredential/verifyCredential', () => {
  it('produces distinct hashes for the same code (random salt) that both verify', () => {
    const first = hashCredential('1234');
    const second = hashCredential('1234');

    expect(first).not.toBe(second);
    expect(verifyCredential('1234', first)).toBe(true);
    expect(verifyCredential('1234', second)).toBe(true);
  });

  it('rejects the wrong code', () => {
    const hash = hashCredential('1234');

    expect(verifyCredential('9999', hash)).toBe(false);
  });
});

describe('UserRepository', () => {
  it('creates an administrator with zeroed lockout state and no guest fields', () => {
    const repo = new UserRepository(createDatabase(':memory:'));

    const user = repo.create({ name: 'Alice', role: 'administrator', code: '1111' });

    expect(user.id).toBeTruthy();
    expect(user.role).toBe('administrator');
    expect(user.guestExpiresAt).toBeNull();
    expect(user.guestZoneId).toBeNull();
    expect(user.failedAttemptCount).toBe(0);
    expect(user.lockedUntil).toBeNull();
    expect(verifyCredential('1111', user.credentialHash)).toBe(true);
  });

  it('creates a guest with guestExpiresAt set', () => {
    const repo = new UserRepository(createDatabase(':memory:'));

    const guest = repo.create({ name: 'Visiting Cousin', role: 'guest', code: '2222', guestExpiresAt: 999 });

    expect(guest.guestExpiresAt).toBe(999);
    expect(guest.guestZoneId).toBeNull();
  });

  it('creates a zone-restricted guest with guestZoneId set', () => {
    const db = createDatabase(':memory:');
    const zone = new ZoneRepository(db).create('Garage');
    const repo = new UserRepository(db);

    const guest = repo.create({ name: 'Dog Walker', role: 'guest', code: '3333', guestZoneId: zone.id });

    expect(guest.guestZoneId).toBe(zone.id);
    expect(guest.guestExpiresAt).toBeNull();
  });

  it('rejects a guest with neither guestExpiresAt nor guestZoneId set', () => {
    const repo = new UserRepository(createDatabase(':memory:'));

    expect(() => repo.create({ name: 'Nobody', role: 'guest', code: '4444' })).toThrow(
      /guestExpiresAt and\/or guestZoneId/,
    );
  });

  it('ignores guestExpiresAt/guestZoneId for non-guest roles', () => {
    const db = createDatabase(':memory:');
    const zone = new ZoneRepository(db).create('Garage');
    const repo = new UserRepository(db);

    const member = repo.create({
      name: 'Bob',
      role: 'member',
      code: '5555',
      guestExpiresAt: 999,
      guestZoneId: zone.id,
    });

    expect(member.guestExpiresAt).toBeNull();
    expect(member.guestZoneId).toBeNull();
  });

  it('findByCode returns the matching user regardless of insertion order', () => {
    const repo = new UserRepository(createDatabase(':memory:'));
    repo.create({ name: 'Alice', role: 'administrator', code: '1111' });
    const bob = repo.create({ name: 'Bob', role: 'member', code: '2222' });

    const found = repo.findByCode('2222');

    expect(found?.id).toBe(bob.id);
  });

  it('findByCode returns undefined when no user matches', () => {
    const repo = new UserRepository(createDatabase(':memory:'));
    repo.create({ name: 'Alice', role: 'administrator', code: '1111' });

    expect(repo.findByCode('0000')).toBeUndefined();
  });

  it('list returns all users ordered by createdAt', () => {
    const repo = new UserRepository(createDatabase(':memory:'));
    const alice = repo.create({ name: 'Alice', role: 'administrator', code: '1111' });
    const bob = repo.create({ name: 'Bob', role: 'member', code: '2222' });

    const result = repo.list();

    expect(result.map((u) => u.id)).toEqual([alice.id, bob.id]);
  });

  it('delete removes the user', () => {
    const repo = new UserRepository(createDatabase(':memory:'));
    const alice = repo.create({ name: 'Alice', role: 'administrator', code: '1111' });

    repo.delete(alice.id);

    expect(repo.list()).toEqual([]);
  });

  it('incrementFailedAttempts increments the counter each call', () => {
    const repo = new UserRepository(createDatabase(':memory:'));
    const user = repo.create({ name: 'Alice', role: 'administrator', code: '1111' });

    repo.incrementFailedAttempts(user.id);
    const twice = repo.incrementFailedAttempts(user.id);

    expect(twice.failedAttemptCount).toBe(2);
  });

  it('resetFailedAttempts clears the counter and any active lock', () => {
    const repo = new UserRepository(createDatabase(':memory:'));
    const user = repo.create({ name: 'Alice', role: 'administrator', code: '1111' });
    repo.incrementFailedAttempts(user.id);
    repo.lock(user.id, 300);

    const reset = repo.resetFailedAttempts(user.id);

    expect(reset.failedAttemptCount).toBe(0);
    expect(reset.lockedUntil).toBeNull();
  });

  it('lock sets lockedUntil roughly cooldownSeconds in the future', () => {
    const repo = new UserRepository(createDatabase(':memory:'));
    const user = repo.create({ name: 'Alice', role: 'administrator', code: '1111' });

    const before = Date.now();
    const locked = repo.lock(user.id, 300);

    expect(locked.lockedUntil).not.toBeNull();
    expect(locked.lockedUntil as number).toBeGreaterThanOrEqual(before + 300_000);
  });

  it('throws when mutating a user that does not exist', () => {
    const repo = new UserRepository(createDatabase(':memory:'));

    expect(() => repo.incrementFailedAttempts('missing-user')).toThrow(/not found/);
    expect(() => repo.resetFailedAttempts('missing-user')).toThrow(/not found/);
    expect(() => repo.lock('missing-user', 300)).toThrow(/not found/);
  });

  it('rejects an unknown role via the CHECK constraint', () => {
    const repo = new UserRepository(createDatabase(':memory:'));

    expect(() =>
      repo.create({ name: 'Mallory', role: 'superuser' as unknown as 'administrator', code: '6666' }),
    ).toThrow(/CHECK constraint failed/);
  });
});
