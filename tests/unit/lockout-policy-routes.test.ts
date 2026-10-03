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

async function buildHarness() {
  const db = createDatabase(':memory:');
  const panelRepo = new AlarmPanelRepository(db);
  const eventRepo = new EventRepository(db);
  const userRepo = new UserRepository(db);
  const panelService = new PanelService(panelRepo, eventRepo);
  const lockoutService = new LockoutService(userRepo, new LockoutPolicyRepository(db), eventRepo, panelService);

  const { createApp } = await import('../../src/api/app.js');
  const { HaLinkRepository } = await import('../../src/db/repositories/ha-link-repository.js');
  const app: Express = createApp({
    panelService,
    userRepo,
    zoneRepo: new ZoneRepository(db),
    sensorRepo: new SensorRepository(db),
    lockoutService,
    eventRepo,
    haLinkRepo: new HaLinkRepository(db),
    driver: { controller: { nodes: new Map() } } as unknown as Driver,
  });
  return { app, userRepo, panelRepo, eventRepo };
}

async function loginAs(app: Express, code: string) {
  const agent = request.agent(app);
  await agent.post('/api/v1/auth/login').send({ code }).expect(200);
  return agent;
}

describe('lockout policy routes (FR-016)', () => {
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

  async function adminHarness() {
    const harness = await buildHarness();
    harness.userRepo.create({ name: 'Owner', role: 'administrator', code: 'admin1' });
    return { ...harness, admin: await loginAs(harness.app, 'admin1') };
  }

  it('returns the default policy', async () => {
    const { admin } = await adminHarness();

    const res = await admin.get('/api/v1/lockout-policy');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ failedAttemptThreshold: 5, cooldownSeconds: 300, onThresholdExceeded: 'lockout' });
  });

  it('updates only the supplied fields and persists them', async () => {
    const { admin } = await adminHarness();

    const patched = await admin.patch('/api/v1/lockout-policy').send({ onThresholdExceeded: 'trigger_alarm' });
    expect(patched.status).toBe(200);
    expect(patched.body).toEqual({ failedAttemptThreshold: 5, cooldownSeconds: 300, onThresholdExceeded: 'trigger_alarm' });

    await admin.patch('/api/v1/lockout-policy').send({ failedAttemptThreshold: 3, cooldownSeconds: 60 }).expect(200);
    const read = await admin.get('/api/v1/lockout-policy');
    expect(read.body).toEqual({ failedAttemptThreshold: 3, cooldownSeconds: 60, onThresholdExceeded: 'trigger_alarm' });
  });

  describe('access control', () => {
    it('requires authentication', async () => {
      const { app } = await buildHarness();

      expect((await request(app).get('/api/v1/lockout-policy')).status).toBe(401);
      expect((await request(app).patch('/api/v1/lockout-policy').send({ cooldownSeconds: 5 })).status).toBe(401);
    });

    it.each(['member', 'guest'] as const)('forbids a %s', async (role) => {
      const { app, userRepo } = await buildHarness();
      userRepo.create({ name: 'X', role, code: 'code1', guestExpiresAt: role === 'guest' ? Date.now() + 60_000 : undefined });
      const agent = await loginAs(app, 'code1');

      expect((await agent.get('/api/v1/lockout-policy')).status).toBe(403);
      expect((await agent.patch('/api/v1/lockout-policy').send({ cooldownSeconds: 5 })).status).toBe(403);
    });
  });

  describe('validation', () => {
    it.each([
      ['empty body', {}],
      ['only unknown fields', { nope: 1 }],
      ['threshold 0', { failedAttemptThreshold: 0 }],
      ['threshold above 100', { failedAttemptThreshold: 101 }],
      ['fractional threshold', { failedAttemptThreshold: 2.5 }],
      ['cooldown 0', { cooldownSeconds: 0 }],
      ['cooldown above a day', { cooldownSeconds: 86_401 }],
      ['string threshold', { failedAttemptThreshold: '3' }],
      ['unknown mode', { onThresholdExceeded: 'panic' }],
    ])('rejects %s with 400 and changes nothing', async (_label, body) => {
      const { admin } = await adminHarness();

      const res = await admin.patch('/api/v1/lockout-policy').send(body);

      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: { code: 'bad_request', message: expect.any(String) } });
      expect((await admin.get('/api/v1/lockout-policy')).body).toEqual({
        failedAttemptThreshold: 5,
        cooldownSeconds: 300,
        onThresholdExceeded: 'lockout',
      });
    });
  });

  describe('effect on failed disarm attempts', () => {
    it('trigger_alarm mode raises the alarm at the threshold instead of locking', async () => {
      const { admin, panelRepo } = await adminHarness();
      await admin.patch('/api/v1/lockout-policy').send({ failedAttemptThreshold: 2, onThresholdExceeded: 'trigger_alarm' });

      await admin.post('/api/v1/panel/disarm').send({ code: 'wrong' }).expect(401);
      const res = await admin.post('/api/v1/panel/disarm').send({ code: 'wrong' });

      expect(res.status).toBe(200);
      expect(res.body.mode).toBe('alarm_triggered');
      expect(panelRepo.getPanel().mode).toBe('alarm_triggered');
    });

    it('lockout mode locks at a lowered threshold and records a lockout event', async () => {
      const { admin, eventRepo } = await adminHarness();
      await admin.patch('/api/v1/lockout-policy').send({ failedAttemptThreshold: 2 }).expect(200);

      await admin.post('/api/v1/panel/disarm').send({ code: 'wrong' }).expect(401);
      const res = await admin.post('/api/v1/panel/disarm').send({ code: 'wrong' });

      expect(res.status).toBe(423);
      expect(eventRepo.list().some((event) => event.type === 'lockout')).toBe(true);
    });
  });
});
