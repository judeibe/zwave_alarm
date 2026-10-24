import { EventEmitter } from 'node:events';
import type Database from 'better-sqlite3';
import { Repository } from '../db/repository.js';

/** Keypad behaviour an administrator can change at runtime (contracts/keypads.md). */
export interface KeypadSettings {
  /** Whether arming from a keypad needs a valid user code. Disarming always does. */
  requireCodeToArm: boolean;
}

export type KeypadSettingsUpdate = Partial<KeypadSettings>;

interface KeypadSettingsRow {
  id: string;
  require_code_to_arm: number | null;
}

const SINGLETON_ID = 'settings';

/** The keypad_settings singleton row. A column that was never set reads as `undefined`, not a default. */
export class KeypadSettingsRepository extends Repository {
  constructor(db: Database.Database) {
    super(db);
  }

  getStored(): Partial<KeypadSettings> {
    const row = this.get<KeypadSettingsRow>('SELECT * FROM keypad_settings WHERE id = ?', SINGLETON_ID);
    return row?.require_code_to_arm == null ? {} : { requireCodeToArm: row.require_code_to_arm === 1 };
  }

  store(changes: KeypadSettingsUpdate): void {
    if (changes.requireCodeToArm === undefined) {
      return;
    }
    this.run(
      `INSERT INTO keypad_settings (id, require_code_to_arm) VALUES (?, ?)
       ON CONFLICT(id) DO UPDATE SET require_code_to_arm = excluded.require_code_to_arm`,
      SINGLETON_ID,
      changes.requireCodeToArm ? 1 : 0,
    );
  }
}

/**
 * The current keypad settings: what an administrator chose, else the environment defaults the
 * service started with. Emits `'settings_changed'` (KeypadSettings) when an update changes a value.
 */
export class KeypadSettingsService extends EventEmitter {
  constructor(
    private readonly repo: KeypadSettingsRepository,
    private readonly defaults: KeypadSettings,
  ) {
    super();
  }

  get(): KeypadSettings {
    return { ...this.defaults, ...this.repo.getStored() };
  }

  update(changes: KeypadSettingsUpdate): KeypadSettings {
    const before = this.get();
    this.repo.store(changes);
    const after = this.get();
    if (after.requireCodeToArm !== before.requireCodeToArm) {
      this.emit('settings_changed', after);
    }
    return after;
  }
}
