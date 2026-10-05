import request from 'supertest';
import type { Express } from 'express';
import type { Driver } from 'zwave-js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDatabase } from '../../src/db/schema.js';
import { AlarmPanelRepository } from '../../src/alarm/panel-repository.js';
import { PanelService } from '../../src/alarm/panel-service.js';
import { EventRepository } from '../../src/events/event-repository.js';
import { ZoneRepository } from '../../src/db/repositories/zone-repository.js';
import { SensorRepository } from '../../src/db/repositories/sensor-repository.js';
import { UserRepository } from '../../src/auth/user-repository.js';
import { LockoutPolicyRepository } from '../../src/auth/lockout-policy-repository.js';
import { LockoutService } from '../../src/auth/lockout-service.js';

const ENV_KEYS = ['SERIAL_PORT', 'DB_PATH', 'HTTP_PORT', 'ZWAVE_SERVER_PORT', 'SESSION_SECRET'] as const;

function setEnv() {
  process.env.SERIAL_PORT = '/dev/ttyACM0';
  process.env.DB_PATH = ':memory:';
  process.env.HTTP_PORT = '3000';
  process.env.ZWAVE_SERVER_PORT = '3001';
  process.env.SESSION_SECRET = 'test-secret-0123456789abcdef0123456789';
}

class MockDriver {
  controller = { nodes: new Map<number, object>([[10, {}]]) };
}

async function buildHarness(): Promise<{ app: Express; userRepo: UserRepository; zoneRepo: ZoneRepository }> {
  const db = createDatabase(':memory:');
  const panelRepo = new AlarmPanelRepository(db);
  const eventRepo = new EventRepository(db);
  const zoneRepo = new ZoneRepository(db);
  const sensorRepo = new SensorRepository(db);
  const userRepo = new UserRepository(db);
  const lockoutPolicyRepo = new LockoutPolicyRepository(db);
  const panelService = new PanelService(panelRepo, eventRepo);
  const lockoutService = new LockoutService(userRepo, lockoutPolicyRepo, eventRepo, panelService);
  const driver = new MockDriver() as unknown as Driver;

  // Dynamic imports: src/config/index.ts validates required env vars at import time.
  const { createApp } = await import('../../src/api/app.js');
  const { HaLinkRepository } = await import('../../src/db/repositories/ha-link-repository.js');
  const haLinkRepo = new HaLinkRepository(db);
  const app = createApp({ panelService, userRepo, zoneRepo, sensorRepo, lockoutService, eventRepo, haLinkRepo, driver });

  return { app, userRepo, zoneRepo };
}

async function loginAsAdmin(app: Express, userRepo: UserRepository) {
  userRepo.create({ name: 'Owner', role: 'administrator', code: 'admin1' });
  const agent = request.agent(app);
  await agent.post('/api/v1/auth/login').send({ code: 'admin1' }).expect(200);
  return agent;
}

function expectBadRequest(res: request.Response) {
  expect(res.status).toBe(400);
  expect(res.body).toEqual({ error: { code: 'bad_request', message: expect.any(String) } });
}

