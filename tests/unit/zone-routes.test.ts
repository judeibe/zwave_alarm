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

class MockNodeMap {
  private readonly byId = new Map<number, object>();
  add(id: number, extra: object = {}): void {
    this.byId.set(id, { nodeId: id, status: 4, ...extra });
  }
  get(id: number): object | undefined {
    return this.byId.get(id);
  }
  values(): IterableIterator<object> {
    return this.byId.values();
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

  // Dynamically imported alongside createApp: HaLinkRepository transitively
  // imports src/auth/token.js -> src/api/app.js -> src/auth/session.js ->
  // src/config/index.js, which validates required env vars at import time.
  const { createApp } = await import('../../src/api/app.js');
  const { HaLinkRepository } = await import('../../src/db/repositories/ha-link-repository.js');
  const haLinkRepo = new HaLinkRepository(db);
  const app = createApp({ panelService, userRepo, zoneRepo, sensorRepo, lockoutService, eventRepo, haLinkRepo, driver });

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
  describe('configuration panel endpoints', () => {
    it('creates a zone with a description and rejects a duplicate name', async () => {
      const { app, userRepo } = await buildHarness();
      const agent = await loginAs(app, userRepo, 'administrator', 'admin1');

      const created = await agent.post('/api/v1/zones').send({ name: 'Garage', description: 'Side entry' });
      const dup = await agent.post('/api/v1/zones').send({ name: 'garage' });

      expect(created.status).toBe(201);
      expect(created.body.description).toBe('Side entry');
      expect(dup.status).toBe(409);
    });

    it('PATCHes a zone, 404s an unknown one, 400s an empty body, 409s a name clash', async () => {
      const { app, userRepo } = await buildHarness();
      const agent = await loginAs(app, userRepo, 'administrator', 'admin1');
      const a = (await agent.post('/api/v1/zones').send({ name: 'A' })).body;
      await agent.post('/api/v1/zones').send({ name: 'B' });

      const ok = await agent.patch(`/api/v1/zones/${a.id}`).send({ name: 'A2', description: 'x' });
      const missing = await agent.patch('/api/v1/zones/nope').send({ name: 'Z' });
      const empty = await agent.patch(`/api/v1/zones/${a.id}`).send({});
      const clash = await agent.patch(`/api/v1/zones/${a.id}`).send({ name: 'b' });

      expect(ok.status).toBe(200);
      expect(ok.body).toMatchObject({ name: 'A2', description: 'x' });
      expect(missing.status).toBe(404);
      expect(empty.status).toBe(400);
      expect(clash.status).toBe(409);
    });

    it('refuses to delete a zone with sensors unless forced', async () => {
      const { app, userRepo, nodeMap } = await buildHarness();
      const agent = await loginAs(app, userRepo, 'administrator', 'admin1');
      nodeMap.add(5);
      const zone = (await agent.post('/api/v1/zones').send({ name: 'Hall' })).body;
      await agent.post(`/api/v1/zones/${zone.id}/sensors`).send({ zwaveNodeId: 5, name: 'PIR', category: 'intrusion' });

      const blocked = await agent.delete(`/api/v1/zones/${zone.id}`);
      const forced = await agent.delete(`/api/v1/zones/${zone.id}?force=true`);
      const gone = await agent.get('/api/v1/zones');

      expect(blocked.status).toBe(409);
      expect(blocked.body.error.code).toBe('zone_not_empty');
      expect(forced.status).toBe(204);
      expect(gone.body).toEqual([]);
    });

    it('refuses to delete a zone a guest is restricted to', async () => {
      const { app, userRepo } = await buildHarness();
      const agent = await loginAs(app, userRepo, 'administrator', 'admin1');
      const zone = (await agent.post('/api/v1/zones').send({ name: 'Shed' })).body;
      await agent.post('/api/v1/users').send({ name: 'G', role: 'guest', code: 'gg11', guestZoneId: zone.id });

      const res = await agent.delete(`/api/v1/zones/${zone.id}?force=true`);

      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('zone_in_use');
    });

    it('lists only unassigned, non-controller nodes as discoverable', async () => {
      const { app, userRepo, nodeMap } = await buildHarness();
      const agent = await loginAs(app, userRepo, 'administrator', 'admin1');
      nodeMap.add(1, { isControllerNode: true });
      nodeMap.add(2, { name: 'Door', deviceConfig: { manufacturer: 'Aeotec', label: 'Door Sensor' } });
      nodeMap.add(3, { status: 3 });
      const zone = (await agent.post('/api/v1/zones').send({ name: 'Z' })).body;
      await agent.post(`/api/v1/zones/${zone.id}/sensors`).send({ zwaveNodeId: 3, name: 'S', category: 'intrusion' });
      nodeMap.add(4, { status: 1 });

      const res = await agent.get('/api/v1/sensors/discoverable');

      expect(res.status).toBe(200);
      expect(res.body).toEqual([
        { zwaveNodeId: 2, name: 'Door', manufacturer: 'Aeotec', product: 'Door Sensor', suggestedCategory: null, status: 'alive' },
        { zwaveNodeId: 4, name: null, manufacturer: null, product: null, suggestedCategory: null, status: 'asleep' },
      ]);
    });

    it('restricts discovery and sensor edits to administrators', async () => {
      const { app, userRepo } = await buildHarness();
      const agent = await loginAs(app, userRepo, 'member', 'member1');

      expect((await agent.get('/api/v1/sensors/discoverable')).status).toBe(403);
      expect((await agent.patch('/api/v1/sensors/x').send({ name: 'n' })).status).toBe(403);
      expect((await agent.delete('/api/v1/sensors/x')).status).toBe(403);
    });

    it('moves, renames and unassigns a sensor', async () => {
      const { app, userRepo, nodeMap } = await buildHarness();
      const agent = await loginAs(app, userRepo, 'administrator', 'admin1');
      nodeMap.add(7);
      const z1 = (await agent.post('/api/v1/zones').send({ name: 'One' })).body;
      const z2 = (await agent.post('/api/v1/zones').send({ name: 'Two' })).body;
      const sensor = (
        await agent.post(`/api/v1/zones/${z1.id}/sensors`).send({ zwaveNodeId: 7, name: 'S', category: 'intrusion' })
      ).body;

      const moved = await agent.patch(`/api/v1/sensors/${sensor.id}`).send({ zoneId: z2.id, name: 'S2', category: 'life-safety' });
      const badZone = await agent.patch(`/api/v1/sensors/${sensor.id}`).send({ zoneId: 'nope' });
      const removed = await agent.delete(`/api/v1/sensors/${sensor.id}`);
      const again = await agent.delete(`/api/v1/sensors/${sensor.id}`);

      expect(moved.status).toBe(200);
      expect(moved.body).toMatchObject({ zoneId: z2.id, name: 'S2', category: 'life-safety' });
      expect(badZone.status).toBe(404);
      expect(removed.status).toBe(204);
      expect(again.status).toBe(404);
    });
  });
});
