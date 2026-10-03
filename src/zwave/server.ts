import { ZwavejsServer } from '@zwave-js/server';
import { config } from '../config/index.js';
import { createLogger } from '../config/logger.js';
import { getDriver, startDriver } from './driver.js';

const logger = createLogger('zwave/server');

let server: ZwavejsServer | undefined;
let startPromise: Promise<void> | undefined;
/** True only once `start()` has resolved. */
let started = false;

/**
 * Returns the process-wide `ZwavejsServer` singleton, constructing it (but
 * not starting it) on first access. It wraps the same `getDriver()` singleton
 * from T009 — this module never constructs its own `Driver` or opens the
 * serial port, preserving FR-005's single-owner guarantee.
 *
 * Binds to `config.zwaveServerHost`/`config.zwaveServerPort` (both configurable via
 * `ZWAVE_SERVER_HOST`/`ZWAVE_SERVER_PORT`). This port must be reachable from the Home Assistant
 * instance so its built-in "Z-Wave JS" integration can connect directly to it — but per the
 * Assumptions in spec.md, it does not need to be exposed beyond the local network (no
 * internet/cloud dependency required for this integration surface).
 */
export function getZwaveJsServer(): ZwavejsServer {
  if (!server) {
    server = new ZwavejsServer(getDriver(), {
      host: config.zwaveServerHost,
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
    startPromise = startDriver()
      .then(() => getZwaveJsServer().start())
      .then(() => {
        started = true;
        logger.info('zwave-js-server listening', {
          host: config.zwaveServerHost,
          port: config.zwaveServerPort,
        });
      });
  }
  return startPromise;
}

/** Stops serving the zwave-js-server protocol, for graceful shutdown. A no-op if it never started. */
export async function stopZwaveJsServer(): Promise<void> {
  if (!server || !started) {
    return;
  }
  started = false;
  await server.destroy();
  logger.info('zwave-js-server stopped');
}
