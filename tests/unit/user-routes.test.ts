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

class MockDriver {
  controller = { nodes: new Map<number, object>() };
}

async function buildHarness(): Promise<{ app: Express; userRepo: UserRepository }> {
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
  const app = createApp({ panelService, userRepo, zoneRepo, sensorRepo, lockoutService, driver });

  return { app, userRepo };
}

async function loginAsAdmin(app: Express, userRepo: UserRepository) {
  userRepo.create({ name: 'Owner', role: 'administrator', code: 'admin1' });
  const agent = request.agent(app);
  await agent.post('/api/v1/auth/login').send({ code: 'admin1' }).expect(200);
  return agent;
}

describe('user routes', () => {
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

  it('rejects GET /users with no auth as 401', async () => {
    const { app } = await buildHarness();

    const res = await request(app).get('/api/v1/users');

    expect(res.status).toBe(401);
  });

  it('lists users without leaking credentialHash', async () => {
    const { app, userRepo } = await buildHarness();
    const agent = await loginAsAdmin(app, userRepo);

    const res = await agent.get('/api/v1/users');

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toMatchObject({ name: 'Owner', role: 'administrator' });
    expect(res.body[0].credentialHash).toBeUndefined();
  });

  it('rejects GET /users from a member as 403', async () => {
    const { app, userRepo } = await buildHarness();
    userRepo.create({ name: 'Mem', role: 'member', code: 'member1' });
    const agent = request.agent(app);
    await agent.post('/api/v1/auth/login').send({ code: 'member1' }).expect(200);

    const res = await agent.get('/api/v1/users');

    expect(res.status).toBe(403);
  });

  it('creates a member user without leaking credentialHash', async () => {
    const { app, userRepo } = await buildHarness();
    const agent = await loginAsAdmin(app, userRepo);

    const res = await agent.post('/api/v1/users').send({ name: 'Mem', role: 'member', code: 'member1' });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ name: 'Mem', role: 'member' });
    expect(res.body.credentialHash).toBeUndefined();
  });

  it('creates a guest user, converting an ISO guestExpiresAt string to epoch ms', async () => {
    const { app, userRepo } = await buildHarness();
    const agent = await loginAsAdmin(app, userRepo);
    const isoExpiry = new Date(Date.now() + 100_000).toISOString();

    const res = await agent
      .post('/api/v1/users')
      .send({ name: 'Guest', role: 'guest', code: 'guestcode', guestExpiresAt: isoExpiry });

    expect(res.status).toBe(201);
    expect(res.body.guestExpiresAt).toBe(new Date(isoExpiry).getTime());
  });

  it('rejects a guest with neither guestExpiresAt nor guestZoneId as 400', async () => {
    const { app, userRepo } = await buildHarness();
    const agent = await loginAsAdmin(app, userRepo);

    const res = await agent.post('/api/v1/users').send({ name: 'Guest', role: 'guest', code: 'guestcode' });

    expect(res.status).toBe(400);
  });

  it('rejects an invalid role as 400', async () => {
    const { app, userRepo } = await buildHarness();
    const agent = await loginAsAdmin(app, userRepo);

    const res = await agent.post('/api/v1/users').send({ name: 'X', role: 'superadmin', code: 'x' });

    expect(res.status).toBe(400);
  });

  it('rejects a missing code as 400', async () => {
    const { app, userRepo } = await buildHarness();
    const agent = await loginAsAdmin(app, userRepo);

    const res = await agent.post('/api/v1/users').send({ name: 'X', role: 'member' });

    expect(res.status).toBe(400);
  });

  it('rejects user creation from a member as 403', async () => {
    const { app, userRepo } = await buildHarness();
    userRepo.create({ name: 'Mem', role: 'member', code: 'member1' });
    const agent = request.agent(app);
    await agent.post('/api/v1/auth/login').send({ code: 'member1' }).expect(200);

    const res = await agent.post('/api/v1/users').send({ name: 'X', role: 'member', code: 'x' });

    expect(res.status).toBe(403);
  });

  it('deletes a user as administrator', async () => {
    const { app, userRepo } = await buildHarness();
    const agent = await loginAsAdmin(app, userRepo);
    const created = (await agent.post('/api/v1/users').send({ name: 'Mem', role: 'member', code: 'member1' })).body;

    const res = await agent.delete(`/api/v1/users/${created.id}`);

    expect(res.status).toBe(204);
    expect(userRepo.findById(created.id)).toBeUndefined();
  });

  it('rejects delete from a member as 403', async () => {
    const { app, userRepo } = await buildHarness();
    const adminAgent = await loginAsAdmin(app, userRepo);
    const created = (await adminAgent.post('/api/v1/users').send({ name: 'Mem', role: 'member', code: 'member1' }))
      .body;
    const memberAgent = request.agent(app);
    await memberAgent.post('/api/v1/auth/login').send({ code: 'member1' }).expect(200);

    const res = await memberAgent.delete(`/api/v1/users/${created.id}`);

    expect(res.status).toBe(403);
  });
});
