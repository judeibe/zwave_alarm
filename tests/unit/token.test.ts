import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ENV_KEYS = ['SERIAL_PORT', 'DB_PATH', 'HTTP_PORT', 'ZWAVE_SERVER_PORT', 'SESSION_SECRET'] as const;

function setEnv() {
  process.env.SERIAL_PORT = '/dev/ttyACM0';
  process.env.DB_PATH = ':memory:';
  process.env.HTTP_PORT = '3000';
  process.env.ZWAVE_SERVER_PORT = '3001';
  process.env.SESSION_SECRET = 'test-secret';
}

/**
 * token.ts imports `ApiError` from src/api/app.ts, which (since T027) now
 * pulls in src/config/index.ts and validates required env vars *at import
 * time* — a static top-level import would run before beforeEach() sets them,
 * so this dynamically imports after env vars are in place, mirroring
 * tests/unit/session.test.ts's/tests/unit/config.test.ts's precedent.
 */
async function buildTestApp() {
  const { hashToken, requireHaToken } = await import('../../src/auth/token.js');
  const { toErrorResponse } = await import('../../src/api/app.js');

  const app = express();

  app.get('/protected', requireHaToken, (req, res) => {
    res.status(200).json({ haLink: req.haLink });
  });

  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- Express only recognizes error middleware with all four parameters present.
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const { status, code, message } = toErrorResponse(err);
    res.status(status).json({ error: { code, message } });
  });

  return { app, hashToken };
}

describe('bearer-token auth middleware', () => {
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

  it('rejects a request with no Authorization header as 401 unauthorized', async () => {
    const { app } = await buildTestApp();

    const res = await request(app).get('/protected');

    expect(res.status).toBe(401);
    expect(res.body).toEqual({
      error: { code: 'unauthorized', message: 'A valid Bearer token is required.' },
    });
  });

  it('rejects a non-Bearer Authorization header as 401 unauthorized', async () => {
    const { app } = await buildTestApp();

    const res = await request(app).get('/protected').set('Authorization', 'Basic dXNlcjpwYXNz');

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('unauthorized');
  });

  it('rejects an empty Bearer token as 401 unauthorized', async () => {
    const { app } = await buildTestApp();

    const res = await request(app).get('/protected').set('Authorization', 'Bearer ');

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('unauthorized');
  });

  it('rejects a well-formed but unknown token as 401 (stub lookup always misses)', async () => {
    const { app } = await buildTestApp();

    const res = await request(app).get('/protected').set('Authorization', 'Bearer some-ha-token');

    expect(res.status).toBe(401);
    expect(res.body).toEqual({
      error: { code: 'unauthorized', message: 'Invalid or unknown Home Assistant token.' },
    });
  });

  it('hashToken produces a stable, hex-encoded SHA-256 digest', async () => {
    const { hashToken } = await buildTestApp();
    const digest = hashToken('some-ha-token');

    expect(digest).toBe(hashToken('some-ha-token'));
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(digest).not.toBe(hashToken('a-different-token'));
  });
});