describe('request validation', () => {
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

  describe('malformed bodies are rejected with 400 in the standard error format', () => {
    it.each([
      ['no body', undefined],
      ['empty object', {}],
      ['non-string code', { code: 123456 }],
      ['empty code', { code: '' }],
      ['oversized code', { code: 'x'.repeat(129) }],
    ])('POST /auth/login: %s', async (_label, body) => {
      const { app } = await buildHarness();
      expectBadRequest(await request(app).post('/api/v1/auth/login').send(body));
    });

    it('POST /auth/login: malformed JSON', async () => {
      const { app } = await buildHarness();
      const res = await request(app)
        .post('/api/v1/auth/login')
        .set('Content-Type', 'application/json')
        .send('{"code":');
      expectBadRequest(res);
    });

    it.each([
      ['/panel/arm', {}],
      ['/panel/arm', { mode: 'disarmed' }],
      ['/panel/disarm', {}],
      ['/panel/disarm', { code: 42 }],
      ['/zones', {}],
      ['/zones', { name: '' }],
      ['/zones/z1/sensors', { zwaveNodeId: '10', name: 'Door', category: 'intrusion' }],
      ['/zones/z1/sensors', { zwaveNodeId: 1.5, name: 'Door', category: 'intrusion' }],
      ['/zones/z1/sensors', { zwaveNodeId: 10, name: 'Door', category: 'fire' }],
      ['/zones/z1/sensors', { zwaveNodeId: 10, category: 'intrusion' }],
      ['/users', {}],
      ['/users', { name: 'A', role: 'owner', code: '1234' }],
      ['/users', { name: 'A', role: 'guest', code: '1234', guestExpiresAt: 'not-a-date' }],
      ['/users', { name: 'A', role: 'guest', code: '1234', guestZoneId: 7 }],
      ['/ha-links', {}],
      ['/ha-links', { label: '' }],
      ['/ha-links', { label: 5 }],
    ])('POST %s %j', async (path, body) => {
      const { app, userRepo } = await buildHarness();
      const agent = await loginAsAdmin(app, userRepo);

      expectBadRequest(await agent.post(`/api/v1${path}`).send(body));
    });

    it.each([['since=abc'], ['since='], ['limit=0'], ['limit=1.5'], ['limit=-3'], ['limit=']])(
      'GET /events?%s',
      async (query) => {
        const { app, userRepo } = await buildHarness();
        const agent = await loginAsAdmin(app, userRepo);

        expectBadRequest(await agent.get(`/api/v1/events?${query}`));
      },
    );

    it('accepts a valid events query', async () => {
      const { app, userRepo } = await buildHarness();
      const agent = await loginAsAdmin(app, userRepo);

      const res = await agent.get('/api/v1/events?since=0&limit=10');

      expect(res.status).toBe(200);
    });
  });

  it('checks authentication before validating the body', async () => {
    const { app, userRepo } = await buildHarness();
    userRepo.create({ name: 'Owner', role: 'administrator', code: 'admin1' });

    const res = await request(app).post('/api/v1/zones').send({});

    expect(res.status).toBe(401);
  });

  it('strips unknown body keys instead of passing them to the repository', async () => {
    const { app, userRepo } = await buildHarness();
    const agent = await loginAsAdmin(app, userRepo);

    const res = await agent.post('/api/v1/zones').send({ name: 'Front Door', id: 'attacker-chosen' });

    expect(res.status).toBe(201);
    expect(res.body.id).not.toBe('attacker-chosen');
  });

  describe('first-run administrator bootstrap', () => {
    it('lets an unauthenticated caller create the first administrator', async () => {
      const { app } = await buildHarness();

      const res = await request(app)
        .post('/api/v1/users')
        .send({ name: 'Owner', role: 'administrator', code: '123456' });

      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ name: 'Owner', role: 'administrator' });
      expect(res.body.credentialHash).toBeUndefined();
    });

    it('refuses to bootstrap a non-administrator', async () => {
      const { app } = await buildHarness();

      const res = await request(app).post('/api/v1/users').send({ name: 'Mem', role: 'member', code: '123456' });

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('forbidden');
    });

    it('requires an administrator session once any user exists', async () => {
      const { app } = await buildHarness();
      await request(app).post('/api/v1/users').send({ name: 'Owner', role: 'administrator', code: '123456' }).expect(201);

      const res = await request(app)
        .post('/api/v1/users')
        .send({ name: 'Intruder', role: 'administrator', code: '999999' });

      expect(res.status).toBe(401);
    });

    it('still validates the body during bootstrap', async () => {
      const { app } = await buildHarness();

      expectBadRequest(await request(app).post('/api/v1/users').send({ name: 'Owner' }));
    });
  });

  describe('login rate limit', () => {
    it('answers 429 once a client exceeds the failed-attempt budget', async () => {
      const { app } = await buildHarness();

      for (let attempt = 0; attempt < 5; attempt += 1) {
        await request(app).post('/api/v1/auth/login').send({ code: 'wrong' }).expect(401);
      }
      const res = await request(app).post('/api/v1/auth/login').send({ code: 'wrong' });

      expect(res.status).toBe(429);
      expect(res.body).toEqual({ error: { code: 'too_many_requests', message: expect.any(String) } });
    });

    it('keeps rejecting the correct code while throttled', async () => {
      const { app, userRepo } = await buildHarness();
      userRepo.create({ name: 'Owner', role: 'administrator', code: '123456' });

      for (let attempt = 0; attempt < 5; attempt += 1) {
        await request(app).post('/api/v1/auth/login').send({ code: 'wrong' });
      }
      const res = await request(app).post('/api/v1/auth/login').send({ code: '123456' });

      expect(res.status).toBe(429);
    });

    it('does not count successful logins against the budget', async () => {
      const { app, userRepo } = await buildHarness();
      userRepo.create({ name: 'Owner', role: 'administrator', code: '123456' });

      for (let attempt = 0; attempt < 8; attempt += 1) {
        await request(app).post('/api/v1/auth/login').send({ code: '123456' }).expect(200);
      }
    });

    it('does not throttle other endpoints', async () => {
      const { app, userRepo } = await buildHarness();
      const agent = await loginAsAdmin(app, userRepo);

      for (let attempt = 0; attempt < 8; attempt += 1) {
        await agent.get('/api/v1/panel').expect(200);
      }
    });
  });
});
