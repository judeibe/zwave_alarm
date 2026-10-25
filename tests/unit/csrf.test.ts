import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';

// src/api/app.js (via ApiError) pulls in the config loader, which validates required env vars at import time.
let verifySameOrigin: typeof import('../../src/auth/csrf.js').verifySameOrigin;

beforeAll(async () => {
  process.env.SERIAL_PORT = '/dev/ttyACM0';
  process.env.DB_PATH = ':memory:';
  process.env.HTTP_PORT = '3000';
  process.env.ZWAVE_SERVER_PORT = '3001';
  process.env.SESSION_SECRET = 'test-secret-0123456789abcdef0123456789';
  ({ verifySameOrigin } = await import('../../src/auth/csrf.js'));
});

function run(method: string, headers: Record<string, string>) {
  const next = vi.fn();
  verifySameOrigin({ method, headers } as unknown as Request, {} as Response, next);
  return next.mock.calls[0]?.[0] as { status?: number } | undefined;
}

describe('verifySameOrigin', () => {
  it('lets safe methods through whatever the origin', () => {
    expect(run('GET', { host: 'alarm:3000', origin: 'https://evil.example' })).toBeUndefined();
  });

  it('lets a same-origin unsafe request through', () => {
    expect(run('POST', { host: 'alarm:3000', origin: 'http://alarm:3000' })).toBeUndefined();
    expect(run('PATCH', { host: 'alarm:3000', referer: 'http://alarm:3000/dashboard' })).toBeUndefined();
  });

  it('rejects a cross-origin unsafe request with 403', () => {
    expect(run('POST', { host: 'alarm:3000', origin: 'https://evil.example' })?.status).toBe(403);
    expect(run('DELETE', { host: 'alarm:3000', origin: 'http://alarm:3001' })?.status).toBe(403);
    expect(run('PUT', { host: 'alarm:3000', origin: 'not a url' })?.status).toBe(403);
  });

  it('lets non-browser and bearer-token requests through', () => {
    expect(run('POST', { host: 'alarm:3000' })).toBeUndefined();
    expect(run('POST', { host: 'alarm:3000', origin: 'https://evil.example', authorization: 'Bearer x' })).toBeUndefined();
  });
});
