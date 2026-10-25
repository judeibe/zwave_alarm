import type Database from 'better-sqlite3';
import { Repository } from '../db/repository.js';

export type LockAction = 'lock' | 'unlock';
export type LockModeKey = 'disarmed' | 'armed_home' | 'armed_away';

/**
 * What an enrolled lock does with the alarm (Ring spec, Locks). `armOnLockWithCode` and `armOnOneTouch` arm AWAY
 * when the lock is locked with an app-created code or with its one-touch button; `disarmOnUnlock` disarms when it
 * is unlocked with an app-created code; `actions` locks or unlocks the lock when the panel enters a mode.
 */
export interface LockModeSettings {
  armOnLockWithCode: boolean;
  armOnOneTouch: boolean;
  disarmOnUnlock: boolean;
  actions: Record<LockModeKey, LockAction | null>;
}

export const DEFAULT_LOCK_MODE_SETTINGS: LockModeSettings = {
  armOnLockWithCode: false,
  armOnOneTouch: false,
  disarmOnUnlock: false,
  actions: { disarmed: null, armed_home: null, armed_away: null },
};

interface Row {
  node_id: number;
  arm_on_lock_with_code: number;
  arm_on_one_touch: number;
  disarm_on_unlock: number;
  action_disarmed: LockAction | null;
  action_armed_home: LockAction | null;
  action_armed_away: LockAction | null;
}

function toDomain(row: Row): LockModeSettings {
  return {
    armOnLockWithCode: row.arm_on_lock_with_code === 1,
    armOnOneTouch: row.arm_on_one_touch === 1,
    disarmOnUnlock: row.disarm_on_unlock === 1,
    actions: { disarmed: row.action_disarmed, armed_home: row.action_armed_home, armed_away: row.action_armed_away },
  };
}

/** Repository for the `lock_mode_settings` table. A lock with no row has the defaults (everything off). */
export class LockModeSettingsRepository extends Repository {
  constructor(db: Database.Database) {
    super(db);
  }

  forNode(nodeId: number): LockModeSettings {
    const row = this.get<Row>('SELECT * FROM lock_mode_settings WHERE node_id = ?', nodeId);
    return row ? toDomain(row) : { ...DEFAULT_LOCK_MODE_SETTINGS, actions: { ...DEFAULT_LOCK_MODE_SETTINGS.actions } };
  }

  /** Merges a partial change onto the lock's settings and returns the result. */
  update(
    nodeId: number,
    changes: Partial<Omit<LockModeSettings, 'actions'>> & { actions?: Partial<LockModeSettings['actions']> },
  ): LockModeSettings {
    const current = this.forNode(nodeId);
    const next: LockModeSettings = {
      armOnLockWithCode: changes.armOnLockWithCode ?? current.armOnLockWithCode,
      armOnOneTouch: changes.armOnOneTouch ?? current.armOnOneTouch,
      disarmOnUnlock: changes.disarmOnUnlock ?? current.disarmOnUnlock,
      actions: { ...current.actions, ...changes.actions },
    };
    this.run(
      `INSERT INTO lock_mode_settings
         (node_id, arm_on_lock_with_code, arm_on_one_touch, disarm_on_unlock, action_disarmed, action_armed_home, action_armed_away)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(node_id) DO UPDATE SET
         arm_on_lock_with_code = excluded.arm_on_lock_with_code, arm_on_one_touch = excluded.arm_on_one_touch,
         disarm_on_unlock = excluded.disarm_on_unlock, action_disarmed = excluded.action_disarmed,
         action_armed_home = excluded.action_armed_home, action_armed_away = excluded.action_armed_away`,
      nodeId,
      next.armOnLockWithCode ? 1 : 0,
      next.armOnOneTouch ? 1 : 0,
      next.disarmOnUnlock ? 1 : 0,
      next.actions.disarmed,
      next.actions.armed_home,
      next.actions.armed_away,
    );
    return next;
  }

  delete(nodeId: number): void {
    this.run('DELETE FROM lock_mode_settings WHERE node_id = ?', nodeId);
  }
}
