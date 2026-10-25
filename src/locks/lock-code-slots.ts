import type Database from 'better-sqlite3';
import { Repository } from '../db/repository.js';

export type LockSyncStatus = 'synced' | 'failed';

/** Which lock slot holds which user's code, and whether the lock accepted it. */
export interface LockCodeSlot {
  nodeId: number;
  userId: string;
  slot: number;
  status: LockSyncStatus;
  updatedAt: number;
}

interface Row {
  node_id: number;
  user_id: string;
  slot: number;
  status: LockSyncStatus;
  updated_at: number;
}

function toDomain(row: Row): LockCodeSlot {
  return { nodeId: row.node_id, userId: row.user_id, slot: row.slot, status: row.status, updatedAt: row.updated_at };
}

/**
 * Repository for the `lock_code_slots` table. Only codes created in the app are in it, so a code someone
 * programmed on the lock itself is never mistaken for one that may arm or disarm (Ring spec, Locks).
 */
export class LockCodeSlotRepository extends Repository {
  constructor(db: Database.Database) {
    super(db);
  }

  forUser(userId: string): LockCodeSlot[] {
    return this.all<Row>('SELECT * FROM lock_code_slots WHERE user_id = ? ORDER BY node_id', userId).map(toDomain);
  }

  forNode(nodeId: number): LockCodeSlot[] {
    return this.all<Row>('SELECT * FROM lock_code_slots WHERE node_id = ? ORDER BY slot', nodeId).map(toDomain);
  }

  find(nodeId: number, userId: string): LockCodeSlot | undefined {
    const row = this.get<Row>('SELECT * FROM lock_code_slots WHERE node_id = ? AND user_id = ?', nodeId, userId);
    return row ? toDomain(row) : undefined;
  }

  /** The user whose code was pushed to `slot` on the lock, if it synced. */
  findUserBySlot(nodeId: number, slot: number): string | undefined {
    return this.get<{ user_id: string }>(
      "SELECT user_id FROM lock_code_slots WHERE node_id = ? AND slot = ? AND status = 'synced'",
      nodeId,
      slot,
    )?.user_id;
  }

  upsert(nodeId: number, userId: string, slot: number, status: LockSyncStatus): LockCodeSlot {
    const updatedAt = Date.now();
    this.run(
      `INSERT INTO lock_code_slots (node_id, user_id, slot, status, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(node_id, user_id) DO UPDATE SET slot = excluded.slot, status = excluded.status, updated_at = excluded.updated_at`,
      nodeId,
      userId,
      slot,
      status,
      updatedAt,
    );
    return { nodeId, userId, slot, status, updatedAt };
  }

  delete(nodeId: number, userId: string): void {
    this.run('DELETE FROM lock_code_slots WHERE node_id = ? AND user_id = ?', nodeId, userId);
  }

  deleteForNode(nodeId: number): void {
    this.run('DELETE FROM lock_code_slots WHERE node_id = ?', nodeId);
  }
}
