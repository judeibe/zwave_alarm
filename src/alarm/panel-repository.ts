import type Database from 'better-sqlite3';
import { Repository } from '../db/repository.js';

export type ArmedMode = 'armed_away' | 'armed_home';

export type AlarmMode = 'disarmed' | 'arming' | 'armed_away' | 'armed_home' | 'alarm_pending' | 'alarm_triggered';

export interface AlarmPanel {
  mode: AlarmMode;
  /** Set while mode is 'arming' or 'alarm_pending'; drives the countdown. */
  pendingDelayEndsAt: number | null;
  /** The SecurityEvent that caused the current alarm_triggered state, if any. */
  triggeredBy: string | null;
  /**
   * The armed mode the panel is in or heading to: set when arming begins and kept through
   * `alarm_pending`/`alarm_triggered`, null once disarmed (or if an alarm fires while disarmed,
   * e.g. a life-safety sensor). Persisted so a restart can resume the exit delay faithfully.
   */
  armedMode: ArmedMode | null;
  /**
   * Zones a zone-restricted guest has disarmed while the panel as a whole stays armed (FR-010a):
   * intrusion breaches in these zones are ignored until the panel is next fully disarmed or armed.
   * Life-safety sensors are never bypassed (FR-015).
   */
  disarmedZoneIds: string[];
  updatedAt: number;
}

export type AlarmPanelUpdate = Partial<Omit<AlarmPanel, 'updatedAt' | 'disarmedZoneIds'>>;

interface AlarmPanelRow {
  id: string;
  mode: AlarmMode;
  pending_delay_ends_at: number | null;
  triggered_by: string | null;
  armed_mode: ArmedMode | null;
  updated_at: number;
}

const SINGLETON_ID = 'panel';

function toDomain(row: AlarmPanelRow, disarmedZoneIds: string[]): AlarmPanel {
  return {
    mode: row.mode,
    pendingDelayEndsAt: row.pending_delay_ends_at,
    triggeredBy: row.triggered_by,
    armedMode: row.armed_mode,
    disarmedZoneIds,
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
      return toDomain(row, this.listDisarmedZoneIds());
    }

    const defaults: AlarmPanel = {
      mode: 'disarmed',
      pendingDelayEndsAt: null,
      triggeredBy: null,
      armedMode: null,
      disarmedZoneIds: [],
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
      `UPDATE alarm_panel
         SET mode = ?, pending_delay_ends_at = ?, triggered_by = ?, armed_mode = ?, updated_at = ?
       WHERE id = ?`,
      next.mode,
      next.pendingDelayEndsAt,
      next.triggeredBy,
      next.armedMode,
      next.updatedAt,
      SINGLETON_ID,
    );
    return next;
  }

  /** Ids of the zones currently disarmed while the panel is armed, oldest first. */
  listDisarmedZoneIds(): string[] {
    return this.all<{ zone_id: string }>('SELECT zone_id FROM panel_disarmed_zones ORDER BY disarmed_at ASC, zone_id ASC').map(
      (row) => row.zone_id,
    );
  }

  /** Marks `zoneId` disarmed (idempotent). Throws on an unknown zone (foreign key). */
  addDisarmedZone(zoneId: string, userId: string | null): void {
    this.run(
      'INSERT OR IGNORE INTO panel_disarmed_zones (zone_id, disarmed_at, disarmed_by) VALUES (?, ?, ?)',
      zoneId,
      Date.now(),
      userId,
    );
  }

  /** Forgets every zone-level disarm, e.g. when the panel is fully disarmed or armed again. */
  clearDisarmedZones(): void {
    this.run('DELETE FROM panel_disarmed_zones');
  }
}
