import type Database from 'better-sqlite3';
import { Repository } from '../repository.js';
import type { LockEnrollmentStore } from '../../locks/lock-service.js';

/** Repository for the `enrolled_locks` table: the Z-Wave nodes added to the alarm system as locks. */
export class LockEnrollmentRepository extends Repository implements LockEnrollmentStore {
  constructor(db: Database.Database) {
    super(db);
  }

  isEnrolled(nodeId: number): boolean {
    return this.get('SELECT 1 FROM enrolled_locks WHERE zwave_node_id = ?', nodeId) !== undefined;
  }

  enroll(nodeId: number): void {
    this.run('INSERT OR IGNORE INTO enrolled_locks (zwave_node_id, enrolled_at) VALUES (?, ?)', nodeId, Date.now());
  }

  unenroll(nodeId: number): void {
    this.run('DELETE FROM enrolled_locks WHERE zwave_node_id = ?', nodeId);
  }
}
