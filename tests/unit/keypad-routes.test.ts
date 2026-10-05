import request from 'supertest';
import type { Express } from 'express';
import type { Driver } from 'zwave-js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDatabase } from '../../src/db/schema.js';
import { AlarmPanelRepository } from '../../src/alarm/panel-repository.js';
import { PanelService } from '../../src/alarm/panel-service.js';
import { EventRepository } from '../../src/events/event-repository.js';
import { ZoneRepository } from '../../src/db/repositories/zone-repository.js';
import { SensorRepository } from '../../src/db/repositories/sensor-repository.js';
import { UserRepository } from '../../src/auth/user-repository.js';
import { LockoutPolicyRepository } from '../../src/auth/lockout-policy-repository.js';
import { LockoutService } from '../../src/auth/lockout-service.js';
import { KeypadService } from '../../src/keypads/keypad-service.js';
import { ringKeypadV2Adapter } from '../../src/keypads/adapters/ring-keypad-v2.adapter.js';
import { acmePadAdapter } from './fixtures/keypad-adapters/acme-pad.adapter.js';

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
  const eventRepo = new EventRepository(db);
  const userRepo = new UserRepository(db);
  const panelService = new PanelService(new AlarmPanelRepository(db), eventRepo);
  const lockoutService = new LockoutService(userRepo, new LockoutPolicyRepository(db), eventRepo, panelService);
  const writer = vi.fn().mockResolvedValue(undefined);
  const keypadService = new KeypadService(writer);
  keypadService.add(12, ringKeypadV2Adapter, { batteryLevel: 87 });
  keypadService.add(13, acmePadAdapter);

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
    keypadService,
    driver: { controller: { nodes: new Map() } } as unknown as Driver,
  });
  return { app, userRepo, writer };
}

async function loginAs(app: Express, userRepo: UserRepository, role: 'administrator' | 'member' | 'guest', code: string) {
  userRepo.create({ name: role, role, code, guestExpiresAt: role === 'guest' ? Date.now() + 100_000 : undefined });
  const agent = request.agent(app);
  await agent.post('/api/v1/auth/login').send({ code }).expect(200);
  return agent;
}

describe('keypad routes', () => {
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

  describe('GET /api/v1/keypads', () => {
    it('lists keypads with their capabilities, chime sounds, connectivity and battery', async () => {
      const { app, userRepo } = await buildHarness();
      const agent = await loginAs(app, userRepo, 'member', '1234');

      const res = await agent.get('/api/v1/keypads').expect(200);

      expect(res.body.keypads).toHaveLength(2);
      expect(res.body.keypads[0]).toEqual({
        nodeId: 12,
        adapterId: 'ring-keypad-v2',
        label: 'Ring Keypad v2',
        capabilities: ['arm_disarm', 'emergency', 'indicators', 'chime'],
        chimeSounds: ['double_beep', 'guitar', 'wind_chimes', 'bing_bong', 'doorbell'],
        connectivityStatus: 'online',
        batteryLevel: 87,
      });
      expect(res.body.keypads[1]).toMatchObject({ nodeId: 13, adapterId: 'acme-pad', chimeSounds: [] });
    });

    it('requires authentication and refuses guests', async () => {
      const { app, userRepo } = await buildHarness();
      await request(app).get('/api/v1/keypads').expect(401);

      const guest = await loginAs(app, userRepo, 'guest', '9999');
      await guest.get('/api/v1/keypads').expect(403);
    });
  });

  describe('POST /api/v1/keypads/:nodeId/chime', () => {
    it('plays the chime and returns 204', async () => {
      const { app, userRepo, writer } = await buildHarness();
      const agent = await loginAs(app, userRepo, 'administrator', '1234');

      await agent.post('/api/v1/keypads/12/chime').send({ sound: 'doorbell', volume: 70 }).expect(204);

      expect(writer).toHaveBeenCalledTimes(1);
      expect(writer.mock.calls[0]![0]).toBe(12);
    });

    it('returns 404 for a node that is not a keypad', async () => {
      const { app, userRepo } = await buildHarness();
      const agent = await loginAs(app, userRepo, 'administrator', '1234');

      const res = await agent.post('/api/v1/keypads/99/chime').send({ sound: 'doorbell' }).expect(404);
      expect(res.body.error.code).toBe('not_found');
    });

    it('returns 400 for a sound the keypad does not have, or a keypad without chime', async () => {
      const { app, userRepo } = await buildHarness();
      const agent = await loginAs(app, userRepo, 'administrator', '1234');

      await agent.post('/api/v1/keypads/12/chime').send({ sound: 'kazoo' }).expect(400);
      await agent.post('/api/v1/keypads/13/chime').send({ sound: 'doorbell' }).expect(400);
    });

    it('returns 400 for a malformed body', async () => {
      const { app, userRepo } = await buildHarness();
      const agent = await loginAs(app, userRepo, 'administrator', '1234');

      await agent.post('/api/v1/keypads/12/chime').send({}).expect(400);
      await agent.post('/api/v1/keypads/12/chime').send({ sound: 'doorbell', volume: 100 }).expect(400);
    });

    it('requires authentication and refuses guests', async () => {
      const { app, userRepo } = await buildHarness();
      await request(app).post('/api/v1/keypads/12/chime').send({ sound: 'doorbell' }).expect(401);

      const guest = await loginAs(app, userRepo, 'guest', '9999');
      await guest.post('/api/v1/keypads/12/chime').send({ sound: 'doorbell' }).expect(403);
    });
  });

  it('does not mount keypad routes when no keypad service is supplied', async () => {
    const { createApp } = await import('../../src/api/app.js');
    const app = createApp();
    await request(app).get('/api/v1/keypads').expect(404);
  });
});
