import { EventEmitter } from 'node:events';
import request from 'supertest';
import type { Express } from 'express';
import type { Driver } from 'zwave-js';
import type { WebSocketServer } from 'ws';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
import { KeypadService } from '../../src/keypads/keypad-service.js';
import { KeypadSettingsRepository, KeypadSettingsService } from '../../src/keypads/keypad-settings.js';
import { startInstallerExpirySweep } from '../../src/auth/installer-expiry.js';

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
  const zoneRepo = new ZoneRepository(db);
  const sensorRepo = new SensorRepository(db);
  const panelService = new PanelService(new AlarmPanelRepository(db), eventRepo, { modeConfig, sensorRepo });
  const lockoutService = new LockoutService(userRepo, new LockoutPolicyRepository(db), eventRepo, panelService);
  const keypadSettings = new KeypadSettingsService(new KeypadSettingsRepository(db), { requireCodeToArm: false });
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
    keypadService: new KeypadService(() => Promise.resolve()),
    keypadSettings,
    driver: { controller: { nodes: { get: () => ({}) } } } as unknown as Driver,
  });
  return { app, userRepo, zoneRepo, sensorRepo };
}

async function loginAs(app: Express, userRepo: UserRepository, role: 'administrator' | 'member', code: string) {
  userRepo.create({ name: role, role, code });
  const agent = request.agent(app);
  await agent.post('/api/v1/auth/login').send({ code }).expect(200);
  return agent;
}

describe('chirps over the API', () => {
  const originalEnv = { ...process.env };
  beforeEach(setEnv);
  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('PATCH /modes sets chirpsEnabled per mode, including DISARMED, and GET /modes shows it', async () => {
    const { app, userRepo } = await buildHarness();
    const agent = await loginAs(app, userRepo, 'administrator', '4141');

    const res = await agent.patch('/api/v1/modes').send({ disarmed: { chirpsEnabled: true }, armed_away: { chirpsEnabled: true, exitDelaySec: 30 } });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      armed_home: { entryDelaySec: 60, exitDelaySec: 60, chirpsEnabled: false },
      armed_away: { entryDelaySec: 60, exitDelaySec: 30, chirpsEnabled: true },
      disarmed: { chirpsEnabled: true },
    });
    expect((await agent.get('/api/v1/modes')).body.disarmed).toEqual({ chirpsEnabled: true });
    expect((await agent.patch('/api/v1/modes').send({ disarmed: {} })).status).toBe(400);
    expect((await agent.patch('/api/v1/modes').send({ disarmed: { chirpsEnabled: 'yes' } })).status).toBe(400);
  });

  it('PATCH /sensors sets a chirp tone, defaulting to double_beep, none mutes, life-safety has none', async () => {
    const { app, userRepo, zoneRepo, sensorRepo } = await buildHarness();
    const agent = await loginAs(app, userRepo, 'administrator', '4141');
    const zone = zoneRepo.create('House');
    const door = sensorRepo.create({ zwaveNodeId: 5, zoneId: zone.id, name: 'Door', category: 'intrusion' });
    const smoke = sensorRepo.create({ zwaveNodeId: 6, zoneId: zone.id, name: 'Smoke', category: 'life-safety' });
    expect(door.chirpTone).toBe('double_beep');
    expect(smoke.chirpTone).toBeNull();

    expect((await agent.patch(`/api/v1/sensors/${door.id}`).send({ chirpTone: 'guitar' })).body.chirpTone).toBe('guitar');
    expect((await agent.patch(`/api/v1/sensors/${door.id}`).send({ chirpTone: 'none' })).body.chirpTone).toBe('none');
    expect((await agent.patch(`/api/v1/sensors/${door.id}`).send({ chirpTone: 'siren' })).status).toBe(400);
    expect((await agent.patch(`/api/v1/sensors/${smoke.id}`).send({ chirpTone: 'guitar' })).status).toBe(400);
    const toSafety = await agent.patch(`/api/v1/sensors/${door.id}`).send({ category: 'life-safety' });
    expect(toSafety.body.chirpTone).toBeNull();
    const back = await agent.patch(`/api/v1/sensors/${door.id}`).send({ category: 'intrusion' });
    expect(back.body.chirpTone).toBe('double_beep');
  });

  it('PATCH /keypad-settings sets the keypad volume 0-99', async () => {
    const { app, userRepo } = await buildHarness();
    const agent = await loginAs(app, userRepo, 'administrator', '4141');

    expect((await agent.get('/api/v1/keypad-settings')).body).toEqual({ requireCodeToArm: false, volume: 60 });
    expect((await agent.patch('/api/v1/keypad-settings').send({ volume: 0 })).body.volume).toBe(0);
    expect((await agent.patch('/api/v1/keypad-settings').send({ volume: 99 })).body.volume).toBe(99);
    expect((await agent.get('/api/v1/keypad-settings')).body).toEqual({ requireCodeToArm: false, volume: 99 });
    for (const volume of [-1, 100, 1.5, '50']) {
      expect((await agent.patch('/api/v1/keypad-settings').send({ volume })).status).toBe(400);
    }
  });
});

describe('lock.event on the stream', () => {
  it('is relayed to every open client with the event\'s fields', async () => {
    const { attachWsBroadcaster } = await import('../../src/api/ws-broadcaster.js');
    const sent: string[] = [];
    const wss = { clients: new Set([{ readyState: 1, send: (message: string) => sent.push(message) }]) } as unknown as WebSocketServer;
    const lockAutomation = new EventEmitter();
    attachWsBroadcaster(wss, {
      panelService: new EventEmitter(),
      sensorMapper: new EventEmitter(),
      eventRepo: new EventEmitter(),
      lockAutomation,
    } as never);

    lockAutomation.emit('lock_event', { nodeId: 44, kind: 'armed', userId: 'u1', method: 'keypad' });

    expect(sent.map((message) => JSON.parse(message) as unknown)).toEqual([
      { type: 'lock.event', nodeId: 44, kind: 'armed', userId: 'u1', method: 'keypad' },
    ]);
  });
});

describe('installer expiry logging', () => {
  it('names the lock slots that could not be cleared, so they can be cleared by hand', async () => {
    const db = createDatabase(':memory:');
    const userRepo = new UserRepository(db);
    const tech = userRepo.create({ name: 'Tech', role: 'installer', code: '1212' });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    const stop = startInstallerExpirySweep(userRepo, {
      now: () => Date.now() + 49 * 3600 * 1000,
      intervalMs: 1_000_000,
      beforeRemove: () =>
        Promise.resolve([
          { nodeId: 5, slot: 3, status: 'failed' },
          { nodeId: 6, slot: 2, status: 'synced' },
        ]),
    });
    await vi.waitFor(() => expect(userRepo.findById(tech.id)).toBeUndefined());
    stop();

    const warning = log.mock.calls
      .map((call) => JSON.parse(call[0] as string) as Record<string, unknown>)
      .find((entry) => entry.level === 'warn');
    log.mockRestore();
    expect(warning).toMatchObject({ message: 'expired installer code could not be cleared from a lock', name: 'Tech', locks: [{ nodeId: 5, slot: 3 }] });
  });
});
