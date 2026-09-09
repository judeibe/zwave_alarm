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
 * authorize.ts pulls in session.ts/token.ts, which (since T027) pull in
 * src/config/index.ts and validate required env vars *at import time* — this
 * dynamically imports after env vars are in place, mirroring
 * tests/unit/session.test.ts's precedent.
 */
async function buildTestApp() {
  const { requireAuth, requireRole } = await import('../../src/auth/authorize.js');
  const { sessionMiddleware } = await import('../../src/auth/session.js');
  const { toErrorResponse } = await import('../../src/api/app.js');

  const app = express();
  app.use(express.json());
  app.use(sessionMiddleware);

  app.post('/login', (req, res) => {
    const role = (req.body?.role as string | undefined) ?? 'administrator';
    req.session.userId = 'user-1';
    req.session.role = role as 'administrator' | 'member' | 'guest';
    res.status(200).json({ ok: true });
  });

  app.get('/any-auth', requireAuth, (req, res) => {
    res.status(200).json({ userId: req.session?.userId });
  });

  app.get('/admin-only', requireAuth, requireRole('administrator'), (_req, res) => {
    res.status(200).json({ ok: true });
  });

  app.get('/admin-or-member', requireAuth, requireRole('administrator', 'member'), (_req, res) => {
    res.status(200).json({ ok: true });
  });

  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- Express only recognizes error middleware with all four parameters present.
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const { status, code, message } = toErrorResponse(err);
    res.status(status).json({ error: { code, message } });
  });

  return app;
}

describe('requireAuth / requireRole', () => {
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

  it('rejects a request with neither a session nor a bearer token as 401', async () => {
    const app = await buildTestApp();

    const res = await request(app).get('/any-auth');

    expect(res.status).toBe(401);
  });

  it('allows a request through requireAuth once a session is established', async () => {
    const app = await buildTestApp();
    const agent = request.agent(app);

    await agent.post('/login').expect(200);
    const res = await agent.get('/any-auth');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ userId: 'user-1' });
  });

  it('falls back to the bearer-token check when no session cookie is present', async () => {
    const app = await buildTestApp();

    const res = await request(app).get('/any-auth').set('Authorization', 'Bearer some-token');

    // requireHaToken's lookup always misses today (Phase 03 dependency), so
    // this still 401s -- but via the HA-token path, not the session path.
    expect(res.status).toBe(401);
    expect(res.body.error.message).toBe('Invalid or unknown Home Assistant token.');
  });

  it('allows an administrator session through requireRole("administrator")', async () => {
    const app = await buildTestApp();
    const agent = request.agent(app);

    await agent.post('/login').send({ role: 'administrator' }).expect(200);
    const res = await agent.get('/admin-only');

    expect(res.status).toBe(200);
  });

  it('rejects a member session from an administrator-only route as 403', async () => {
    const app = await buildTestApp();
    const agent = request.agent(app);

    await agent.post('/login').send({ role: 'member' }).expect(200);
    const res = await agent.get('/admin-only');

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('forbidden');
  });

  it('rejects a guest session from an administrator-or-member route as 403', async () => {
    const app = await buildTestApp();
    const agent = request.agent(app);

    await agent.post('/login').send({ role: 'guest' }).expect(200);
    const res = await agent.get('/admin-or-member');

    expect(res.status).toBe(403);
  });

  it('rejects requireRole with no prior authentication as 401, not 403', async () => {
    const app = await buildTestApp();

    const res = await request(app).get('/admin-only');

    expect(res.status).toBe(401);
  });
});
