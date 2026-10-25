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
    lockoutService,
    eventRepo,
    haLinkRepo: new HaLinkRepository(db),
    driver: {} as unknown as Driver,
  });
  return { app, userRepo, panelService, sensorRepo, zoneRepo, alarmEvents };
}

async function loginAs(app: Express, userRepo: UserRepository, role: 'administrator' | 'member', code: string) {
  userRepo.create({ name: role, role, code });
  const agent = request.agent(app);
  await agent.post('/api/v1/auth/login').send({ code }).expect(200);
  return agent;
}

describe('panic, silence and alarm-events routes', () => {
  const originalEnv = { ...process.env };

  beforeEach(setEnv);
  afterEach(() => {
    process.env = { ...originalEnv };
  });

  async function admin() {
    const harness = await buildHarness();
    return { ...harness, agent: await loginAs(harness.app, harness.userRepo, 'administrator', 'admin1') };
  }

  it('POST /panel/panic opens an event and answers 201 with it; the panel goes into alarm', async () => {
    const { agent, panelService } = await admin();

    const res = await agent.post('/api/v1/panel/panic').send({ type: 'FIRE' });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      type: 'FIRE_MEDICAL',
      service: 'fire',
      sirenState: 'sounding',
      dispatchState: 'queued',
      endedAt: null,
    });
    expect(panelService.getState().mode).toBe('alarm_triggered');
  });

  it('a medical panic is silent and leaves the panel alone', async () => {
    const { agent, panelService } = await admin();

    const res = await agent.post('/api/v1/panel/panic').send({ type: 'MEDICAL' });

    expect(res.body).toMatchObject({ type: 'FIRE_MEDICAL', service: 'medical', sirenState: 'none' });
    expect(panelService.getState().mode).toBe('disarmed');
  });

  it('rejects an unknown panic type', async () => {
    const { agent } = await admin();

    expect((await agent.post('/api/v1/panel/panic').send({ type: 'BOO' })).status).toBe(400);
  });

  it('POST /panel/silence mutes the siren, then answers 409 when nothing is sounding', async () => {
    const { agent } = await admin();
    expect((await agent.post('/api/v1/panel/silence')).status).toBe(409);
    await agent.post('/api/v1/panel/panic').send({ type: 'PANIC' });

    const res = await agent.post('/api/v1/panel/silence');

    expect(res.status).toBe(200);
    expect(res.body.silenced).toMatchObject([{ type: 'PANIC', sirenState: 'silenced' }]);
    expect((await agent.post('/api/v1/panel/silence')).status).toBe(409);
  });

  it('GET /alarm-events lists newest first, and ?active=true drops closed events', async () => {
    const { agent, panelService } = await admin();
    await agent.post('/api/v1/panel/panic').send({ type: 'PANIC' });
    await panelService.disarm({ source: 'native' });
    await agent.post('/api/v1/panel/panic').send({ type: 'SOS', service: 'medical' });

    const all = await agent.get('/api/v1/alarm-events');
    const active = await agent.get('/api/v1/alarm-events?active=true&limit=5');

    expect(all.body.map((event: { type: string }) => event.type)).toEqual(['SOS', 'PANIC']);
    expect(all.body[0]).toMatchObject({ service: 'medical' });
    expect(active.body).toHaveLength(1);
    expect(active.body[0].type).toBe('SOS');
    expect((await agent.get('/api/v1/alarm-events?limit=0')).status).toBe(400);
  });
});
