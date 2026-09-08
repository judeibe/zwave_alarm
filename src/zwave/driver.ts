import { Driver } from 'zwave-js';
import { config } from '../config/index.js';
import { createLogger } from '../config/logger.js';

const logger = createLogger('zwave/driver');

let driver: Driver | undefined;
let startPromise: Promise<void> | undefined;

/**
 * Returns the process-wide zwave-js Driver singleton, constructing it (but
 * not starting it) on first access. Per FR-005, this process must be the
 * sole owner of `config.serialPort` — nothing else in the codebase may
 * construct a `Driver` or otherwise open this serial port.
 *
 * zwave-js has no "driver failed" event; failures to start/run surface via
 * the "error" event (and via `start()`'s rejection, see `startDriver`), so
 * that's what's wired up here as this task's "driver failed" handler.
 */
export function getDriver(): Driver {
  if (!driver) {
    driver = new Driver(config.serialPort);

    driver.on('error', (err) => {
      logger.error('zwave-js driver failed', { error: err.message });
    });

    driver.once('driver ready', () => {
      logger.info('zwave-js driver ready');
    });
  }

  return driver;
}

/**
 * Starts the singleton driver exactly once, opening the serial port. Safe to
 * call multiple times — later calls return the same in-flight/settled
 * promise instead of re-opening the port. Rejects (without ever resolving)
 * if the driver fails to start, e.g. because `config.serialPort` doesn't
 * exist or is already in use.
 */
export function startDriver(): Promise<void> {
  if (!startPromise) {
    startPromise = getDriver().start();
  }
  return startPromise;
}
