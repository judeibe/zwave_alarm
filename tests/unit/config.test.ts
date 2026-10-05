import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ENV_KEYS = ['SERIAL_PORT', 'DB_PATH', 'HTTP_PORT', 'ZWAVE_SERVER_PORT', 'SESSION_SECRET'] as const;

const validEnv: Record<(typeof ENV_KEYS)[number], string> = {
  SERIAL_PORT: '/dev/ttyACM0',
  DB_PATH: './data/alarm.db',
  HTTP_PORT: '3000',
  ZWAVE_SERVER_PORT: '3001',
  SESSION_SECRET: 'test-secret-0123456789abcdef0123456789',
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

  describe('SESSION_SECRET strength', () => {
    it.each([
      ['too short', 'short-secret'],
      ['31 characters', 'x'.repeat(31)],
      ['the .env.example placeholder', 'change-me-to-a-long-random-string'],
      ['a padded placeholder', 'change-me-' + 'x'.repeat(40)],
    ])('rejects %s without echoing the value', async (_label, secret) => {
      setEnv({ SESSION_SECRET: secret });

      const failure = await import('../../src/config/index.js').then(
        () => undefined,
        (err: unknown) => err as Error,
      );

      expect(failure?.message).toMatch(/SESSION_SECRET must be a random value of at least 32 characters/);
      expect(failure?.message).not.toContain(secret);
    });

    it('accepts a 32-character random value', async () => {
      setEnv({ SESSION_SECRET: 'a'.repeat(32) });

      const { config } = await import('../../src/config/index.js');

      expect(config.sessionSecret).toBe('a'.repeat(32));
    });
  });

  describe('exit/entry delays (FR-004)', () => {
    afterEach(() => {
      delete process.env.EXIT_DELAY_SECONDS;
      delete process.env.ENTRY_DELAY_SECONDS;
    });

    it('defaults both delays to 30 seconds', async () => {
      setEnv();

      const { config } = await import('../../src/config/index.js');

      expect(config).toMatchObject({ exitDelaySeconds: 30, entryDelaySeconds: 30 });
    });

    it('reads them independently, treating an empty value as unset', async () => {
      setEnv();
      process.env.EXIT_DELAY_SECONDS = '60';
      process.env.ENTRY_DELAY_SECONDS = '';

      const { config } = await import('../../src/config/index.js');

      expect(config).toMatchObject({ exitDelaySeconds: 60, entryDelaySeconds: 30 });
    });

    it('accepts 0 (no delay) and the 600 second maximum', async () => {
      setEnv();
      process.env.EXIT_DELAY_SECONDS = '0';
      process.env.ENTRY_DELAY_SECONDS = '600';

      const { config } = await import('../../src/config/index.js');

      expect(config).toMatchObject({ exitDelaySeconds: 0, entryDelaySeconds: 600 });
    });

    it.each(['-1', '601', '1.5', 'soon'])('rejects EXIT_DELAY_SECONDS=%s', async (value) => {
      setEnv();
      process.env.EXIT_DELAY_SECONDS = value;

      await expect(import('../../src/config/index.js')).rejects.toThrow(
        new RegExp(`EXIT_DELAY_SECONDS must be a whole number of seconds between 0 and 600, got "${value}"`),
      );
    });

    it('rejects an invalid ENTRY_DELAY_SECONDS', async () => {
      setEnv();
      process.env.ENTRY_DELAY_SECONDS = '9999';

      await expect(import('../../src/config/index.js')).rejects.toThrow(/ENTRY_DELAY_SECONDS/);
    });
  });

  it('loads a valid configuration from process.env', async () => {
    setEnv();
    delete process.env.SIREN_NODE_ID;
    delete process.env.ZWAVE_SERVER_HOST;
    const { config } = await import('../../src/config/index.js');
    expect(config).toEqual({
      serialPort: '/dev/ttyACM0',
      dbPath: './data/alarm.db',
      httpPort: 3000,
      zwaveServerPort: 3001,
      zwaveServerHost: '0.0.0.0',
      sessionSecret: 'test-secret-0123456789abcdef0123456789',
      sirenNodeId: null,
      exitDelaySeconds: 30,
      entryDelaySeconds: 30,
      securityKeys: {},
      securityKeysLongRange: {},
      keypadRequireCodeToArm: false,
    });
  });

  it('uses ZWAVE_SERVER_HOST when set', async () => {
    setEnv();
    process.env.ZWAVE_SERVER_HOST = '192.168.1.10';
    const { config } = await import('../../src/config/index.js');
    expect(config.zwaveServerHost).toBe('192.168.1.10');
    delete process.env.ZWAVE_SERVER_HOST;
  });

  it('parses SIREN_NODE_ID when set, and rejects a non-positive-integer value', async () => {
    setEnv();
    process.env.SIREN_NODE_ID = '5';
    const { config } = await import('../../src/config/index.js');
    expect(config.sirenNodeId).toBe(5);

    vi.resetModules();
    setEnv();
    process.env.SIREN_NODE_ID = '0';
    await expect(import('../../src/config/index.js')).rejects.toThrow(/SIREN_NODE_ID/);

    delete process.env.SIREN_NODE_ID;
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

  describe('Z-Wave security keys', () => {
    afterEach(() => {
      delete process.env.ZWAVE_KEY_S0_LEGACY;
      delete process.env.ZWAVE_LR_KEY_S2_ACCESS_CONTROL;
    });

    it('defaults to no keys', async () => {
      setEnv();
      const { config } = await import('../../src/config/index.js');
      expect(config.securityKeys).toEqual({});
      expect(config.securityKeysLongRange).toEqual({});
    });

    it('reads keys from the environment, lower-cased', async () => {
      setEnv();
      process.env.ZWAVE_KEY_S0_LEGACY = '86EA21E90949AFA756A48FBD74A399F1';
      process.env.ZWAVE_LR_KEY_S2_ACCESS_CONTROL = 'a'.repeat(32);
      const { config } = await import('../../src/config/index.js');
      expect(config.securityKeys).toEqual({ S0_Legacy: '86ea21e90949afa756a48fbd74a399f1' });
      expect(config.securityKeysLongRange).toEqual({ S2_AccessControl: 'a'.repeat(32) });
    });

    it('rejects a malformed key without echoing it', async () => {
      setEnv();
      process.env.ZWAVE_KEY_S0_LEGACY = 'not-hex-not-hex-not-hex-not-hex-1';
      const failure = await import('../../src/config/index.js').then(
        () => undefined,
        (err: unknown) => err as Error,
      );
      expect(failure?.message).toMatch(/ZWAVE_KEY_S0_LEGACY must be exactly 32 hexadecimal/);
      expect(failure?.message).not.toContain('not-hex');
    });
  });
});
