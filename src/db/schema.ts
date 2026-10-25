import Database from 'better-sqlite3';

/**
 * Timestamps are stored as Unix epoch milliseconds (INTEGER) throughout —
 * cheap to sort/compare in SQLite; repositories convert to ISO strings at the API boundary.
 */

interface Migration {
  id: string;
  sql: string;
}

// Table creation order respects FOREIGN KEY targets (a table must be created
// before anything that references it), per data-model.md's entity relationships.
const MIGRATIONS: Migration[] = [
  {
    id: '001_init',
    sql: `
      CREATE TABLE zones (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE users (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('administrator', 'member', 'guest')),
        credential_hash TEXT NOT NULL,
        guest_expires_at INTEGER,
        guest_zone_id TEXT REFERENCES zones(id),
        failed_attempt_count INTEGER NOT NULL DEFAULT 0,
        locked_until INTEGER,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE sensor_devices (
        id TEXT PRIMARY KEY,
        zwave_node_id INTEGER NOT NULL,
        zone_id TEXT NOT NULL REFERENCES zones(id),
        name TEXT NOT NULL,
        category TEXT NOT NULL CHECK (category IN ('intrusion', 'life-safety')),
        current_state TEXT NOT NULL CHECK (current_state IN ('normal', 'breached')),
        battery_level INTEGER,
        connectivity_status TEXT NOT NULL CHECK (connectivity_status IN ('online', 'offline')),
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE security_events (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL CHECK (type IN (
          'armed', 'disarmed', 'breach', 'alarm_triggered', 'alarm_cleared',
          'device_fault', 'lockout', 'guest_code_used'
        )),
        source TEXT NOT NULL CHECK (source IN ('user', 'home_assistant', 'system')),
        source_user_id TEXT REFERENCES users(id),
        related_zone_id TEXT REFERENCES zones(id),
        related_sensor_id TEXT REFERENCES sensor_devices(id),
        details TEXT,
        occurred_at INTEGER NOT NULL
      );

      CREATE TABLE alarm_panel (
        id TEXT PRIMARY KEY CHECK (id = 'panel'),
        mode TEXT NOT NULL CHECK (mode IN (
          'disarmed', 'arming', 'armed_away', 'armed_home', 'alarm_pending', 'alarm_triggered'
        )),
        pending_delay_ends_at INTEGER,
        triggered_by TEXT REFERENCES security_events(id),
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE lockout_policy (
        id TEXT PRIMARY KEY CHECK (id = 'policy'),
        failed_attempt_threshold INTEGER NOT NULL DEFAULT 5,
        cooldown_seconds INTEGER NOT NULL DEFAULT 300,
        on_threshold_exceeded TEXT NOT NULL CHECK (on_threshold_exceeded IN ('lockout', 'trigger_alarm'))
          DEFAULT 'lockout'
      );

      CREATE TABLE ha_links (
        id TEXT PRIMARY KEY,
        api_token_hash TEXT NOT NULL,
        label TEXT NOT NULL,
        connection_status TEXT NOT NULL CHECK (connection_status IN ('connected', 'disconnected')),
        last_seen_at INTEGER,
        created_at INTEGER NOT NULL,
        user_id TEXT NOT NULL REFERENCES users(id)
      );

      CREATE INDEX idx_sensor_devices_zone_id ON sensor_devices(zone_id);
      CREATE INDEX idx_security_events_occurred_at ON security_events(occurred_at);
      CREATE INDEX idx_ha_links_user_id ON ha_links(user_id);
    `,
  },
  {
    // The mode the panel is armed (or arming) towards. Without it a restart during the exit delay
    // can't tell armed_away from armed_home, and an alarm clearing back to "armed" can't either.
    id: '002_panel_armed_mode',
    sql: `
      ALTER TABLE alarm_panel ADD COLUMN armed_mode TEXT
        CHECK (armed_mode IN ('armed_away', 'armed_home'));
    `,
  },
  {
    // Zones a zone-restricted guest has disarmed while the panel as a whole stays armed (FR-010a).
    // Cleared whenever the panel is fully disarmed or armed again.
    id: '003_panel_disarmed_zones',
    sql: `
      CREATE TABLE panel_disarmed_zones (
        zone_id TEXT PRIMARY KEY REFERENCES zones(id) ON DELETE CASCADE,
        disarmed_at INTEGER NOT NULL,
        disarmed_by TEXT REFERENCES users(id) ON DELETE SET NULL
      );
    `,
  },
  {
    // Configuration panel (contracts/config-panel-api.md): zone description, the HA person/user a
    // service user is linked to, and users that exist before a code is set (credential_hash = '',
    // which verifyCredential never matches).
    id: '004_config_panel',
    sql: `
      ALTER TABLE zones ADD COLUMN description TEXT;
      ALTER TABLE users ADD COLUMN ha_person_id TEXT;
      ALTER TABLE users ADD COLUMN ha_user_id TEXT;
      CREATE UNIQUE INDEX idx_users_ha_person_id ON users(ha_person_id) WHERE ha_person_id IS NOT NULL;
    `,
  },
  {
    // Keypad behaviour an administrator can change at runtime. NULL means "not chosen yet": the
    // service falls back to its KEYPAD_REQUIRE_CODE_TO_ARM environment default.
    id: '005_keypad_settings',
    sql: `
      CREATE TABLE keypad_settings (
        id TEXT PRIMARY KEY CHECK (id = 'settings'),
        require_code_to_arm INTEGER CHECK (require_code_to_arm IN (0, 1))
      );
    `,
  },
  {
    // Z-Wave locks an administrator has added to the alarm system. A Schlage lock that is merely
    // paired with the controller is not listed here and is never exposed to clients.
    id: '006_enrolled_locks',
    sql: `
      CREATE TABLE enrolled_locks (
        zwave_node_id INTEGER PRIMARY KEY,
        enrolled_at INTEGER NOT NULL
      );
    `,
  },
  {
    // Ring spec phase 1: where a sensor sits (decides entry delay vs instant alarm), which armed modes it
    // covers, and per-mode entry/exit delays. Existing intrusion sensors become MAIN_DOOR, armed in both
    // modes, which is how they behaved before (every intrusion sensor got the entry delay).
    id: '007_placements_and_mode_config',
    sql: `
      ALTER TABLE sensor_devices ADD COLUMN placement TEXT
        CHECK (placement IN ('MAIN_DOOR', 'SECONDARY_DOOR', 'WINDOW', 'ENTRYWAY', 'ROOM', 'GLASS_BREAK'));
      ALTER TABLE sensor_devices ADD COLUMN armed_home INTEGER NOT NULL DEFAULT 1 CHECK (armed_home IN (0, 1));
      ALTER TABLE sensor_devices ADD COLUMN armed_away INTEGER NOT NULL DEFAULT 1 CHECK (armed_away IN (0, 1));
      ALTER TABLE sensor_devices ADD COLUMN alerts_only INTEGER NOT NULL DEFAULT 0 CHECK (alerts_only IN (0, 1));
      UPDATE sensor_devices SET placement = 'MAIN_DOOR' WHERE category = 'intrusion';

      CREATE TABLE mode_config (
        mode TEXT PRIMARY KEY CHECK (mode IN ('armed_home', 'armed_away')),
        entry_delay_sec INTEGER NOT NULL CHECK (entry_delay_sec BETWEEN 0 AND 180),
        exit_delay_sec INTEGER NOT NULL CHECK (exit_delay_sec BETWEEN 0 AND 180)
      );
    `,
  },
  {
    // The arm session's bypassed sensors (Ring spec, Arming): set when arming starts, cleared on disarm.
    id: '008_panel_bypassed_devices',
    sql: `
      ALTER TABLE alarm_panel ADD COLUMN bypassed_device_ids TEXT NOT NULL DEFAULT '[]';
    `,
  },
  {
    // Ring spec phase 3: alarm events with their siren and monitoring-dispatch lifecycle, and which kind of
    // life-safety event a life-safety sensor raises (smoke, CO or flood/freeze).
    id: '009_alarm_events',
    sql: `
      CREATE TABLE alarm_events (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL CHECK (type IN (
          'BURGLARY', 'SMOKE', 'CO', 'PANIC', 'FIRE_MEDICAL', 'DURESS', 'SOS', 'FLOOD_FREEZE'
        )),
        service TEXT CHECK (service IN ('police', 'fire', 'medical')),
        trigger_device_id TEXT,
        started_at INTEGER NOT NULL,
        siren_state TEXT NOT NULL CHECK (siren_state IN ('none', 'sounding', 'silenced', 'timed_out', 'stopped')),
        dispatch_state TEXT NOT NULL CHECK (dispatch_state IN ('none', 'held', 'queued', 'cancelled')),
        dispatch_release_at INTEGER,
        cancelled_at INTEGER,
        ended_at INTEGER,
        details TEXT
      );
      CREATE INDEX idx_alarm_events_started_at ON alarm_events(started_at);

      ALTER TABLE sensor_devices ADD COLUMN alarm_kind TEXT CHECK (alarm_kind IN ('SMOKE', 'CO', 'FLOOD_FREEZE'));
      UPDATE sensor_devices SET alarm_kind = 'SMOKE' WHERE category = 'life-safety';
    `,
  },
];

function ensureMigrationsTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      applied_at INTEGER NOT NULL
    )
  `);
}

/** Applies any migrations from MIGRATIONS not yet recorded in schema_migrations. Idempotent. */
export function runMigrations(db: Database.Database): void {
  ensureMigrationsTable(db);

  const appliedIds = new Set(
    (db.prepare('SELECT id FROM schema_migrations').all() as { id: string }[]).map((row) => row.id),
  );
  const pending = MIGRATIONS.filter((migration) => !appliedIds.has(migration.id));
  if (pending.length === 0) {
    return;
  }

  const recordMigration = db.prepare('INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)');
  const applyPending = db.transaction(() => {
    for (const migration of pending) {
      db.exec(migration.sql);
      recordMigration.run(migration.id, Date.now());
    }
  });
  applyPending();
}

/**
 * Opens a database at `dbPath` and runs any pending migrations before returning it —
 * this is the "wire schema creation to run on startup" hook: callers (the startup
 * bootstrap wired in later tasks, or a repository/test) just call this with
 * config.dbPath and get a ready, up-to-date database back.
 */
export function createDatabase(dbPath: string): Database.Database {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}
