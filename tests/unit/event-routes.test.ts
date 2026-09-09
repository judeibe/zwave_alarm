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
  get(): object | undefined {
    return undefined;
  }
}
class MockController {
  nodes = new MockNodeMap();
}
class MockDriver {
  controller = new MockController();
}

async function buildHarness(): Promise<{ app: Express; userRepo: UserRepository; eventRepo: EventRepository }> {
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

  return { app, userRepo, eventRepo };
}

async function loginAs(app: Express, userRepo: UserRepository, role: 'administrator' | 'member' | 'guest', code: string) {
  userRepo.create({
    name: role,
    role,
    code,
    guestExpiresAt: role === 'guest' ? Date.now() + 100_000 : undefined,
  });
  const agent = request.agent(app);
  await agent.post('/api/v1/auth/login').send({ code }).expect(200);
  return agent;
}

describe('event routes', () => {
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

  it('rejects GET /events with no auth as 401', async () => {
    const { app } = await buildHarness();

    const res = await request(app).get('/api/v1/events');

    expect(res.status).toBe(401);
  });

  it('rejects GET /events for a guest as 403', async () => {
    const { app, userRepo } = await buildHarness();
    const agent = await loginAs(app, userRepo, 'guest', 'guestcode');

    const res = await agent.get('/api/v1/events');

    expect(res.status).toBe(403);
  });

  it('returns events newest-first for a member', async () => {
    const { app, userRepo, eventRepo } = await buildHarness();
    const agent = await loginAs(app, userRepo, 'member', 'member1');
    const first = eventRepo.record({ type: 'armed', source: 'user' });
    const second = eventRepo.record({ type: 'disarmed', source: 'user' });

    const res = await agent.get('/api/v1/events');

    expect(res.status).toBe(200);
    expect(res.body.map((e: { id: string }) => e.id)).toEqual([second.id, first.id]);
  });

  it('filters by since', async () => {
    const { app, userRepo, eventRepo } = await buildHarness();
    const agent = await loginAs(app, userRepo, 'administrator', 'admin1');
    eventRepo.record({ type: 'armed', source: 'user' });
    const cutoff = Date.now() + 1;
    await new Promise((resolve) => setTimeout(resolve, 5));
    const after = eventRepo.record({ type: 'disarmed', source: 'user' });

    const res = await agent.get('/api/v1/events').query({ since: cutoff });

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].id).toBe(after.id);
  });

  it('caps results by limit', async () => {
    const { app, userRepo, eventRepo } = await buildHarness();
    const agent = await loginAs(app, userRepo, 'administrator', 'admin1');
    eventRepo.record({ type: 'armed', source: 'user' });
    eventRepo.record({ type: 'disarmed', source: 'user' });
    eventRepo.record({ type: 'armed', source: 'user' });

    const res = await agent.get('/api/v1/events').query({ limit: 2 });

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
  });

  it('rejects a non-numeric since as 400', async () => {
    const { app, userRepo } = await buildHarness();
    const agent = await loginAs(app, userRepo, 'administrator', 'admin1');

    const res = await agent.get('/api/v1/events').query({ since: 'not-a-number' });

    expect(res.status).toBe(400);
  });

  it('rejects a non-positive limit as 400', async () => {
    const { app, userRepo } = await buildHarness();
    const agent = await loginAs(app, userRepo, 'administrator', 'admin1');

    const res = await agent.get('/api/v1/events').query({ limit: '0' });

    expect(res.status).toBe(400);
  });
});
