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
  const panelService = new PanelService(new AlarmPanelRepository(db), eventRepo, { modeConfig });
  const lockoutService = new LockoutService(userRepo, new LockoutPolicyRepository(db), eventRepo, panelService);
  const { createApp } = await import('../../src/api/app.js');
  const { HaLinkRepository } = await import('../../src/db/repositories/ha-link-repository.js');
  const app = createApp({
    panelService,
    userRepo,
    zoneRepo: new ZoneRepository(db),
    sensorRepo: new SensorRepository(db),
    lockoutService,
    eventRepo,
    haLinkRepo: new HaLinkRepository(db),
    driver: {} as unknown as Driver,
  });
  return { app, userRepo, panelService };
}

async function loginAs(app: Express, userRepo: UserRepository, role: 'administrator' | 'member', code: string) {
  userRepo.create({ name: role, role, code });
  const agent = request.agent(app);
  await agent.post('/api/v1/auth/login').send({ code }).expect(200);
  return agent;
}

describe('mode routes', () => {
  const originalEnv = { ...process.env };

  beforeEach(setEnv);
  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('defaults both modes to 60 s entry and exit', async () => {
    const { app, userRepo } = await buildHarness();
    const agent = await loginAs(app, userRepo, 'member', 'member1');

    const res = await agent.get('/api/v1/modes');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      armed_home: { entryDelaySec: 60, exitDelaySec: 60, chirpsEnabled: false },
      armed_away: { entryDelaySec: 60, exitDelaySec: 60, chirpsEnabled: false },
      disarmed: { chirpsEnabled: false },
    });
  });

  it('lets an administrator change one field of one mode, and shows modes on GET /panel', async () => {
    const { app, userRepo } = await buildHarness();
    const agent = await loginAs(app, userRepo, 'administrator', 'admin1');

    const res = await agent.patch('/api/v1/modes').send({ armed_away: { exitDelaySec: 120 } });

    expect(res.status).toBe(200);
    expect(res.body.armed_away).toEqual({ entryDelaySec: 60, exitDelaySec: 120, chirpsEnabled: false });
    expect(res.body.armed_home).toEqual({ entryDelaySec: 60, exitDelaySec: 60, chirpsEnabled: false });
    expect((await agent.get('/api/v1/panel')).body.modes).toEqual(res.body);
  });

  it('rejects out-of-range, non-integer and empty changes', async () => {
    const { app, userRepo } = await buildHarness();
    const agent = await loginAs(app, userRepo, 'administrator', 'admin1');

    for (const body of [{ armed_home: { entryDelaySec: 181 } }, { armed_home: { exitDelaySec: -1 } }, { armed_home: { exitDelaySec: 1.5 } }, {}, { armed_home: {} }]) {
      expect((await agent.patch('/api/v1/modes').send(body)).status).toBe(400);
    }
  });

  it('forbids a member from changing the delays', async () => {
    const { app, userRepo } = await buildHarness();
    const agent = await loginAs(app, userRepo, 'member', 'member1');

    expect((await agent.patch('/api/v1/modes').send({ armed_home: { entryDelaySec: 0 } })).status).toBe(403);
  });

  it('seeds from the legacy env values once and never overwrites a stored value', () => {
    const db = createDatabase(':memory:');
    const repo = new ModeConfigRepository(db);
    repo.ensureSeeded({ exitDelaySec: 45 });
    repo.update({ armed_home: { entryDelaySec: 5 } });

    repo.ensureSeeded({ exitDelaySec: 90, entryDelaySec: 90 });

    expect(repo.getAll().armed_home).toEqual({ entryDelaySec: 5, exitDelaySec: 45, chirpsEnabled: false });
  });
});
