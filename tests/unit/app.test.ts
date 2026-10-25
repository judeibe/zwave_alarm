import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';

const ENV_KEYS = ['SERIAL_PORT', 'DB_PATH', 'HTTP_PORT', 'ZWAVE_SERVER_PORT', 'SESSION_SECRET'] as const;

function setEnv() {
  process.env.SERIAL_PORT = '/dev/ttyACM0';
  process.env.DB_PATH = ':memory:';
  process.env.HTTP_PORT = '3000';
  process.env.ZWAVE_SERVER_PORT = '3001';
  process.env.SESSION_SECRET = 'test-secret-0123456789abcdef0123456789';
}

/**
 * app.ts (via src/auth/session.ts) now pulls in src/config/index.ts, which
 * validates required env vars *at import time* — a static top-level import
 * would run before any beforeEach() gets a chance to set them, so every test
 * here imports app.ts dynamically after env vars are in place, mirroring
 * tests/unit/session.test.ts's/tests/unit/config.test.ts's precedent.
 */
async function loadApp() {
  return import('../../src/api/app.js');
}

describe('createApp', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    setEnv();
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      delete process.env[key];
    }
    process.env = { ...originalEnv };
  });

  it('returns 200 OK from /healthz', async () => {
    const { createApp } = await loadApp();
    const app = createApp();

    const res = await request(app).get('/healthz');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
  });

  describe('/readyz', () => {
    const state = (status: 'starting' | 'ready' | 'failed') => ({
      status,
      lastError: status === 'failed' ? 'ZW0100' : null,
      attempts: 1,
      nextRetryAt: null,
    });

    async function appWithDriver(getState: () => ReturnType<typeof state>) {
      const { createApp } = await loadApp();
      // Only driverState is read by the routes under test; the rest of AppDeps is not exercised.
      return createApp({ driverState: getState } as unknown as Parameters<typeof createApp>[0]);
    }

    it.each(['starting', 'failed'] as const)('returns 503 with the driver state while it is %s', async (status) => {
      const app = await appWithDriver(() => state(status));

      const res = await request(app).get('/readyz');

      expect(res.status).toBe(503);
      expect(res.body).toEqual({ status: 'unavailable', driver: state(status) });
    });

    it('returns 200 once the driver is ready, and follows it back down when it restarts', async () => {
      let current = state('ready');
      const app = await appWithDriver(() => current);

      const ready = await request(app).get('/readyz');
      expect(ready.status).toBe(200);
      expect(ready.body).toEqual({ status: 'ready', driver: state('ready') });

      current = state('failed');
      expect((await request(app).get('/readyz')).status).toBe(503);
    });

    it('keeps /healthz at 200 whatever the driver state', async () => {
      const app = await appWithDriver(() => state('failed'));

      expect((await request(app).get('/healthz')).status).toBe(200);
    });

    it('is not mounted without a driver state', async () => {
      const { createApp } = await loadApp();

      expect((await request(createApp()).get('/readyz')).status).toBe(404);
    });
  });

  it('parses JSON request bodies', async () => {
    const { createApp } = await loadApp();
    const app = createApp();
    app.post('/echo', (req, res) => {
      res.status(200).json(req.body);
    });

    const res = await request(app).post('/echo').send({ hello: 'world' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ hello: 'world' });
  });

  it('maps an ApiError to { status, code, message } from its own fields', async () => {
    const { ApiError, toErrorResponse } = await loadApp();
    const err = new ApiError(409, 'conflict', 'native command already pending');

    expect(toErrorResponse(err)).toEqual({
      status: 409,
      code: 'conflict',
      message: 'native command already pending',
      details: {},
    });
  });

  it('maps an unexpected error to a 500 internal_error', async () => {
    const { toErrorResponse } = await loadApp();
    const err = new Error('unexpected failure');

    expect(toErrorResponse(err)).toEqual({
      status: 500,
      code: 'internal_error',
      message: 'unexpected failure',
      details: {},
    });
  });

  it('formats a malformed JSON body as a 400 bad_request', async () => {
    const { createApp } = await loadApp();
    const app = createApp();
    app.post('/echo', (req, res) => {
      res.status(200).json(req.body);
    });

    const res = await request(app)
      .post('/echo')
      .set('Content-Type', 'application/json')
      .send('{not valid json');

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('bad_request');
  });

  describe('static dashboard (T030)', () => {
    it('serves the dashboard index.html at /', async () => {
      const { createApp } = await loadApp();
      const app = createApp();

      const res = await request(app).get('/');

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toContain('text/html');
      expect(res.text).toContain('<title>Z-Wave Alarm</title>');
    });

    it('serves app.js with a JavaScript content type', async () => {
      const { createApp } = await loadApp();
      const app = createApp();

      const res = await request(app).get('/app.js');

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toContain('javascript');
    });

    it('serves styles.css', async () => {
      const { createApp } = await loadApp();
      const app = createApp();

      const res = await request(app).get('/styles.css');

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toContain('text/css');
    });

    it('falls through to the JSON 404 handler for an unknown static path', async () => {
      const { createApp } = await loadApp();
      const app = createApp();

      const res = await request(app).get('/does-not-exist.txt');

      expect(res.status).toBe(404);
    });
  });
});
