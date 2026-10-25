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
  const sensorRepo = new SensorRepository(db);
  const zoneRepo = new ZoneRepository(db);
  const panelService = new PanelService(new AlarmPanelRepository(db), eventRepo, { modeConfig, sensorRepo });
  const lockoutService = new LockoutService(userRepo, new LockoutPolicyRepository(db), eventRepo, panelService);
  const { createApp } = await import('../../src/api/app.js');
  const { HaLinkRepository } = await import('../../src/db/repositories/ha-link-repository.js');
  const app = createApp({
    panelService,
    userRepo,
    zoneRepo,
    sensorRepo,
    lockoutService,
    eventRepo,
    haLinkRepo: new HaLinkRepository(db),
    driver: {} as unknown as Driver,
  });
  return { app, userRepo, panelService, sensorRepo, zoneRepo };
}

async function loginAs(app: Express, userRepo: UserRepository, role: 'administrator' | 'member', code: string) {
  userRepo.create({ name: role, role, code });
  const agent = request.agent(app);
  await agent.post('/api/v1/auth/login').send({ code }).expect(200);
  return agent;
}

describe('POST /panel/arm pre-arm check', () => {
  const originalEnv = { ...process.env };

  beforeEach(setEnv);
  afterEach(() => {
    process.env = { ...originalEnv };
  });

  async function withOpenDoor() {
    const harness = await buildHarness();
    const agent = await loginAs(harness.app, harness.userRepo, 'administrator', 'admin1');
    const zone = harness.zoneRepo.create('House');
    const door = harness.sensorRepo.create({ zwaveNodeId: 5, zoneId: zone.id, name: 'Back door', category: 'intrusion', placement: 'WINDOW' });
    harness.sensorRepo.updateState(door.id, { currentState: 'breached' });
    return { ...harness, agent, door };
  }

  it('answers 409 needs_bypass with the faulted sensors and leaves the panel disarmed', async () => {
    const { agent, door, panelService } = await withOpenDoor();

    const res = await agent.post('/api/v1/panel/arm').send({ mode: 'armed_away' });

    expect(res.status).toBe(409);
    expect(res.body.error).toMatchObject({
      code: 'needs_bypass',
      faulted: [{ sensorId: door.id, name: 'Back door', zoneId: door.zoneId, reason: 'open' }],
    });
    expect(panelService.getState().mode).toBe('disarmed');
  });

  it('arms when the faulted sensor is listed in bypass, and reports it on the panel', async () => {
    const { agent, door } = await withOpenDoor();

    const res = await agent.post('/api/v1/panel/arm').send({ mode: 'armed_away', bypass: [door.id], source: 'app' });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ mode: 'arming', armedMode: 'armed_away', bypassedDeviceIds: [door.id] });
    expect(res.body.exitEndsAt).toBe(res.body.pendingDelayEndsAt);
  });

  it('auto-bypasses for source lock without a bypass list', async () => {
    const { agent, door } = await withOpenDoor();

    const res = await agent.post('/api/v1/panel/arm').send({ mode: 'armed_home', source: 'lock' });

    expect(res.status).toBe(200);
    expect(res.body.bypassedDeviceIds).toEqual([door.id]);
  });

  it('answers 400 for an unknown bypass id or an unknown source', async () => {
    const { agent } = await withOpenDoor();

    const unknown = await agent.post('/api/v1/panel/arm').send({ mode: 'armed_away', bypass: ['nope'] });
    const badSource = await agent.post('/api/v1/panel/arm').send({ mode: 'armed_away', source: 'carrier-pigeon' });

    expect(unknown.status).toBe(400);
    expect(unknown.body.error).toMatchObject({ code: 'bad_request', sensorIds: ['nope'] });
    expect(badSource.status).toBe(400);
  });
});
