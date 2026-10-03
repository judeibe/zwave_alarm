import session, { type SessionData } from 'express-session';

interface Entry {
  data: string;
  expiresAt: number;
}

const DEFAULT_PRUNE_INTERVAL_MS = 15 * 60 * 1000;

/**
 * In-process session store that actually drops expired sessions.
 *
 * express-session's bundled `MemoryStore` only discards an expired session
 * when that same session id is looked up again, so abandoned logins pile up
 * forever, and it prints a non-JSON "not designed for a production
 * environment" warning on boot whenever one is in use. This service is a
 * single process for a single household and only creates a session after a
 * successful login, so in-memory storage is a fine fit (sessions are lost on
 * restart, which only means logging in again — Home Assistant uses bearer
 * tokens and is unaffected); what it needs is expiry, which this adds.
 */
export class ExpiringSessionStore extends session.Store {
  private readonly entries = new Map<string, Entry>();
  private readonly pruneTimer: NodeJS.Timeout;

  constructor(pruneIntervalMs: number = DEFAULT_PRUNE_INTERVAL_MS) {
    super();
    this.pruneTimer = setInterval(() => this.prune(), pruneIntervalMs);
    this.pruneTimer.unref(); // never keep the process alive just to prune
  }

  get(sid: string, callback: (err?: unknown, session?: SessionData | null) => void): void {
    const entry = this.entries.get(sid);
    if (entry === undefined) {
      callback(null, null);
    } else if (entry.expiresAt <= Date.now()) {
      this.entries.delete(sid);
      callback(null, null);
    } else {
      callback(null, JSON.parse(entry.data) as SessionData);
    }
  }

  set(sid: string, data: SessionData, callback?: (err?: unknown) => void): void {
    this.entries.set(sid, { data: JSON.stringify(data), expiresAt: expiryOf(data) });
    callback?.();
  }

  touch(sid: string, data: SessionData, callback?: () => void): void {
    const entry = this.entries.get(sid);
    if (entry !== undefined) {
      entry.expiresAt = expiryOf(data);
    }
    callback?.();
  }

  destroy(sid: string, callback?: (err?: unknown) => void): void {
    this.entries.delete(sid);
    callback?.();
  }

  /** Number of stored sessions, including any not yet pruned (for tests/diagnostics). */
  get size(): number {
    return this.entries.size;
  }

  /** Removes every expired session. Runs on a timer; exposed for tests. */
  prune(now: number = Date.now()): void {
    for (const [sid, entry] of this.entries) {
      if (entry.expiresAt <= now) {
        this.entries.delete(sid);
      }
    }
  }
}

/** express-session serializes `cookie.expires`; a session with none is treated as already expired so it can't live forever. */
function expiryOf(data: SessionData): number {
  const expires = data.cookie.expires;
  return expires === undefined || expires === null ? 0 : new Date(expires).getTime();
}
