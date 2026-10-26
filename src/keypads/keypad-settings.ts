import { EventEmitter } from 'node:events';
import type Database from 'better-sqlite3';
import { Repository } from '../db/repository.js';

/** Keypad behaviour an administrator can change at runtime (contracts/keypads.md). */
export interface KeypadSettings {
  /** Whether arming from a keypad needs a valid user code. Disarming always does. */
  requireCodeToArm: boolean;
  /** Level (0-99) of the chirps the keypad plays when a sensor trips. Delay tones and the siren have their own. */
  volume: number;
}

export const DEFAULT_KEYPAD_VOLUME = 60;

export type KeypadSettingsUpdate = Partial<KeypadSettings>;

interface KeypadSettingsRow {
  id: string;
  require_code_to_arm: number | null;
  volume: number | null;
}

const SINGLETON_ID = 'settings';

/** The keypad_settings singleton row. A column that was never set reads as `undefined`, not a default. */
export class KeypadSettingsRepository extends Repository {
  constructor(db: Database.Database) {
    super(db);
  }

  getStored(): Partial<KeypadSettings> {
    const row = this.get<KeypadSettingsRow>('SELECT * FROM keypad_settings WHERE id = ?', SINGLETON_ID);
    return {
      ...(row?.require_code_to_arm != null && { requireCodeToArm: row.require_code_to_arm === 1 }),
      ...(row?.volume != null && { volume: row.volume }),
    };
  }

  store(changes: KeypadSettingsUpdate): void {
    if (changes.requireCodeToArm === undefined && changes.volume === undefined) {
      return;
    }
    this.run('INSERT OR IGNORE INTO keypad_settings (id) VALUES (?)', SINGLETON_ID);
    if (changes.requireCodeToArm !== undefined) {
      this.run('UPDATE keypad_settings SET require_code_to_arm = ? WHERE id = ?', changes.requireCodeToArm ? 1 : 0, SINGLETON_ID);
    }
    if (changes.volume !== undefined) {
      this.run('UPDATE keypad_settings SET volume = ? WHERE id = ?', changes.volume, SINGLETON_ID);
    }
  }
}

/**
 * The current keypad settings: what an administrator chose, else the environment defaults the
 * service started with. Emits `'settings_changed'` (KeypadSettings) when an update changes a value.
 */
export class KeypadSettingsService extends EventEmitter {
  constructor(
    private readonly repo: KeypadSettingsRepository,
    private readonly defaults: Omit<KeypadSettings, 'volume'> & Partial<Pick<KeypadSettings, 'volume'>>,
  ) {
    super();
  }

  get(): KeypadSettings {
    return { volume: DEFAULT_KEYPAD_VOLUME, ...this.defaults, ...this.repo.getStored() };
  }

  update(changes: KeypadSettingsUpdate): KeypadSettings {
    const before = this.get();
    this.repo.store(changes);
    const after = this.get();
    if (after.requireCodeToArm !== before.requireCodeToArm || after.volume !== before.volume) {
      this.emit('settings_changed', after);
    }
    return after;
  }
}
