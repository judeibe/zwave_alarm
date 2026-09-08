import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const ENV_KEYS = ['SERIAL_PORT', 'DB_PATH', 'HTTP_PORT', 'ZWAVE_SERVER_PORT', 'SESSION_SECRET'] as const;

function setEnv() {
  process.env.SERIAL_PORT = '/dev/ttyACM0';
  process.env.DB_PATH = ':memory:';
  process.env.HTTP_PORT = '3000';
  process.env.ZWAVE_SERVER_PORT = '3001';
  process.env.SESSION_SECRET = 'test-secret';
}

async function buildTestApp() {
  const { sessionMiddleware, requireSession } = await import('../../src/auth/session.js');
  const { toErrorResponse } = await import('../../src/api/app.js');

  const app = express();
  app.use(sessionMiddleware);

  app.post('/login', (req, res) => {
    req.session.userId = 'user-1';
    req.session.role = 'administrator';
    res.status(200).json({ ok: true });
  });

  app.get('/protected', requireSession, (req, res) => {
    res.status(200).json({ userId: req.session.userId, role: req.session.role });
  });

  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- Express only recognizes error middleware with all four parameters present.
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const { status, code, message } = toErrorResponse(err);
    res.status(status).json({ error: { code, message } });
  });

  return app;
}

describe('session auth middleware', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    setEnv();
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      delete process.env[key];
    }
    process.env = { ...originalEnv };
  });

  it('rejects a request with no session cookie as 401 unauthorized', async () => {
    const app = await buildTestApp();

    const res = await request(app).get('/protected');

    expect(res.status).toBe(401);
    expect(res.body).toEqual({
      error: { code: 'unauthorized', message: 'A valid session is required.' },
    });
  });

  it('allows a request through once the session has a userId', async () => {
    const app = await buildTestApp();
    const agent = request.agent(app);

    await agent.post('/login').expect(200);
    const res = await agent.get('/protected');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ userId: 'user-1', role: 'administrator' });
  });

  it('sets an httpOnly session cookie on login', async () => {
    const app = await buildTestApp();

    const res = await request(app).post('/login');

    const setCookie = res.headers['set-cookie'] as unknown as string[];
    expect(setCookie).toBeDefined();
    expect(setCookie[0]).toContain('zwave_alarm.sid=');
    expect(setCookie[0].toLowerCase()).toContain('httponly');
  });

  it('does not treat two independent clients as sharing a session', async () => {
    const app = await buildTestApp();
    const agentA = request.agent(app);
    const agentB = request.agent(app);

    await agentA.post('/login').expect(200);
    const resA = await agentA.get('/protected');
    const resB = await agentB.get('/protected');

    expect(resA.status).toBe(200);
    expect(resB.status).toBe(401);
  });
});
