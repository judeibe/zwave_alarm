import type Database from 'better-sqlite3';
import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import { Repository } from '../db/repository.js';

export type UserRole = 'administrator' | 'member' | 'guest';

/** data-model.md's User (Household Member) entity. */
export interface User {
  id: string;
  name: string;
  role: UserRole;
  credentialHash: string;
  guestExpiresAt: number | null;
  guestZoneId: string | null;
  failedAttemptCount: number;
  lockedUntil: number | null;
  createdAt: number;
}

export interface CreateUserInput {
  name: string;
  role: UserRole;
  /** Plaintext disarm code/password; hashed into `credentialHash` before storage. */
  code: string;
  /** Only meaningful when `role: 'guest'`; ignored (stored as null) for administrator/member. */
  guestExpiresAt?: number | null;
  /** Only meaningful when `role: 'guest'`; ignored (stored as null) for administrator/member. */
  guestZoneId?: string | null;
}

interface UserRow {
  id: string;
  name: string;
  role: UserRole;
  credential_hash: string;
  guest_expires_at: number | null;
  guest_zone_id: string | null;
  failed_attempt_count: number;
  locked_until: number | null;
  created_at: number;
}

function toDomain(row: UserRow): User {
  return {
    id: row.id,
    name: row.name,
    role: row.role,
    credentialHash: row.credential_hash,
    guestExpiresAt: row.guest_expires_at,
    guestZoneId: row.guest_zone_id,
    failedAttemptCount: row.failed_attempt_count,
    lockedUntil: row.locked_until,
    createdAt: row.created_at,
  };
}

const SCRYPT_KEYLEN = 64;

/** Hashes a plaintext disarm code/password as `scrypt:<saltHex>:<hashHex>` for storage in `users.credential_hash`. */
export function hashCredential(code: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(code, salt, SCRYPT_KEYLEN);
  return `scrypt:${salt.toString('hex')}:${hash.toString('hex')}`;
}

/** Constant-time check of a plaintext code/password against a `hashCredential` digest. */
export function verifyCredential(code: string, credentialHash: string): boolean {
  const [scheme, saltHex, hashHex] = credentialHash.split(':');
  if (scheme !== 'scrypt' || saltHex === undefined || hashHex === undefined) {
    return false;
  }
  const expected = Buffer.from(hashHex, 'hex');
  const actual = scryptSync(code, Buffer.from(saltHex, 'hex'), expected.length);
  return timingSafeEqual(actual, expected);
}

/** Repository for the `users` table (data-model.md's User entity), supporting the three FR-010a roles. */
export class UserRepository extends Repository {
  constructor(db: Database.Database) {
    super(db);
  }

  /**
   * Creates a user, hashing `code` into `credentialHash`. Per data-model.md's
   * validation rule, a `guest` role requires `guestExpiresAt` and/or
   * `guestZoneId`; administrator/member roles ignore both fields.
   */
  create(input: CreateUserInput): User {
    if (input.role === 'guest' && input.guestExpiresAt == null && input.guestZoneId == null) {
      throw new Error('a guest user requires guestExpiresAt and/or guestZoneId');
    }

    const user: User = {
      id: randomUUID(),
      name: input.name,
      role: input.role,
      credentialHash: hashCredential(input.code),
      guestExpiresAt: input.role === 'guest' ? (input.guestExpiresAt ?? null) : null,
      guestZoneId: input.role === 'guest' ? (input.guestZoneId ?? null) : null,
      failedAttemptCount: 0,
      lockedUntil: null,
      createdAt: Date.now(),
    };
    this.run(
      `INSERT INTO users
         (id, name, role, credential_hash, guest_expires_at, guest_zone_id, failed_attempt_count, locked_until, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      user.id,
      user.name,
      user.role,
      user.credentialHash,
      user.guestExpiresAt,
      user.guestZoneId,
      user.failedAttemptCount,
      user.lockedUntil,
      user.createdAt,
    );
    return user;
  }

  /**
   * Finds the user whose credential matches `code`. Login (contracts/rest-api.md's
   * `POST /api/v1/auth/login`) identifies a user by code alone, so this scans every
   * row and verifies each hash rather than looking one up by a WHERE clause — each
   * `credentialHash` embeds its own random salt (see `hashCredential`) so identical
   * codes don't produce identical stored hashes. Lock/expiry/zone-restriction checks
   * are left to the caller (T025's lockout service, T027's disarm route).
   */
  findByCode(code: string): User | undefined {
    const match = this.all<UserRow>('SELECT * FROM users').find((row) =>
      verifyCredential(code, row.credential_hash),
    );
    return match ? toDomain(match) : undefined;
  }

  list(): User[] {
    return this.all<UserRow>('SELECT * FROM users ORDER BY created_at ASC').map(toDomain);
  }

  delete(id: string): void {
    this.run('DELETE FROM users WHERE id = ?', id);
  }

  private getOrThrow(id: string): UserRow {
    const row = this.get<UserRow>('SELECT * FROM users WHERE id = ?', id);
    if (!row) {
      throw new Error(`user ${id} not found`);
    }
    return row;
  }

  /** Increments `failedAttemptCount` by one, e.g. on a wrong disarm code (FR-016). */
  incrementFailedAttempts(id: string): User {
    const row = this.getOrThrow(id);
    const failedAttemptCount = row.failed_attempt_count + 1;
    this.run('UPDATE users SET failed_attempt_count = ? WHERE id = ?', failedAttemptCount, id);
    return toDomain({ ...row, failed_attempt_count: failedAttemptCount });
  }

  /** Clears `failedAttemptCount` and any active `lockedUntil`, e.g. after a successful disarm. */
  resetFailedAttempts(id: string): User {
    const row = this.getOrThrow(id);
    this.run('UPDATE users SET failed_attempt_count = 0, locked_until = NULL WHERE id = ?', id);
    return toDomain({ ...row, failed_attempt_count: 0, locked_until: null });
  }

  /** Locks the user out for `cooldownSeconds` from now (FR-016's default `lockout` mode). */
  lock(id: string, cooldownSeconds: number): User {
    const row = this.getOrThrow(id);
    const lockedUntil = Date.now() + cooldownSeconds * 1000;
    this.run('UPDATE users SET locked_until = ? WHERE id = ?', lockedUntil, id);
    return toDomain({ ...row, locked_until: lockedUntil });
  }
}
