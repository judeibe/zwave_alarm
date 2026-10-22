import type { EventEmitter } from 'node:events';
import { Driver } from 'zwave-js';
import { config } from '../config/index.js';
import { createLogger } from '../config/logger.js';

const logger = createLogger('zwave/driver');

/**
 * `starting`: the serial port is being opened or the controller interviewed.
 * `ready`: zwave-js emitted "driver ready". `failed`: starting failed (port could not be opened, or
 * the driver gave up initializing, e.g. ZW0100) and another attempt is scheduled at `nextRetryAt`.
 */
export type DriverStatus = 'starting' | 'ready' | 'failed';

/** Exposed on `GET /api/v1/panel` as `driver` (contracts/rest-api.md). */
export interface DriverState {
  status: DriverStatus;
  /** Most recent start failure or driver "error" event; cleared once the driver is ready. */
  lastError: string | null;
  /** Start attempts made so far, including the one in flight. */
  attempts: number;
  /** Epoch ms of the next retry while `failed`, otherwise null. */
  nextRetryAt: number | null;
}

const RETRY_BASE_DELAY_MS = 2_000;
const RETRY_MAX_DELAY_MS = 60_000;

/** Exponential backoff, doubling from 2 s and capped at 60 s. `attempt` is 1-based. */
export function retryDelayMs(attempt: number): number {
  return Math.min(RETRY_BASE_DELAY_MS * 2 ** (attempt - 1), RETRY_MAX_DELAY_MS);
}

let current: Driver | undefined;
let facade: Driver | undefined;
let startPromise: Promise<void> | undefined;
/** True only once the driver is ready, so shutdown never waits on (or destroys) a half-started driver. */
let started = false;
let stopping = false;
let retryTimer: NodeJS.Timeout | undefined;
let wakeRetry: (() => void) | undefined;
let state: DriverState = { status: 'starting', lastError: null, attempts: 0, nextRetryAt: null };

