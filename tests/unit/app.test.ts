import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { ApiError, createApp, toErrorResponse } from '../../src/api/app.js';

describe('createApp', () => {
  it('returns 200 OK from /healthz', async () => {
    const app = createApp();

    const res = await request(app).get('/healthz');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
  });

  it('parses JSON request bodies', async () => {
    const app = createApp();
    app.post('/echo', (req, res) => {
      res.status(200).json(req.body);
    });

    const res = await request(app).post('/echo').send({ hello: 'world' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ hello: 'world' });
  });

  it('maps an ApiError to { status, code, message } from its own fields', () => {
    const err = new ApiError(409, 'conflict', 'native command already pending');

    expect(toErrorResponse(err)).toEqual({
      status: 409,
      code: 'conflict',
      message: 'native command already pending',
    });
  });

  it('maps an unexpected error to a 500 internal_error', () => {
    const err = new Error('unexpected failure');

    expect(toErrorResponse(err)).toEqual({
      status: 500,
      code: 'internal_error',
      message: 'unexpected failure',
    });
  });

  it('formats a malformed JSON body as a 400 bad_request', async () => {
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
});
