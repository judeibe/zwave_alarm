import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';

const ENV_KEYS = ['SERIAL_PORT', 'DB_PATH', 'HTTP_PORT', 'ZWAVE_SERVER_PORT', 'SESSION_SECRET'] as const;

function setEnv() {
  process.env.SERIAL_PORT = '/dev/ttyACM0';
  process.env.DB_PATH = ':memory:';
  process.env.HTTP_PORT = '3000';
  process.env.ZWAVE_SERVER_PORT = '3001';
  process.env.SESSION_SECRET = 'test-secret';
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
    });
  });

  it('maps an unexpected error to a 500 internal_error', async () => {
    const { toErrorResponse } = await loadApp();
    const err = new Error('unexpected failure');

    expect(toErrorResponse(err)).toEqual({
      status: 500,
      code: 'internal_error',
      message: 'unexpected failure',
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
