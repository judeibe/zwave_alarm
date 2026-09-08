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
