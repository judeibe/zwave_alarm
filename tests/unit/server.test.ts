import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockDriverStart = vi.fn(() => Promise.resolve());

class MockDriver extends EventEmitter {
  start = mockDriverStart;
}

const DriverCtor = vi.fn(function Driver() {
  return new MockDriver();
});

vi.mock('zwave-js', () => ({
  Driver: DriverCtor,
}));

const mockServerStart = vi.fn(() => Promise.resolve());

class MockZwavejsServer {
  constructor(
    public driver: unknown,
    public options: Record<string, unknown>,
  ) {}
  start = mockServerStart;
}

const ZwavejsServerCtor = vi.fn(function ZwavejsServer(driver: unknown, options: Record<string, unknown>) {
  return new MockZwavejsServer(driver, options);
});

vi.mock('@zwave-js/server', () => ({
  ZwavejsServer: ZwavejsServerCtor,
}));

const ENV_KEYS = ['SERIAL_PORT', 'DB_PATH', 'HTTP_PORT', 'ZWAVE_SERVER_PORT', 'SESSION_SECRET'] as const;

function setEnv() {
  process.env.SERIAL_PORT = '/dev/ttyACM0';
  process.env.DB_PATH = ':memory:';
  process.env.HTTP_PORT = '3000';
  process.env.ZWAVE_SERVER_PORT = '3001';
  process.env.SESSION_SECRET = 'test-secret';
}

describe('zwave-js-server bootstrap', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    DriverCtor.mockClear();
    mockDriverStart.mockClear();
    ZwavejsServerCtor.mockClear();
    mockServerStart.mockClear();
    setEnv();
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      delete process.env[key];
    }
    process.env = { ...originalEnv };
  });

  it('constructs a single ZwavejsServer bound to the driver singleton and configured port', async () => {
    const { getZwaveJsServer } = await import('../../src/zwave/server.js');
    const { getDriver } = await import('../../src/zwave/driver.js');

    const first = getZwaveJsServer();
    const second = getZwaveJsServer();

    expect(ZwavejsServerCtor).toHaveBeenCalledTimes(1);
    expect((first as unknown as MockZwavejsServer).driver).toBe(getDriver());
    expect((first as unknown as MockZwavejsServer).options).toMatchObject({ port: 3001 });
    expect(first).toBe(second);
  });

  it('does not construct its own Driver instance', async () => {
    const { getZwaveJsServer } = await import('../../src/zwave/server.js');

    getZwaveJsServer();

    expect(DriverCtor).toHaveBeenCalledTimes(1);
  });

  it('starts the driver before starting the zwave-js-server', async () => {
    const { startZwaveJsServer } = await import('../../src/zwave/server.js');

    await startZwaveJsServer();

    expect(mockDriverStart).toHaveBeenCalledTimes(1);
    expect(mockServerStart).toHaveBeenCalledTimes(1);
    expect(mockDriverStart.mock.invocationCallOrder[0]).toBeLessThan(
      mockServerStart.mock.invocationCallOrder[0],
    );
  });

  it('starts the server exactly once even when startZwaveJsServer is called concurrently', async () => {
    const { startZwaveJsServer } = await import('../../src/zwave/server.js');

    await Promise.all([startZwaveJsServer(), startZwaveJsServer(), startZwaveJsServer()]);

    expect(mockServerStart).toHaveBeenCalledTimes(1);
  });
});
