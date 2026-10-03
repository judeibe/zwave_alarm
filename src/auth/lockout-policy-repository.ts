import type Database from 'better-sqlite3';
import { Repository } from '../db/repository.js';

export type LockoutAction = 'lockout' | 'trigger_alarm';

export interface LockoutPolicy {
  failedAttemptThreshold: number;
  cooldownSeconds: number;
  onThresholdExceeded: LockoutAction;
}

export type LockoutPolicyUpdate = Partial<LockoutPolicy>;

interface LockoutPolicyRow {
  id: string;
  failed_attempt_threshold: number;
  cooldown_seconds: number;
  on_threshold_exceeded: LockoutAction;
}

const SINGLETON_ID = 'policy';

const DEFAULTS: LockoutPolicy = {
  failedAttemptThreshold: 5,
  cooldownSeconds: 300,
  onThresholdExceeded: 'lockout',
};

function toDomain(row: LockoutPolicyRow): LockoutPolicy {
  return {
    failedAttemptThreshold: row.failed_attempt_threshold,
    cooldownSeconds: row.cooldown_seconds,
    onThresholdExceeded: row.on_threshold_exceeded,
  };
}

/**
 * Repository for the lockout_policy singleton row (data-model.md's
 * LockoutPolicy entity): the administrator-configurable failed-disarm-attempt
 * response used by T025's lockout service.
 *
 * Named getPolicy()/updatePolicy() rather than get()/update() — those names
 * collide with Repository's own protected generic get() helper and fail to
 * compile as an override (confirmed via tsc; same issue T017's
 * AlarmPanelRepository hit and documented). Unlike AlarmPanelRepository,
 * this row's columns already carry DB-level defaults (schema.ts), so an
 * insert with no explicit values reproduces DEFAULTS.
 */
export class LockoutPolicyRepository extends Repository {
  constructor(db: Database.Database) {
    super(db);
  }

  /** Lazily creates the row with its documented defaults on first access. */
  getPolicy(): LockoutPolicy {
    const row = this.get<LockoutPolicyRow>('SELECT * FROM lockout_policy WHERE id = ?', SINGLETON_ID);
    if (row) {
      return toDomain(row);
    }

    this.run('INSERT INTO lockout_policy (id) VALUES (?)', SINGLETON_ID);
    return { ...DEFAULTS };
  }

  /** Merges `changes` onto the current policy and persists. */
  updatePolicy(changes: LockoutPolicyUpdate): LockoutPolicy {
    const current = this.getPolicy();
    const next: LockoutPolicy = { ...current, ...changes };

    this.run(
      'UPDATE lockout_policy SET failed_attempt_threshold = ?, cooldown_seconds = ?, on_threshold_exceeded = ? WHERE id = ?',
      next.failedAttemptThreshold,
      next.cooldownSeconds,
      next.onThresholdExceeded,
      SINGLETON_ID,
    );
    return next;
  }
}
