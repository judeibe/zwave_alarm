import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ENV_KEYS = ['SERIAL_PORT', 'DB_PATH', 'HTTP_PORT', 'ZWAVE_SERVER_PORT', 'SESSION_SECRET'] as const;

const validEnv: Record<(typeof ENV_KEYS)[number], string> = {
  SERIAL_PORT: '/dev/ttyACM0',
  DB_PATH: './data/alarm.db',
  HTTP_PORT: '3000',
  ZWAVE_SERVER_PORT: '3001',
  SESSION_SECRET: 'test-secret',
};

function setEnv(overrides: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {}) {
  const merged = { ...validEnv, ...overrides };
  for (const key of ENV_KEYS) {
    const value = merged[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

describe('config loader', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      delete process.env[key];
    }
    process.env = { ...originalEnv };
  });

  it('loads a valid configuration from process.env', async () => {
    setEnv();
    const { config } = await import('../../src/config/index.js');
    expect(config).toEqual({
      serialPort: '/dev/ttyACM0',
      dbPath: './data/alarm.db',
      httpPort: 3000,
      zwaveServerPort: 3001,
      sessionSecret: 'test-secret',
    });
  });

  it('throws listing every missing variable when several are unset', async () => {
    setEnv({ SERIAL_PORT: undefined, SESSION_SECRET: undefined });
    await expect(import('../../src/config/index.js')).rejects.toThrow(/SERIAL_PORT.*SESSION_SECRET/s);
  });

  it('rejects a non-numeric port', async () => {
    setEnv({ HTTP_PORT: 'not-a-port' });
    await expect(import('../../src/config/index.js')).rejects.toThrow(/HTTP_PORT/);
  });

  it('rejects an out-of-range port', async () => {
    setEnv({ ZWAVE_SERVER_PORT: '70000' });
    await expect(import('../../src/config/index.js')).rejects.toThrow(/ZWAVE_SERVER_PORT/);
  });

  it('rejects HTTP_PORT and ZWAVE_SERVER_PORT collisions', async () => {
    setEnv({ ZWAVE_SERVER_PORT: '3000' });
    await expect(import('../../src/config/index.js')).rejects.toThrow(/must be different/);
  });
});
