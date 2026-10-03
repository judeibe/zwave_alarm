import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createShutdown } from '../../src/shutdown.js';

const mockDriverStart = vi.fn<() => Promise<void>>();
const mockDriverDestroy = vi.fn(() => Promise.resolve());
class MockDriver extends EventEmitter {
  start = mockDriverStart;
  destroy = mockDriverDestroy;
}
vi.mock('zwave-js', () => ({ Driver: vi.fn(function Driver() { return new MockDriver(); }) }));

const mockServerStart = vi.fn<() => Promise<void>>();
const mockServerDestroy = vi.fn(() => Promise.resolve());
class MockZwavejsServer {
  start = mockServerStart;
  destroy = mockServerDestroy;
}
vi.mock('@zwave-js/server', () => ({ ZwavejsServer: vi.fn(function ZwavejsServer() { return new MockZwavejsServer(); }) }));

describe('createShutdown', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('runs every step in order, then exits 0', async () => {
    const order: string[] = [];
    const exit = vi.fn();
    const shutdown = createShutdown(
      [
        { name: 'a', run: () => void order.push('a') },
        { name: 'b', run: async () => { await Promise.resolve(); order.push('b'); } },
        { name: 'c', run: () => void order.push('c') },
      ],
      { exit },
    );

    await shutdown('SIGTERM');

    expect(order).toEqual(['a', 'b', 'c']);
    expect(exit).toHaveBeenCalledExactlyOnceWith(0);
  });

  it('waits for each step to finish before starting the next', async () => {
    const events: string[] = [];
    const shutdown = createShutdown(
      [
        { name: 'slow', run: () => new Promise<void>((resolve) => setTimeout(() => { events.push('slow done'); resolve(); }, 20)) },
        { name: 'next', run: () => void events.push('next') },
      ],
      { exit: vi.fn() },
    );

    await shutdown('SIGTERM');

    expect(events).toEqual(['slow done', 'next']);
  });

  it('keeps going after a step fails, so one bad resource cannot leave the rest open, and exits 1', async () => {
    const closeDb = vi.fn();
    const exit = vi.fn();
    const shutdown = createShutdown(
      [
        { name: 'http', run: () => { throw new Error('port busy'); } },
        { name: 'async', run: () => Promise.reject(new Error('serial port stuck')) },
        { name: 'database', run: closeDb },
      ],
      { exit },
    );

    await shutdown('SIGINT');

    expect(closeDb).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
    const errors = vi.mocked(console.error).mock.calls.map((call) => JSON.parse(String(call[0])) as Record<string, unknown>);
    expect(errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ message: 'shutdown step failed', step: 'http', error: 'port busy' }),
        expect.objectContaining({ message: 'shutdown step failed', step: 'async', error: 'serial port stuck' }),
      ]),
    );
  });

  it('ignores a second signal while shutting down', async () => {
    const step = vi.fn();
    const exit = vi.fn();
    const shutdown = createShutdown([{ name: 'once', run: step }], { exit });

    await Promise.all([shutdown('SIGTERM'), shutdown('SIGINT')]);

    expect(step).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it('forces a non-zero exit at the deadline when a step hangs, and does not exit twice', async () => {
    vi.useFakeTimers();
    const exit = vi.fn();
    const shutdown = createShutdown([{ name: 'hangs', run: () => new Promise<void>(() => {}) }], { timeoutMs: 8_000, exit });

    void shutdown('SIGTERM');
    await vi.advanceTimersByTimeAsync(7_999);
    expect(exit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);

    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
  });

  it('cancels the deadline once finished, so a clean shutdown is not followed by a forced exit', async () => {
    vi.useFakeTimers();
    const exit = vi.fn();
    const shutdown = createShutdown([{ name: 'quick', run: () => {} }], { timeoutMs: 1_000, exit });

    await shutdown('SIGTERM');
    await vi.advanceTimersByTimeAsync(5_000);

    expect(exit).toHaveBeenCalledExactlyOnceWith(0);
  });

  it('logs the signal and the outcome as structured JSON', async () => {
    const shutdown = createShutdown([{ name: 'x', run: () => {} }], { exit: vi.fn() });

    await shutdown('SIGTERM');

    const logs = vi.mocked(console.log).mock.calls.map((call) => JSON.parse(String(call[0])) as Record<string, unknown>);
    expect(logs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ module: 'shutdown', message: 'shutting down', signal: 'SIGTERM' }),
        expect.objectContaining({ module: 'shutdown', message: 'shutdown complete', clean: true }),
      ]),
    );
  });
});

describe('stopping the zwave-js driver and server', () => {
  const ENV = {
    SERIAL_PORT: '/dev/ttyACM0',
    DB_PATH: ':memory:',
    HTTP_PORT: '3000',
    ZWAVE_SERVER_PORT: '3001',
    SESSION_SECRET: 'test-secret-0123456789abcdef0123456789',
  };
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mockDriverStart.mockReset().mockResolvedValue(undefined);
    mockDriverDestroy.mockClear();
    mockServerStart.mockReset().mockResolvedValue(undefined);
    mockServerDestroy.mockClear();
    Object.assign(process.env, ENV);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.env = { ...originalEnv };
  });

  it('does nothing when they were never started', async () => {
    const { stopDriver } = await import('../../src/zwave/driver.js');
    const { stopZwaveJsServer } = await import('../../src/zwave/server.js');

    await stopZwaveJsServer();
    await stopDriver();

    expect(mockDriverDestroy).not.toHaveBeenCalled();
    expect(mockServerDestroy).not.toHaveBeenCalled();
  });

  it('destroys each exactly once after a successful start', async () => {
    const { startZwaveJsServer, stopZwaveJsServer } = await import('../../src/zwave/server.js');
    const { stopDriver } = await import('../../src/zwave/driver.js');
    await startZwaveJsServer();

    await stopZwaveJsServer();
    await stopDriver();
    await stopZwaveJsServer();
    await stopDriver();

    expect(mockServerDestroy).toHaveBeenCalledTimes(1);
    expect(mockDriverDestroy).toHaveBeenCalledTimes(1);
  });

  it('does not touch a driver that failed to start (no controller attached)', async () => {
    mockDriverStart.mockRejectedValue(new Error('no such device'));
    const { startZwaveJsServer, stopZwaveJsServer } = await import('../../src/zwave/server.js');
    const { stopDriver } = await import('../../src/zwave/driver.js');
    await startZwaveJsServer().catch(() => {});

    await stopZwaveJsServer();
    await stopDriver();

    expect(mockDriverDestroy).not.toHaveBeenCalled();
    expect(mockServerDestroy).not.toHaveBeenCalled();
  });

  it('does not wait on a driver that is still starting', async () => {
    mockDriverStart.mockReturnValue(new Promise<void>(() => {})); // never settles
    const { startDriver, stopDriver } = await import('../../src/zwave/driver.js');
    void startDriver();

    await expect(stopDriver()).resolves.toBeUndefined();
    expect(mockDriverDestroy).not.toHaveBeenCalled();
  });
});
