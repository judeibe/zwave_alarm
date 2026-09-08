import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockStart = vi.fn(() => Promise.resolve());

class MockDriver extends EventEmitter {
  start = mockStart;
}

const DriverCtor = vi.fn(function Driver() {
  return new MockDriver();
});

vi.mock('zwave-js', () => ({
  Driver: DriverCtor,
}));

const ENV_KEYS = ['SERIAL_PORT', 'DB_PATH', 'HTTP_PORT', 'ZWAVE_SERVER_PORT', 'SESSION_SECRET'] as const;

function setEnv() {
  process.env.SERIAL_PORT = '/dev/ttyACM0';
  process.env.DB_PATH = ':memory:';
  process.env.HTTP_PORT = '3000';
  process.env.ZWAVE_SERVER_PORT = '3001';
  process.env.SESSION_SECRET = 'test-secret';
}

describe('zwave driver singleton', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    DriverCtor.mockClear();
    mockStart.mockClear();
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
    expect(DriverCtor).toHaveBeenCalledWith('/dev/ttyACM0');
    expect(first).toBe(second);
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

    await Promise.all([startDriver(), startDriver(), startDriver()]);

    expect(mockStart).toHaveBeenCalledTimes(1);
  });
});
