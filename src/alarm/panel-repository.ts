import type Database from 'better-sqlite3';
import { Repository } from '../db/repository.js';

export type AlarmMode = 'disarmed' | 'arming' | 'armed_away' | 'armed_home' | 'alarm_pending' | 'alarm_triggered';

export interface AlarmPanel {
  mode: AlarmMode;
  /** Set while mode is 'arming' or 'alarm_pending'; drives the countdown. */
  pendingDelayEndsAt: number | null;
  /** The SecurityEvent that caused the current alarm_triggered state, if any. */
  triggeredBy: string | null;
  updatedAt: number;
}

export type AlarmPanelUpdate = Partial<Omit<AlarmPanel, 'updatedAt'>>;

interface AlarmPanelRow {
  id: string;
  mode: AlarmMode;
  pending_delay_ends_at: number | null;
  triggered_by: string | null;
  updated_at: number;
}

const SINGLETON_ID = 'panel';

function toDomain(row: AlarmPanelRow): AlarmPanel {
  return {
    mode: row.mode,
    pendingDelayEndsAt: row.pending_delay_ends_at,
    triggeredBy: row.triggered_by,
    updatedAt: row.updated_at,
  };
}

/**
 * Repository for the alarm_panel singleton row (data-model.md's AlarmPanel
 * entity): the system's current arm/disarm/alarm state.
 *
 * Named getPanel()/updatePanel() rather than get()/update() because those
 * names would collide with Repository's own protected get() helper (a
 * different generic signature) and fail to compile as an override.
 */
export class AlarmPanelRepository extends Repository {
  constructor(db: Database.Database) {
    super(db);
  }

  /** Lazily creates the row in its default disarmed state on first access. */
  getPanel(): AlarmPanel {
    const row = this.get<AlarmPanelRow>('SELECT * FROM alarm_panel WHERE id = ?', SINGLETON_ID);
    if (row) {
      return toDomain(row);
    }

    const defaults: AlarmPanel = {
      mode: 'disarmed',
      pendingDelayEndsAt: null,
      triggeredBy: null,
      updatedAt: Date.now(),
    };
    this.run(
      'INSERT INTO alarm_panel (id, mode, pending_delay_ends_at, triggered_by, updated_at) VALUES (?, ?, ?, ?, ?)',
      SINGLETON_ID,
      defaults.mode,
      defaults.pendingDelayEndsAt,
      defaults.triggeredBy,
      defaults.updatedAt,
    );
    return defaults;
  }

  /** Merges `changes` onto the current state, stamps updatedAt, and persists. */
  updatePanel(changes: AlarmPanelUpdate): AlarmPanel {
    const current = this.getPanel();
    const next: AlarmPanel = {
      ...current,
      ...changes,
      updatedAt: Date.now(),
    };

    this.run(
      'UPDATE alarm_panel SET mode = ?, pending_delay_ends_at = ?, triggered_by = ?, updated_at = ? WHERE id = ?',
      next.mode,
      next.pendingDelayEndsAt,
      next.triggeredBy,
      next.updatedAt,
      SINGLETON_ID,
    );
    return next;
  }
}
