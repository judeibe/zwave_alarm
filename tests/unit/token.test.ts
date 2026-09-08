import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { hashToken, requireHaToken } from '../../src/auth/token.js';
import { toErrorResponse } from '../../src/api/app.js';

function buildTestApp() {
  const app = express();

  app.get('/protected', requireHaToken, (req, res) => {
    res.status(200).json({ haLink: req.haLink });
  });

  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- Express only recognizes error middleware with all four parameters present.
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const { status, code, message } = toErrorResponse(err);
    res.status(status).json({ error: { code, message } });
  });

  return app;
}

describe('bearer-token auth middleware', () => {
  it('rejects a request with no Authorization header as 401 unauthorized', async () => {
    const app = buildTestApp();

    const res = await request(app).get('/protected');

    expect(res.status).toBe(401);
    expect(res.body).toEqual({
      error: { code: 'unauthorized', message: 'A valid Bearer token is required.' },
    });
  });

  it('rejects a non-Bearer Authorization header as 401 unauthorized', async () => {
    const app = buildTestApp();

    const res = await request(app).get('/protected').set('Authorization', 'Basic dXNlcjpwYXNz');

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('unauthorized');
  });

  it('rejects an empty Bearer token as 401 unauthorized', async () => {
    const app = buildTestApp();

    const res = await request(app).get('/protected').set('Authorization', 'Bearer ');

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('unauthorized');
  });

  it('rejects a well-formed but unknown token as 401 (stub lookup always misses)', async () => {
    const app = buildTestApp();

    const res = await request(app).get('/protected').set('Authorization', 'Bearer some-ha-token');

    expect(res.status).toBe(401);
    expect(res.body).toEqual({
      error: { code: 'unauthorized', message: 'Invalid or unknown Home Assistant token.' },
    });
  });

  it('hashToken produces a stable, hex-encoded SHA-256 digest', () => {
    const digest = hashToken('some-ha-token');

    expect(digest).toBe(hashToken('some-ha-token'));
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(digest).not.toBe(hashToken('a-different-token'));
  });
});
