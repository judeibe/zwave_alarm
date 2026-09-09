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
  process.env.SESSION_SECRET = 'test-secret';
}

class MockNodeMap {
  private readonly byId = new Map<number, object>();
  get(id: number): object | undefined {
    return this.byId.get(id);
  }
}
class MockController {
  nodes = new MockNodeMap();
}
class MockDriver {
  controller = new MockController();
}

/**
 * createApp() (via session.ts/authorize.ts) pulls in src/config/index.ts,
 * which validates required env vars *at import time* — this dynamically
 * imports after env vars are in place, mirroring tests/unit/session.test.ts's
 * precedent.
 */
async function buildHarness(): Promise<{ app: Express; userRepo: UserRepository; lockoutPolicyRepo: LockoutPolicyRepository }> {
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

  const { createApp } = await import('../../src/api/app.js');
  const app = createApp({ panelService, userRepo, zoneRepo, sensorRepo, lockoutService, eventRepo, driver });

  return { app, userRepo, lockoutPolicyRepo };
}

describe('auth routes', () => {
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

  it('logs in with a valid code and sets a session cookie', async () => {
    const { app, userRepo } = await buildHarness();
    userRepo.create({ name: 'Owner', role: 'administrator', code: '123456' });

    const res = await request(app).post('/api/v1/auth/login').send({ code: '123456' });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ name: 'Owner', role: 'administrator' });
    expect(res.headers['set-cookie']).toBeDefined();
  });

  it('rejects a code that matches no account as 401', async () => {
    const { app } = await buildHarness();

    const res = await request(app).post('/api/v1/auth/login').send({ code: 'nope' });

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('unauthorized');
  });

  it('rejects a missing "code" field as 400', async () => {
    const { app } = await buildHarness();

    const res = await request(app).post('/api/v1/auth/login').send({});

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('bad_request');
  });

  it('rejects login for an already-locked account as 423', async () => {
    const { app, userRepo } = await buildHarness();
    const user = userRepo.create({ name: 'Owner', role: 'administrator', code: '123456' });
    userRepo.lock(user.id, 300);

    const res = await request(app).post('/api/v1/auth/login').send({ code: '123456' });

    expect(res.status).toBe(423);
    expect(res.body.error.code).toBe('locked');
  });

  it('rejects login for an expired guest code as 401', async () => {
    const { app, userRepo } = await buildHarness();
    userRepo.create({
      name: 'Guest',
      role: 'guest',
      code: 'guestcode',
      guestExpiresAt: Date.now() - 1_000,
    });

    const res = await request(app).post('/api/v1/auth/login').send({ code: 'guestcode' });

    expect(res.status).toBe(401);
  });

  it('resets failedAttemptCount on a successful login', async () => {
    const { app, userRepo } = await buildHarness();
    const user = userRepo.create({ name: 'Owner', role: 'administrator', code: '123456' });
    userRepo.incrementFailedAttempts(user.id);
    userRepo.incrementFailedAttempts(user.id);

    await request(app).post('/api/v1/auth/login').send({ code: '123456' }).expect(200);

    expect(userRepo.findById(user.id)?.failedAttemptCount).toBe(0);
  });

  it('ends the session on logout', async () => {
    const { app, userRepo } = await buildHarness();
    userRepo.create({ name: 'Owner', role: 'administrator', code: '123456' });
    const agent = request.agent(app);
    await agent.post('/api/v1/auth/login').send({ code: '123456' }).expect(200);

    await agent.post('/api/v1/auth/logout').expect(200);
    const res = await agent.get('/api/v1/panel');

    expect(res.status).toBe(401);
  });
});
