import { ZwavejsServer } from '@zwave-js/server';
import { config } from '../config/index.js';
import { createLogger } from '../config/logger.js';
import { getDriver, startDriver } from './driver.js';

const logger = createLogger('zwave/server');

let server: ZwavejsServer | undefined;
let startPromise: Promise<void> | undefined;

/**
 * Returns the process-wide `ZwavejsServer` singleton, constructing it (but
 * not starting it) on first access. It wraps the same `getDriver()` singleton
 * from T009 — this module never constructs its own `Driver` or opens the
 * serial port, preserving FR-005's single-owner guarantee.
 */
export function getZwaveJsServer(): ZwavejsServer {
  if (!server) {
    server = new ZwavejsServer(getDriver(), {
      port: config.zwaveServerPort,
      logger: {
        error: (message) => logger.error(typeof message === 'string' ? message : message.message),
        warn: (message) => logger.warn(message),
        info: (message) => logger.info(message),
        debug: (message) => logger.debug(message),
      },
    });
  }

  return server;
}

/**
 * Starts the singleton `ZwavejsServer` exactly once, binding it to
 * `config.zwaveServerPort`. Ensures the underlying zwave-js driver is started
 * first (via T009's `startDriver()`) since `ZwavejsServer` requires a running
 * driver. Safe to call multiple times — later calls return the same
 * in-flight/settled promise instead of re-binding the port.
 */
export function startZwaveJsServer(): Promise<void> {
  if (!startPromise) {
    startPromise = startDriver().then(() => getZwaveJsServer().start());
  }
  return startPromise;
}
