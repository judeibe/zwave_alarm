import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockStart = vi.fn(() => Promise.resolve());

class MockDriver extends EventEmitter {
  start = mockStart;
  destroy = vi.fn(() => Promise.resolve());
}

const created: MockDriver[] = [];
const DriverCtor = vi.fn(function Driver() {
  const instance = new MockDriver();
  created.push(instance);
  return instance;
});

vi.mock('zwave-js', () => ({
  Driver: DriverCtor,
}));

const ENV_KEYS = [
  'SERIAL_PORT',
  'DB_PATH',
  'HTTP_PORT',
  'ZWAVE_SERVER_PORT',
  'SESSION_SECRET',
  'ZWAVE_SOFT_RESET',
  'ZWAVEJS_DISABLE_SOFT_RESET',
] as const;

function setEnv() {
  process.env.SERIAL_PORT = '/dev/ttyACM0';
  process.env.DB_PATH = ':memory:';
  process.env.HTTP_PORT = '3000';
  process.env.ZWAVE_SERVER_PORT = '3001';
  process.env.SESSION_SECRET = 'test-secret-0123456789abcdef0123456789';
}

describe('zwave driver singleton', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    DriverCtor.mockClear();
    created.length = 0;
    mockStart.mockReset();
    mockStart.mockImplementation(() => Promise.resolve());
    setEnv();
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      delete process.env[key];
    }
    process.env = { ...originalEnv };
  });

  it('constructs a single Driver instance from config.serialPort', async () => {
    const { getDriver } = await import('../../src/zwave/driver.js');
    const first = getDriver();
    const second = getDriver();
    expect(DriverCtor).toHaveBeenCalledTimes(1);
    expect(DriverCtor).toHaveBeenCalledWith('/dev/ttyACM0', {
      securityKeys: {},
      securityKeysLongRange: {},
      features: { softReset: true },
    });
    expect(first).toBe(second);
  });

  it('passes ZWAVE_SOFT_RESET=false to zwave-js as features.softReset', async () => {
    process.env.ZWAVE_SOFT_RESET = 'false';
    const { getDriver } = await import('../../src/zwave/driver.js');
    getDriver();
    expect(DriverCtor).toHaveBeenCalledWith('/dev/ttyACM0', expect.objectContaining({ features: { softReset: false } }));
  });

  it('keeps zwave-js\'s ZWAVEJS_DISABLE_SOFT_RESET switch working when ZWAVE_SOFT_RESET is unset', async () => {
    process.env.ZWAVEJS_DISABLE_SOFT_RESET = '1';
    const { getDriver } = await import('../../src/zwave/driver.js');
    getDriver();
    expect(DriverCtor).toHaveBeenCalledWith('/dev/ttyACM0', expect.objectContaining({ features: { softReset: false } }));
  });

  it('rejects an invalid ZWAVE_SOFT_RESET value', async () => {
    process.env.ZWAVE_SOFT_RESET = 'off';
    await expect(import('../../src/zwave/driver.js')).rejects.toThrow('ZWAVE_SOFT_RESET must be "true" or "false"');
  });

  it('logs structured JSON when the driver becomes ready', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { getDriver } = await import('../../src/zwave/driver.js');
    const driver = getDriver();

    driver.emit('driver ready');

    expect(logSpy).toHaveBeenCalledTimes(1);
    const logged = JSON.parse(logSpy.mock.calls[0][0] as string) as Record<string, unknown>;
    expect(logged).toMatchObject({
      level: 'info',
      module: 'zwave/driver',
      message: 'zwave-js driver ready',
    });
    expect(typeof logged.timestamp).toBe('string');

    logSpy.mockRestore();
  });

  it('logs structured JSON when the driver reports a failure', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { getDriver } = await import('../../src/zwave/driver.js');
    const driver = getDriver();

    driver.emit('error', new Error('port not found'));

    expect(errorSpy).toHaveBeenCalledTimes(1);
    const logged = JSON.parse(errorSpy.mock.calls[0][0] as string) as Record<string, unknown>;
    expect(logged).toMatchObject({
      level: 'error',
      module: 'zwave/driver',
      message: 'zwave-js driver failed',
      error: 'port not found',
    });

    errorSpy.mockRestore();
  });

  it('starts the driver exactly once even when startDriver is called concurrently', async () => {
    const { startDriver } = await import('../../src/zwave/driver.js');

    const started = Promise.all([startDriver(), startDriver(), startDriver()]);
    created[0].emit('driver ready');
    await started;

    expect(mockStart).toHaveBeenCalledTimes(1);
  });

  it('computes an exponential backoff capped at 60 seconds', async () => {
    const { retryDelayMs } = await import('../../src/zwave/driver.js');

    expect([1, 2, 3, 4, 5, 6, 7, 20].map(retryDelayMs)).toEqual([2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000, 60_000]);
  });

  describe('driver state', () => {
    it('is starting before the driver is ready, then ready once it emits "driver ready"', async () => {
      vi.spyOn(console, 'log').mockImplementation(() => {});
      const { getDriver, getDriverState, startDriver } = await import('../../src/zwave/driver.js');
      expect(getDriverState()).toEqual({ status: 'starting', lastError: null, attempts: 0, nextRetryAt: null });

      const started = startDriver();
      await Promise.resolve();
      expect(getDriverState()).toMatchObject({ status: 'starting', attempts: 1 });

      getDriver().emit('driver ready');
      await started;
      expect(getDriverState()).toEqual({ status: 'ready', lastError: null, attempts: 1, nextRetryAt: null });
    });

    it('records driver "error" events as lastError without changing the status', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      const { getDriver, getDriverState } = await import('../../src/zwave/driver.js');

      getDriver().emit('error', new Error('controller not responding'));

      expect(getDriverState()).toMatchObject({ status: 'starting', lastError: 'controller not responding' });
    });
  });

  describe('state change notifications', () => {
    it('notifies subscribers of every state change until they unsubscribe', async () => {
      vi.spyOn(console, 'log').mockImplementation(() => {});
      vi.spyOn(console, 'error').mockImplementation(() => {});
      const { getDriver, onDriverStateChange } = await import('../../src/zwave/driver.js');
      const seen: string[] = [];
      const unsubscribe = onDriverStateChange((state) => seen.push(`${state.status}:${state.lastError ?? '-'}`));

      getDriver().emit('error', new Error('boom'));
      getDriver().emit('driver ready');
      unsubscribe();
      getDriver().emit('error', new Error('ignored'));

      expect(seen).toEqual(['starting:boom', 'ready:-']);
    });
  });

  describe('start retry', () => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.spyOn(console, 'log').mockImplementation(() => {});
      vi.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
      vi.useRealTimers();
      vi.restoreAllMocks();
    });

    it('retries a failed start on a fresh Driver with backoff and reports the failure meanwhile', async () => {
      mockStart.mockRejectedValueOnce(new Error('No such file or directory, cannot open /dev/zwave'));
      const { startDriver, getDriverState } = await import('../../src/zwave/driver.js');

      const started = startDriver();
      await vi.advanceTimersByTimeAsync(0);

      expect(mockStart).toHaveBeenCalledTimes(1);
      expect(getDriverState()).toMatchObject({
        status: 'failed',
        lastError: 'No such file or directory, cannot open /dev/zwave',
        attempts: 1,
        nextRetryAt: Date.now() + 2_000,
      });
      // The failed instance can't be restarted (zwave-js treats a second start() as a no-op), so it is replaced.
      expect(DriverCtor).toHaveBeenCalledTimes(2);
      expect(created[0].destroy).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(2_000);
      expect(mockStart).toHaveBeenCalledTimes(2);
      expect(getDriverState()).toMatchObject({ status: 'starting', attempts: 2, nextRetryAt: null });

      created[1].emit('driver ready');
      await started;
      expect(getDriverState()).toMatchObject({ status: 'ready', attempts: 2 });
    });

    it('treats an "error" event after the port opened (ZW0100) as a failed start and retries on a fresh Driver', async () => {
      const { startDriver, getDriverState } = await import('../../src/zwave/driver.js');

      const started = startDriver();
      await vi.advanceTimersByTimeAsync(0);
      expect(mockStart).toHaveBeenCalledTimes(1);
      expect(getDriverState()).toMatchObject({ status: 'starting', attempts: 1 });

      created[0].emit('error', new Error('Failed to initialize the driver: The Serial API did not respond after soft-reset (ZW0100)'));
      await vi.advanceTimersByTimeAsync(0);

      expect(getDriverState()).toMatchObject({
        status: 'failed',
        lastError: expect.stringContaining('ZW0100'),
        attempts: 1,
        nextRetryAt: Date.now() + 2_000,
      });
      expect(DriverCtor).toHaveBeenCalledTimes(2);
      expect(created[0].destroy).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(2_000);
      expect(mockStart).toHaveBeenCalledTimes(2);
      expect(getDriverState()).toMatchObject({ status: 'starting', attempts: 2, nextRetryAt: null });

      created[1].emit('driver ready');
      await started;
      expect(getDriverState()).toMatchObject({ status: 'ready', lastError: null, attempts: 2 });
    });

    it('restarts on a fresh Driver when the driver errors after it was ready, with backoff from 2 s', async () => {
      const { startDriver, getDriverState, getDriver } = await import('../../src/zwave/driver.js');
      const onReady = vi.fn();
      getDriver().on('driver ready', onReady);

      const started = startDriver();
      await vi.advanceTimersByTimeAsync(0);
      created[0].emit('driver ready');
      await started;
      expect(getDriverState()).toMatchObject({ status: 'ready', attempts: 1 });
      expect(onReady).toHaveBeenCalledTimes(1);

      created[0].emit('error', new Error('serial port closed'));
      await vi.advanceTimersByTimeAsync(0);

      expect(getDriverState()).toMatchObject({
        status: 'failed',
        lastError: 'serial port closed',
        attempts: 1,
        nextRetryAt: Date.now() + 2_000,
      });
      expect(DriverCtor).toHaveBeenCalledTimes(2);
      expect(created[0].destroy).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(2_000);
      expect(mockStart).toHaveBeenCalledTimes(2);
      expect(getDriverState()).toMatchObject({ status: 'starting', attempts: 2, nextRetryAt: null });

      created[1].emit('driver ready');
      // The persistent "driver ready" listener moved to the replacement, so consumers can re-attach.
      expect(onReady).toHaveBeenCalledTimes(2);
      expect(getDriverState()).toMatchObject({ status: 'ready', lastError: null, attempts: 2 });
    });

    it('restarts the backoff after a run that reached ready, but keeps doubling while starts keep failing', async () => {
      const { startDriver, getDriverState } = await import('../../src/zwave/driver.js');
      void startDriver();
      await vi.advanceTimersByTimeAsync(0);
      created[0].emit('driver ready');
      await vi.advanceTimersByTimeAsync(0);

      created[0].emit('error', new Error('lost'));
      await vi.advanceTimersByTimeAsync(0);
      expect(getDriverState().nextRetryAt).toBe(Date.now() + 2_000);

      await vi.advanceTimersByTimeAsync(2_000);
      created[1].emit('error', new Error('still down'));
      await vi.advanceTimersByTimeAsync(0);
      expect(getDriverState()).toMatchObject({ status: 'failed', attempts: 2, nextRetryAt: Date.now() + 4_000 });
    });

    it('does not retry when the driver is stopped deliberately', async () => {
      const { startDriver, stopDriver } = await import('../../src/zwave/driver.js');
      const started = startDriver();
      await vi.advanceTimersByTimeAsync(0);
      created[0].emit('driver ready');
      await started;

      await stopDriver();
      created[0].emit('error', new Error('closed by destroy'));
      await vi.advanceTimersByTimeAsync(120_000);

      expect(created[0].destroy).toHaveBeenCalledTimes(1);
      expect(DriverCtor).toHaveBeenCalledTimes(1);
      expect(mockStart).toHaveBeenCalledTimes(1);
    });

    it('does not copy its own start listeners onto the replacement driver', async () => {
      const { startDriver } = await import('../../src/zwave/driver.js');

      void startDriver();
      await vi.advanceTimersByTimeAsync(0);
      created[0].emit('error', new Error('boom'));
      await vi.advanceTimersByTimeAsync(2_000);

      // Only the replacement's own attempt listener (one "driver ready") plus driver.ts's onDriverReady.
      expect(created[1].listenerCount('driver ready')).toBe(2);
      expect(created[1].listenerCount('error')).toBe(2);
    });

    it('doubles the delay on each consecutive failure', async () => {
      mockStart.mockRejectedValue(new Error('busy'));
      const { startDriver, getDriverState } = await import('../../src/zwave/driver.js');

      void startDriver();
      await vi.advanceTimersByTimeAsync(0);
      expect(getDriverState().nextRetryAt).toBe(Date.now() + 2_000);

      await vi.advanceTimersByTimeAsync(2_000);
      expect(getDriverState()).toMatchObject({ attempts: 2, nextRetryAt: Date.now() + 4_000 });
    });

    it('moves listeners registered on the failed driver onto its replacement', async () => {
      mockStart.mockRejectedValueOnce(new Error('busy'));
      const { getDriver, startDriver } = await import('../../src/zwave/driver.js');
      const onceListener = vi.fn();
      const onListener = vi.fn();
      getDriver().once('driver ready', onceListener);
      getDriver().on('node added', onListener);

      const started = startDriver();
      await vi.advanceTimersByTimeAsync(2_000);
      getDriver().emit('driver ready');
      await started;
      getDriver().emit('driver ready');
      getDriver().emit('driver ready');
      getDriver().emit('node added');
      getDriver().emit('node added');

      expect(onceListener).toHaveBeenCalledTimes(1);
      expect(onListener).toHaveBeenCalledTimes(2);
    });

    it('stops retrying once the driver is stopped', async () => {
      mockStart.mockRejectedValue(new Error('busy'));
      const { startDriver, stopDriver } = await import('../../src/zwave/driver.js');

      const stopped = expect(startDriver()).rejects.toThrow('stopped before it started');
      await vi.advanceTimersByTimeAsync(0);
      await stopDriver();
      await stopped;
      await vi.advanceTimersByTimeAsync(120_000);

      expect(mockStart).toHaveBeenCalledTimes(1);
    });
  });
});
