import { createLogger } from '../config/logger.js';
import type { UserRepository } from './user-repository.js';

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
  options: { intervalMs?: number; now?: () => number } = {},
): () => void {
  const now = options.now ?? Date.now;
  const sweep = (): void => {
    for (const user of userRepo.deleteExpiredInstallers(now())) {
      logger.info('installer access expired; account removed', { userId: user.id, name: user.name });
    }
  };
  sweep();
  const timer = setInterval(sweep, options.intervalMs ?? DEFAULT_INTERVAL_MS);
  timer.unref();
  return () => clearInterval(timer);
}
