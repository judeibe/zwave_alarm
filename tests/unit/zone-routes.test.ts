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
  add(id: number): void {
    this.byId.set(id, {});
  }
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

async function buildHarness(): Promise<{ app: Express; userRepo: UserRepository; nodeMap: MockNodeMap }> {
  const db = createDatabase(':memory:');
  const panelRepo = new AlarmPanelRepository(db);
  const eventRepo = new EventRepository(db);
  const zoneRepo = new ZoneRepository(db);
  const sensorRepo = new SensorRepository(db);
  const userRepo = new UserRepository(db);
  const lockoutPolicyRepo = new LockoutPolicyRepository(db);
  const panelService = new PanelService(panelRepo, eventRepo);
  const lockoutService = new LockoutService(userRepo, lockoutPolicyRepo, eventRepo, panelService);
  const mockDriver = new MockDriver();
  const driver = mockDriver as unknown as Driver;

  const { createApp } = await import('../../src/api/app.js');
  const app = createApp({ panelService, userRepo, zoneRepo, sensorRepo, lockoutService, eventRepo, driver });

  return { app, userRepo, nodeMap: mockDriver.controller.nodes };
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

describe('zone routes', () => {
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

  it('rejects GET /zones with no auth as 401', async () => {
    const { app } = await buildHarness();

    const res = await request(app).get('/api/v1/zones');

    expect(res.status).toBe(401);
  });

  it('returns an empty list before any zones are created', async () => {
    const { app, userRepo } = await buildHarness();
    const agent = await loginAs(app, userRepo, 'member', 'member1');

    const res = await agent.get('/api/v1/zones');

    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('rejects GET /zones for a guest as 403', async () => {
    const { app, userRepo } = await buildHarness();
    const agent = await loginAs(app, userRepo, 'guest', 'guestcode');

    const res = await agent.get('/api/v1/zones');

    expect(res.status).toBe(403);
  });

  it('creates a zone as administrator', async () => {
    const { app, userRepo } = await buildHarness();
    const agent = await loginAs(app, userRepo, 'administrator', 'admin1');

    const res = await agent.post('/api/v1/zones').send({ name: 'Front Door' });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ name: 'Front Door', sensors: [] });
  });

  it('rejects zone creation from a member as 403', async () => {
    const { app, userRepo } = await buildHarness();
    const agent = await loginAs(app, userRepo, 'member', 'member1');

    const res = await agent.post('/api/v1/zones').send({ name: 'Front Door' });

    expect(res.status).toBe(403);
  });

  it('rejects zone creation with a missing name as 400', async () => {
    const { app, userRepo } = await buildHarness();
    const agent = await loginAs(app, userRepo, 'administrator', 'admin1');

    const res = await agent.post('/api/v1/zones').send({});

    expect(res.status).toBe(400);
  });

  it('assigns a known zwave node to a zone as administrator', async () => {
    const { app, userRepo, nodeMap } = await buildHarness();
    const agent = await loginAs(app, userRepo, 'administrator', 'admin1');
    nodeMap.add(10);
    const zone = (await agent.post('/api/v1/zones').send({ name: 'Front Door' })).body;

    const res = await agent
      .post(`/api/v1/zones/${zone.id}/sensors`)
      .send({ zwaveNodeId: 10, name: 'Door contact', category: 'intrusion' });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ zwaveNodeId: 10, zoneId: zone.id, category: 'intrusion' });
  });

  it('rejects an unknown zwave node as 400', async () => {
    const { app, userRepo } = await buildHarness();
    const agent = await loginAs(app, userRepo, 'administrator', 'admin1');
    const zone = (await agent.post('/api/v1/zones').send({ name: 'Front Door' })).body;

    const res = await agent
      .post(`/api/v1/zones/${zone.id}/sensors`)
      .send({ zwaveNodeId: 99, name: 'Door contact', category: 'intrusion' });

    expect(res.status).toBe(400);
  });

  it('rejects assigning to a nonexistent zone as 404', async () => {
    const { app, userRepo, nodeMap } = await buildHarness();
    const agent = await loginAs(app, userRepo, 'administrator', 'admin1');
    nodeMap.add(10);

    const res = await agent
      .post('/api/v1/zones/does-not-exist/sensors')
      .send({ zwaveNodeId: 10, name: 'Door contact', category: 'intrusion' });

    expect(res.status).toBe(404);
  });

  it('rejects a node already assigned to another zone as 409', async () => {
    const { app, userRepo, nodeMap } = await buildHarness();
    const agent = await loginAs(app, userRepo, 'administrator', 'admin1');
    nodeMap.add(10);
    const zoneA = (await agent.post('/api/v1/zones').send({ name: 'Front Door' })).body;
    const zoneB = (await agent.post('/api/v1/zones').send({ name: 'Garage' })).body;
    await agent
      .post(`/api/v1/zones/${zoneA.id}/sensors`)
      .send({ zwaveNodeId: 10, name: 'Door contact', category: 'intrusion' })
      .expect(201);

    const res = await agent
      .post(`/api/v1/zones/${zoneB.id}/sensors`)
      .send({ zwaveNodeId: 10, name: 'Duplicate', category: 'intrusion' });

    expect(res.status).toBe(409);
  });

  it('rejects an invalid category as 400', async () => {
    const { app, userRepo, nodeMap } = await buildHarness();
    const agent = await loginAs(app, userRepo, 'administrator', 'admin1');
    nodeMap.add(10);
    const zone = (await agent.post('/api/v1/zones').send({ name: 'Front Door' })).body;

    const res = await agent
      .post(`/api/v1/zones/${zone.id}/sensors`)
      .send({ zwaveNodeId: 10, name: 'Door contact', category: 'not-a-category' });

    expect(res.status).toBe(400);
  });

  it('rejects sensor assignment from a member as 403', async () => {
    const { app, userRepo, nodeMap } = await buildHarness();
    const adminAgent = await loginAs(app, userRepo, 'administrator', 'admin1');
    nodeMap.add(10);
    const zone = (await adminAgent.post('/api/v1/zones').send({ name: 'Front Door' })).body;
    const memberAgent = await loginAs(app, userRepo, 'member', 'member1');

    const res = await memberAgent
      .post(`/api/v1/zones/${zone.id}/sensors`)
      .send({ zwaveNodeId: 10, name: 'Door contact', category: 'intrusion' });

    expect(res.status).toBe(403);
  });
});