function toBytes<K extends string>(keys: Partial<Record<K, string>>): Partial<Record<K, Uint8Array<ArrayBuffer>>> {
  const bytes: Partial<Record<K, Uint8Array<ArrayBuffer>>> = {};
  for (const name of Object.keys(keys) as K[]) {
    bytes[name] = Uint8Array.from(Buffer.from(keys[name]!, 'hex'));
  }
  return bytes;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// zwave-js has no "driver failed" event; failures to start/run surface via the "error" event (and
// via `start()`'s rejection). Here it is only recorded; `startAttempt` is what turns an error that
// arrives before "driver ready" into a failed start.
function onDriverError(err: Error): void {
  state = { ...state, lastError: err.message };
  logger.error('zwave-js driver failed', { error: err.message });
}

function onDriverReady(): void {
  state = { status: 'ready', lastError: null, attempts: state.attempts, nextRetryAt: null };
  logger.info('zwave-js driver ready');
}

function createInstance(): Driver {
  const instance = new Driver(config.serialPort, {
    securityKeys: toBytes(config.securityKeys),
    securityKeysLongRange: toBytes(config.securityKeysLongRange),
    features: { softReset: config.zwaveSoftReset },
  });
  instance.on('error', onDriverError);
  instance.once('driver ready', onDriverReady);
  return instance;
}

/**
 * Moves every listener registered by other modules (e.g. src/index.ts waiting for "driver ready")
 * from a failed driver onto its replacement; ours are re-attached by `createInstance`.
 */
function transferListeners(from: Driver, to: Driver): void {
  const source = from as unknown as EventEmitter;
  const target = to as unknown as EventEmitter;
  for (const eventName of source.eventNames()) {
    for (const raw of source.rawListeners(eventName)) {
      // A `once` registration is wrapped by Node; the wrapper's `.listener` is the original function.
      const original = (raw as { listener?: (...args: unknown[]) => void }).listener;
      const listener = original ?? (raw as (...args: unknown[]) => void);
      if (listener === onDriverError || listener === onDriverReady) {
        continue;
      }
      if (original) {
        target.once(eventName, listener);
      } else {
        target.on(eventName, listener);
      }
    }
  }
}

/**
 * zwave-js marks a driver as started before it opens the serial port, so calling `start()` again on
 * the same instance after a failure silently resolves without doing anything. A retry therefore
 * needs a fresh `Driver`.
 */
function replaceInstance(): void {
  const failed = current!;
  current = createInstance();
  transferListeners(failed, current);
  try {
    failed.destroy().catch(() => {});
  } catch {
    // Nothing was opened, so there is nothing to release.
  }
}

/**
 * Returns the process-wide zwave-js Driver, constructing it (but not starting it) on first access.
 * Per FR-005, this process must be the sole owner of `config.serialPort` — nothing else in the
 * codebase may construct a `Driver` or otherwise open this serial port.
 *
 * The returned object is a stable facade over the current instance: a failed start is retried on a
 * new `Driver` (see `replaceInstance`), and the long-lived holders (SensorMapper, Siren, the REST
 * routes, zwave-js-server) keep working against whichever instance is current.
 */
export function getDriver(): Driver {
  if (!facade) {
    current = createInstance();
    facade = new Proxy({} as Driver, {
      get(_target, property) {
        const instance = current!;
        const value: unknown = Reflect.get(instance, property, instance);
        return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(instance) : value;
      },
      set(_target, property, value) {
        return Reflect.set(current!, property, value);
      },
    });
  }

  return facade;
}

/** Current driver status for `GET /api/v1/panel`; never constructs the driver. */
export function getDriverState(): DriverState {
  return { ...state };
}

function sleepUntilRetry(delayMs: number): Promise<void> {
  return new Promise((resolve) => {
    wakeRetry = resolve;
    retryTimer = setTimeout(resolve, delayMs);
    retryTimer.unref();
  });
}

/**
 * One start attempt on `instance`. Resolves on "driver ready"; rejects if `start()` rejects or the
 * driver emits "error" first. `start()` itself resolves as soon as the serial port is open, so a
 * controller that goes silent afterwards (ZW0100) only shows up as an "error" event.
 */
function startAttempt(instance: Driver): Promise<void> {
  return new Promise((resolve, reject) => {
    // Detach before the instance is replaced, or `transferListeners` would copy these to the new one.
    const cleanup = () => {
      instance.off('driver ready', onReady);
      instance.off('error', onError);
    };
    const onReady = () => {
      cleanup();
      resolve();
    };
    const onError = (err: unknown) => {
      cleanup();
      reject(err);
    };
    instance.on('driver ready', onReady);
    instance.on('error', onError);
    instance.start().catch(onError);
  });
}

async function startWithRetry(): Promise<void> {
  getDriver();
  for (let attempt = 1; !stopping; attempt++) {
    state = { status: 'starting', lastError: state.lastError, attempts: attempt, nextRetryAt: null };
    logger.info('starting zwave-js driver', { serialPort: config.serialPort, attempt });
    try {
      await startAttempt(current!);
      started = true;
      return;
    } catch (err) {
      const delay = retryDelayMs(attempt);
      const message = errorMessage(err);
      state = { status: 'failed', lastError: message, attempts: attempt, nextRetryAt: Date.now() + delay };
      logger.error('zwave-js driver failed to start', {
        serialPort: config.serialPort,
        attempt,
        error: message,
        retryInMs: delay,
      });
      replaceInstance();
      await sleepUntilRetry(delay);
    }
  }
  throw new Error('zwave-js driver was stopped before it started');
}

/**
 * Starts the driver, opening the serial port and interviewing the controller, and keeps retrying
 * with backoff if that fails: the controller isn't attached, the port is busy, or the controller
 * stops answering during startup (e.g. after a soft-reset, ZW0100). Safe to call multiple times —
 * later calls return the same promise. Resolves once the driver is "ready". Failures are retried,
 * not rejected; it only rejects if `stopDriver()` ends the retrying first.
 */
export function startDriver(): Promise<void> {
  startPromise ??= startWithRetry();
  return startPromise;
}

/**
 * Resolves once zwave-js has finished its startup interview ("driver ready"). `start()` resolves as
 * soon as the serial port is open, which is well before that (about 20 s on a populated network), and
 * `ZwavejsServer.start()` throws "Cannot start server when driver not ready" if called in between.
 */
export function waitForDriverReady(): Promise<void> {
  const d = getDriver();
  if (d.ready) {
    return Promise.resolve();
  }
  return new Promise((resolve) => d.once('driver ready', () => resolve()));
}

/**
 * Releases the serial port and stops the driver, for graceful shutdown. Also cancels a pending
 * retry. A no-op for the driver itself if it never finished starting (e.g. no controller was
 * attached, or shutdown arrived mid-start), since there is then nothing open to release.
 */
export async function stopDriver(): Promise<void> {
  stopping = true;
  clearTimeout(retryTimer);
  wakeRetry?.();

  // Still starting (or failed): nothing to release, and the OS closes the port on exit. Waiting on
  // a start that can take ~9 s to fail would eat the shutdown deadline.
  if (!current || !started) {
    return;
  }
  started = false;
  await current.destroy();
  logger.info('zwave-js driver stopped');
}
