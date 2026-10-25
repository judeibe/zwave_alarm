import { createLogger } from '../config/logger.js';
import type { LockCodeSlotRepository, LockSyncStatus } from './lock-code-slots.js';
import type { LockService } from './lock-service.js';

const logger = createLogger('locks/code-sync');

/** The outcome for one enrolled lock when a user's code is pushed or cleared. */
export interface LockSyncResult {
  nodeId: number;
  slot: number | null;
  status: LockSyncStatus;
  /** Why it failed; absent when it synced. */
  message?: string;
}

/**
 * Keeps each enrolled lock's user codes in step with the codes created in the app (Ring spec, Locks:
 * "codes are pushed from the base station to the lock"). A code is only ever known in plaintext while it is
 * being created or changed, so that is the one moment it can be pushed; codes that already existed stay off
 * the locks until they are set again. Duress codes are never pushed. A lock that cannot be reached or refuses
 * the code is reported as `failed` and not retried.
 */
export class LockCodeSync {
  constructor(
    private readonly locks: LockService,
    private readonly slots: LockCodeSlotRepository,
  ) {}

  /** Writes `code` to this user's slot on every enrolled lock, choosing a free slot the first time. */
  async push(userId: string, code: string): Promise<LockSyncResult[]> {
    const results: LockSyncResult[] = [];
    for (const lock of this.locks.list()) {
      results.push(await this.pushTo(lock.nodeId, userId, code));
    }
    return results;
  }

  /** Clears this user's slot on every lock that holds one (the code was removed, or the account ended). */
  async clear(userId: string): Promise<LockSyncResult[]> {
    const results: LockSyncResult[] = [];
    for (const slot of this.slots.forUser(userId)) {
      try {
        if (this.locks.isEnrolled(slot.nodeId)) {
          await this.locks.clearUserCode(slot.nodeId, slot.slot);
        }
        this.slots.delete(slot.nodeId, userId);
        results.push({ nodeId: slot.nodeId, slot: slot.slot, status: 'synced' });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.warn('could not clear a lock slot', { nodeId: slot.nodeId, slot: slot.slot, error: message });
        this.slots.upsert(slot.nodeId, userId, slot.slot, 'failed');
        results.push({ nodeId: slot.nodeId, slot: slot.slot, status: 'failed', message });
      }
    }
    return results;
  }

  private async pushTo(nodeId: number, userId: string, code: string): Promise<LockSyncResult> {
    let slot: number | null = this.slots.find(nodeId, userId)?.slot ?? null;
    try {
      slot ??= await this.freeSlot(nodeId);
      await this.locks.setUserCode(nodeId, slot, code);
      this.slots.upsert(nodeId, userId, slot, 'synced');
      return { nodeId, slot, status: 'synced' };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn('could not push a code to a lock', { nodeId, slot, error: message });
      if (slot !== null) {
        this.slots.upsert(nodeId, userId, slot, 'failed');
      }
      return { nodeId, slot, status: 'failed', message };
    }
  }

  /** The lowest slot that neither holds a code on the lock nor belongs to another app user. */
  private async freeSlot(nodeId: number): Promise<number> {
    const taken = new Set(this.slots.forNode(nodeId).map((entry) => entry.slot));
    const free = (await this.locks.listUsers(nodeId)).find((slot) => slot.status === 'available' && !taken.has(slot.userId));
    if (!free) {
      throw new Error('The lock has no free user slot.');
    }
    return free.userId;
  }
}
