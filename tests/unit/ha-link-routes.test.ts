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
import type { HaLinkRepository } from '../../src/db/repositories/ha-link-repository.js';

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

async function buildHarness(): Promise<{ app: Express; userRepo: UserRepository; haLinkRepo: HaLinkRepository }> {
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

  // Dynamically imported alongside createApp: HaLinkRepository transitively
  // imports src/auth/token.js -> src/api/app.js -> src/auth/session.js ->
  // src/config/index.js, which validates required env vars at import time.
  const { createApp } = await import('../../src/api/app.js');
  const { HaLinkRepository } = await import('../../src/db/repositories/ha-link-repository.js');
  const haLinkRepo = new HaLinkRepository(db);
  const app = createApp({ panelService, userRepo, zoneRepo, sensorRepo, lockoutService, eventRepo, haLinkRepo, driver });

  return { app, userRepo, haLinkRepo };
}

async function loginAsAdmin(app: Express, userRepo: UserRepository) {
  userRepo.create({ name: 'Owner', role: 'administrator', code: 'admin1' });
  const agent = request.agent(app);
  await agent.post('/api/v1/auth/login').send({ code: 'admin1' }).expect(200);
  return agent;
}

describe('Home Assistant link routes', () => {
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

  it('rejects POST /ha-links with no auth as 401', async () => {
    const { app } = await buildHarness();

    const res = await request(app).post('/api/v1/ha-links').send({ label: 'Living Room HA' });

    expect(res.status).toBe(401);
  });

  it('rejects POST /ha-links from a member as 403', async () => {
    const { app, userRepo } = await buildHarness();
    userRepo.create({ name: 'Mem', role: 'member', code: 'member1' });
    const agent = request.agent(app);
    await agent.post('/api/v1/auth/login').send({ code: 'member1' }).expect(200);

    const res = await agent.post('/api/v1/ha-links').send({ label: 'Living Room HA' });

    expect(res.status).toBe(403);
  });

  it('rejects a missing label as 400', async () => {
    const { app, userRepo } = await buildHarness();
    const agent = await loginAsAdmin(app, userRepo);

    const res = await agent.post('/api/v1/ha-links').send({});

    expect(res.status).toBe(400);
  });

  it('creates a link as administrator, returning the plaintext token once and never the hash', async () => {
    const { app, userRepo, haLinkRepo } = await buildHarness();
    const agent = await loginAsAdmin(app, userRepo);

    const res = await agent.post('/api/v1/ha-links').send({ label: 'Living Room HA' });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ label: 'Living Room HA', connectionStatus: 'disconnected', lastSeenAt: null });
    expect(typeof res.body.token).toBe('string');
    expect(res.body.token.length).toBeGreaterThan(0);
    expect(res.body.apiTokenHash).toBeUndefined();

    const links = haLinkRepo.list();
    expect(links).toHaveLength(1);
    expect(links[0].id).toBe(res.body.id);
  });

  it('issues a token that requireHaToken (src/auth/token.ts) then accepts on other routes', async () => {
    const { app, userRepo } = await buildHarness();
    const agent = await loginAsAdmin(app, userRepo);
    const created = (await agent.post('/api/v1/ha-links').send({ label: 'Living Room HA' })).body;

    const res = await request(app).get('/api/v1/panel').set('Authorization', `Bearer ${created.token}`);

    expect(res.status).toBe(200);
  });

  it('deletes a link as administrator', async () => {
    const { app, userRepo, haLinkRepo } = await buildHarness();
    const agent = await loginAsAdmin(app, userRepo);
    const created = (await agent.post('/api/v1/ha-links').send({ label: 'Living Room HA' })).body;

    const res = await agent.delete(`/api/v1/ha-links/${created.id}`);

    expect(res.status).toBe(204);
    expect(haLinkRepo.list()).toHaveLength(0);
  });

  it('rejects delete from a member as 403', async () => {
    const { app, userRepo } = await buildHarness();
    const adminAgent = await loginAsAdmin(app, userRepo);
    const created = (await adminAgent.post('/api/v1/ha-links').send({ label: 'Living Room HA' })).body;
    userRepo.create({ name: 'Mem', role: 'member', code: 'member1' });
    const memberAgent = request.agent(app);
    await memberAgent.post('/api/v1/auth/login').send({ code: 'member1' }).expect(200);

    const res = await memberAgent.delete(`/api/v1/ha-links/${created.id}`);

    expect(res.status).toBe(403);
  });
});
