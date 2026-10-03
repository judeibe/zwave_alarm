import type Database from 'better-sqlite3';
import { EventEmitter } from 'node:events';

/**
 * Shared query/transaction helpers for per-entity repositories (built in later
 * phases). Wraps better-sqlite3's prepared-statement API with typed
 * run/get/all methods so entity repositories don't each re-implement
 * prepare/bind/execute boilerplate.
 *
 * Extends EventEmitter so a repository can optionally notify listeners when
 * it persists a change (e.g. EventRepository emitting 'event_recorded' for
 * src/api/ws-broadcaster.ts, T029) without every repository needing its own
 * bespoke pub/sub wiring.
 */
export abstract class Repository extends EventEmitter {
  protected constructor(protected readonly db: Database.Database) {
    super();
  }

  protected run(sql: string, ...params: unknown[]): Database.RunResult {
    return this.db.prepare(sql).run(...params);
  }

  protected get<T = unknown>(sql: string, ...params: unknown[]): T | undefined {
    return this.db.prepare(sql).get(...params) as T | undefined;
  }

  protected all<T = unknown>(sql: string, ...params: unknown[]): T[] {
    return this.db.prepare(sql).all(...params) as T[];
  }

  /** Wraps `fn` so every statement it runs commits (or rolls back) atomically. */
  protected transaction<F extends (...args: never[]) => unknown>(fn: F): Database.Transaction<F> {
    return this.db.transaction(fn);
  }
}
