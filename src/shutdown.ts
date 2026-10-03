import { createLogger } from './config/logger.js';

const logger = createLogger('shutdown');

export interface ShutdownStep {
  name: string;
  run: () => void | Promise<void>;
}

export interface ShutdownOptions {
  /**
   * Hard deadline for the whole sequence, after which the process exits non-zero regardless.
   * Docker sends SIGKILL 10 s after SIGTERM, so the default leaves headroom beneath that.
   */
  timeoutMs?: number;
  /** Injected for tests; defaults to `process.exit`. */
  exit?: (code: number) => void;
}

const DEFAULT_TIMEOUT_MS = 8_000;

/**
 * Builds the handler to run on SIGTERM/SIGINT. Without one, Node running as PID 1 in a container
 * ignores SIGTERM, so every `docker stop`/`restart` sat out Docker's full 10 s grace period and
 * ended in a hard SIGKILL: ten seconds of downtime on each restart of an alarm.
 *
 * Steps run in order, one at a time. A step that throws is logged and the rest still run, so a
 * failure closing one resource can't leave the others (the database, the serial port) open. A
 * second signal while shutting down is ignored; the deadline is what forces an exit.
 *
 * Nothing here changes the alarm's state: an exit or entry delay in flight is persisted and
 * `PanelService.resume()` re-schedules it on the next start (SC-006).
 */
export function createShutdown(
  steps: ShutdownStep[],
  { timeoutMs = DEFAULT_TIMEOUT_MS, exit = (code) => process.exit(code) }: ShutdownOptions = {},
): (signal: string) => Promise<void> {
  let shuttingDown = false;

  return async (signal: string): Promise<void> => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    logger.info('shutting down', { signal });

    const deadline = setTimeout(() => {
      logger.error('shutdown did not finish in time; forcing exit', { timeoutMs });
      exit(1);
    }, timeoutMs);

    let failed = false;
    for (const step of steps) {
      try {
        await step.run();
        logger.debug('shutdown step done', { step: step.name });
      } catch (err) {
        failed = true;
        logger.error('shutdown step failed', {
          step: step.name,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    clearTimeout(deadline);
    logger.info('shutdown complete', { clean: !failed });
    exit(failed ? 1 : 0);
  };
}
