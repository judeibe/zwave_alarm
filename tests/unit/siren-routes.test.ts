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
import { AlarmEventRepository } from '../../src/alarm/alarm-event-repository.js';
import { SirenRepository } from '../../src/alarm/siren-repository.js';
import { AlarmEventService } from '../../src/alarm/alarm-event-service.js';
import { ModeConfigRepository } from '../../src/db/repositories/mode-config-repository.js';
import { UserRepository } from '../../src/auth/user-repository.js';
import { LockoutPolicyRepository } from '../../src/auth/lockout-policy-repository.js';
import { LockoutService } from '../../src/auth/lockout-service.js';

function setEnv() {
  process.env.SERIAL_PORT = '/dev/ttyACM0';
  process.env.DB_PATH = ':memory:';
  process.env.HTTP_PORT = '3000';
  process.env.ZWAVE_SERVER_PORT = '3001';
  process.env.SESSION_SECRET = 'test-secret-0123456789abcdef0123456789';
}

async function buildHarness() {
  const db = createDatabase(':memory:');
  const modeConfig = new ModeConfigRepository(db);
  modeConfig.ensureSeeded();
  const eventRepo = new EventRepository(db);
  const userRepo = new UserRepository(db);
  const alarmEvents = new AlarmEventService(new AlarmEventRepository(db));
  const sirenRepo = new SirenRepository(db);
  const sensorRepo = new SensorRepository(db);
  const zoneRepo = new ZoneRepository(db);
  const panelService = new PanelService(new AlarmPanelRepository(db), eventRepo, { modeConfig, sensorRepo, alarmEvents });
  const lockoutService = new LockoutService(userRepo, new LockoutPolicyRepository(db), eventRepo, panelService);
  const { createApp } = await import('../../src/api/app.js');
  const { HaLinkRepository } = await import('../../src/db/repositories/ha-link-repository.js');
  const app = createApp({
    panelService,
    userRepo,
    zoneRepo,
    sensorRepo,
    alarmEvents,
    sirenRepo,
    lockoutService,
    eventRepo,
    haLinkRepo: new HaLinkRepository(db),
    driver: { controller: { nodes: { get: (id: number) => (id === 5 || id === 6 ? {} : undefined) } } } as unknown as Driver,
  });
  return { app, userRepo, panelService, sensorRepo, zoneRepo, alarmEvents, sirenRepo };
}

async function loginAs(app: Express, userRepo: UserRepository, role: 'administrator' | 'member', code: string) {
  userRepo.create({ name: role, role, code });
  const agent = request.agent(app);
  await agent.post('/api/v1/auth/login').send({ code }).expect(200);
  return agent;
}

describe('siren routes', () => {
  const originalEnv = { ...process.env };

  beforeEach(setEnv);
  afterEach(() => {
    process.env = { ...originalEnv };
  });

  async function admin() {
    const harness = await buildHarness();
    return { ...harness, agent: await loginAs(harness.app, harness.userRepo, 'administrator', 'admin1') };
  }

  it('enrolls a base siren with a fixed 600 s and an outdoor one with its own duration (default 180 s)', async () => {
    const { agent } = await admin();

    const base = await agent.put('/api/v1/sirens/5').send({ kind: 'BASE' });
    const outdoor = await agent.put('/api/v1/sirens/6').send({ kind: 'OUTDOOR', name: 'Porch' });
    const resized = await agent.put('/api/v1/sirens/6').send({ kind: 'OUTDOOR', durationSec: 90 });

    expect(base.body).toMatchObject({ nodeId: 5, kind: 'BASE', durationSec: 600 });
    expect(outdoor.body).toMatchObject({ nodeId: 6, kind: 'OUTDOOR', name: 'Porch', durationSec: 180 });
    expect(resized.body).toMatchObject({ durationSec: 90, name: 'Porch' });
    expect((await agent.get('/api/v1/sirens')).body.map((siren: { nodeId: number }) => siren.nodeId)).toEqual([5, 6]);
  });

  it('rejects a duration on a non-outdoor siren, an out-of-range one, an unknown kind and an unknown node', async () => {
    const { agent } = await admin();

    expect((await agent.put('/api/v1/sirens/5').send({ kind: 'BASE', durationSec: 120 })).status).toBe(400);
    expect((await agent.put('/api/v1/sirens/6').send({ kind: 'OUTDOOR', durationSec: 59 })).status).toBe(400);
    expect((await agent.put('/api/v1/sirens/6').send({ kind: 'OUTDOOR', durationSec: 601 })).status).toBe(400);
    expect((await agent.put('/api/v1/sirens/6').send({ kind: 'KEYPAD' })).status).toBe(400);
    expect((await agent.put('/api/v1/sirens/99').send({ kind: 'BASE' })).status).toBe(400);
  });

  it('removes a siren, and 404s when it is not enrolled', async () => {
    const { agent } = await admin();
    await agent.put('/api/v1/sirens/5').send({ kind: 'BASE' });

    expect((await agent.delete('/api/v1/sirens/5')).status).toBe(204);
    expect((await agent.delete('/api/v1/sirens/5')).status).toBe(404);
  });

  it('lets a member list but not change sirens', async () => {
    const { app, userRepo } = await buildHarness();
    const member = await loginAs(app, userRepo, 'member', 'member1');

    expect((await member.get('/api/v1/sirens')).status).toBe(200);
    expect((await member.put('/api/v1/sirens/5').send({ kind: 'BASE' })).status).toBe(403);
  });

  it('seeds one base siren from SIREN_NODE_ID only while none is enrolled', async () => {
    const { sirenRepo } = await buildHarness();

    sirenRepo.seedBase(5);
    sirenRepo.seedBase(6);

    expect(sirenRepo.list()).toMatchObject([{ nodeId: 5, kind: 'BASE', name: 'Base siren', durationSec: 600 }]);
    sirenRepo.seedBase(null);
    expect(sirenRepo.list()).toHaveLength(1);
  });
});
