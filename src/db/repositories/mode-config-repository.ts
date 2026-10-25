import type Database from 'better-sqlite3';
import { Repository } from '../repository.js';
import type { ArmedMode } from '../../alarm/panel-repository.js';

/** Entry and exit delay for one armed mode (Ring spec, Timers): whole seconds, 0-180. */
export interface ModeDelays {
  entryDelaySec: number;
  exitDelaySec: number;
}

export type ModeConfig = Record<ArmedMode, ModeDelays>;

export const MODE_DELAY_MIN_SEC = 0;
export const MODE_DELAY_MAX_SEC = 180;
export const DEFAULT_MODE_DELAY_SEC = 60;

interface ModeConfigRow {
  mode: ArmedMode;
  entry_delay_sec: number;
  exit_delay_sec: number;
}

const MODES: ArmedMode[] = ['armed_home', 'armed_away'];

/** Repository for the `mode_config` table: one row per armed mode (the spec's ModeConfig). */
export class ModeConfigRepository extends Repository {
  constructor(db: Database.Database) {
    super(db);
  }

  /**
   * Creates the two rows if they are missing. `seed` supplies the first-run values (the legacy
   * EXIT_DELAY_SECONDS / ENTRY_DELAY_SECONDS env vars); anything it leaves out defaults to 60 s.
   * Existing rows are never touched, so the env vars only matter once.
   */
  ensureSeeded(seed: Partial<ModeDelays> = {}): void {
    const insert = this.db.prepare(
      'INSERT OR IGNORE INTO mode_config (mode, entry_delay_sec, exit_delay_sec) VALUES (?, ?, ?)',
    );
    for (const mode of MODES) {
      insert.run(mode, seed.entryDelaySec ?? DEFAULT_MODE_DELAY_SEC, seed.exitDelaySec ?? DEFAULT_MODE_DELAY_SEC);
    }
  }

  getAll(): ModeConfig {
    const rows = this.all<ModeConfigRow>('SELECT * FROM mode_config');
    const config = {} as ModeConfig;
    for (const mode of MODES) {
      const row = rows.find((candidate) => candidate.mode === mode);
      config[mode] = {
        entryDelaySec: row?.entry_delay_sec ?? DEFAULT_MODE_DELAY_SEC,
        exitDelaySec: row?.exit_delay_sec ?? DEFAULT_MODE_DELAY_SEC,
      };
    }
    return config;
  }

  getMode(mode: ArmedMode): ModeDelays {
    return this.getAll()[mode];
  }

  /** Applies a partial change per mode and returns the full config. */
  update(changes: Partial<Record<ArmedMode, Partial<ModeDelays>>>): ModeConfig {
    this.transaction(() => {
      this.ensureSeeded();
      const current = this.getAll();
      for (const mode of MODES) {
        const change = changes[mode];
        if (!change) {
          continue;
        }
        this.run(
          'UPDATE mode_config SET entry_delay_sec = ?, exit_delay_sec = ? WHERE mode = ?',
          change.entryDelaySec ?? current[mode].entryDelaySec,
          change.exitDelaySec ?? current[mode].exitDelaySec,
          mode,
        );
      }
    })();
    return this.getAll();
  }
}
