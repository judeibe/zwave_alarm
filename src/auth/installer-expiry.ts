import { createLogger } from '../config/logger.js';
import type { User, UserRepository } from './user-repository.js';

const logger = createLogger('auth/installer-expiry');

const DEFAULT_INTERVAL_MS = 60_000;

/**
 * Removes installers whose 48 h access has ended (Ring spec, Timers: "auto-removed"). Runs once now, so an
 * installer who expired while the service was down goes at start-up, and then every minute. Returns a function
 * that stops it. Login, disarm and keypad checks also refuse an expired installer, so the account is unusable
 * from the moment its time is up; this just removes it.
 */
export function startInstallerExpirySweep(
  userRepo: UserRepository,
  options: { intervalMs?: number; now?: () => number; beforeRemove?: (user: User) => Promise<unknown> } = {},
): () => void {
  const now = options.now ?? Date.now;
  let sweeping = false;
  const sweep = async (): Promise<void> => {
    if (sweeping) {
      return;
    }
    sweeping = true;
    try {
      for (const user of userRepo.listExpiredInstallers(now())) {
        try {
          // Take the installer's code off the locks while the record of its slots still exists.
          const results = await options.beforeRemove?.(user);
          const failed = Array.isArray(results)
            ? (results as { nodeId: number; slot: number | null; status: string }[]).filter((entry) => entry.status === 'failed')
            : [];
          if (failed.length > 0) {
            // The account is removed regardless, and with it the record of where its code sits, so this line
            // is what says which lock slots to clear by hand.
            logger.warn('expired installer code could not be cleared from a lock', {
              userId: user.id,
              name: user.name,
              locks: failed.map((entry) => ({ nodeId: entry.nodeId, slot: entry.slot })),
            });
          }
        } catch (err) {
          logger.warn('could not clear an expired installer from the locks', {
            userId: user.id,
            error: err instanceof Error ? err.message : String(err),
          });
        }
        userRepo.delete(user.id);
        logger.info('installer access expired; account removed', { userId: user.id, name: user.name });
      }
    } finally {
      sweeping = false;
    }
  };
  void sweep();
  const timer = setInterval(() => void sweep(), options.intervalMs ?? DEFAULT_INTERVAL_MS);
  timer.unref();
  return () => clearInterval(timer);
}
