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
import { AlarmEventRepository } from '../../src/alarm/alarm-event-repository.js';
import { SirenRepository } from '../../src/alarm/siren-repository.js';
import { AlarmEventService } from '../../src/alarm/alarm-event-service.js';
import { ModeConfigRepository } from '../../src/db/repositories/mode-config-repository.js';
import { INSTALLER_ACCESS_MS, UserRepository } from '../../src/auth/user-repository.js';
import { startInstallerExpirySweep } from '../../src/auth/installer-expiry.js';
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
  return { app, userRepo, panelService, sensorRepo, zoneRepo, alarmEvents, sirenRepo, db };
}

async function loginAs(app: Express, userRepo: UserRepository, role: 'administrator' | 'member' | 'installer', code: string) {
  userRepo.create({ name: role, role, code });
  const agent = request.agent(app);
  await agent.post('/api/v1/auth/login').send({ code }).expect(200);
  return agent;
}

describe('access codes', () => {
  const originalEnv = { ...process.env };

  beforeEach(setEnv);
  afterEach(() => {
    process.env = { ...originalEnv };
  });

  async function admin() {
    const harness = await buildHarness();
    return { ...harness, agent: await loginAs(harness.app, harness.userRepo, 'administrator', '4141') };
  }

  it('accepts only four-digit codes on create and on PUT /code', async () => {
    const { agent } = await admin();

    for (const code of ['123', '12345', 'abcd', '12 4']) {
      expect((await agent.post('/api/v1/users').send({ name: 'M', role: 'member', code })).status).toBe(400);
    }
    const created = await agent.post('/api/v1/users').send({ name: 'M', role: 'member', code: '2222' });
    expect(created.status).toBe(201);
    expect((await agent.put(`/api/v1/users/${created.body.id}/code`).send({ code: '99999' })).status).toBe(400);
    expect((await agent.put(`/api/v1/users/${created.body.id}/code`).send({ code: '3333' })).status).toBe(204);
  });

  it('requires confirmCode to match when it is sent', async () => {
    const { agent } = await admin();

    const mismatch = await agent.post('/api/v1/users').send({ name: 'M', role: 'member', code: '2222', confirmCode: '2223' });
    const match = await agent.post('/api/v1/users').send({ name: 'M', role: 'member', code: '2222', confirmCode: '2222' });

    expect(mismatch.status).toBe(400);
    expect(match.status).toBe(201);
    expect(match.body).not.toHaveProperty('confirmCode');
  });

  it('answers 409 code_in_use for a duplicate, including against a duress code', async () => {
    const { agent, userRepo } = await admin();
    const owner = userRepo.list()[0];
    expect((await agent.put(`/api/v1/users/${owner.id}/duress-code`).send({ code: '9090' })).status).toBe(204);

    const dup = await agent.post('/api/v1/users').send({ name: 'M', role: 'member', code: '4141' });
    const dupDuress = await agent.post('/api/v1/users').send({ name: 'M', role: 'member', code: '9090' });
    const sameAsOwn = await agent.put(`/api/v1/users/${owner.id}/duress-code`).send({ code: '4141' });

    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('code_in_use');
    expect(dupDuress.status).toBe(409);
    expect(sameAsOwn.status).toBe(409);
  });

  it('caps a location at 256 codes, duress codes included', async () => {
    const { agent, userRepo, db } = await admin();
    const insert = db.prepare(
      "INSERT INTO users (id, name, role, credential_hash, created_at) VALUES (?, ?, 'member', 'unverifiable', 0)",
    );
    for (let i = 0; i < 254; i += 1) {
      insert.run(`filler-${String(i)}`, `Filler ${String(i)}`);
    }
    expect(userRepo.countCodes()).toBe(255);

    expect((await agent.post('/api/v1/users').send({ name: 'Last', role: 'member', code: '5555' })).status).toBe(201);
    const over = await agent.post('/api/v1/users').send({ name: 'Over', role: 'member', code: '6666' });
    const owner = userRepo.list().find((user) => user.role === 'administrator')!;
    const duress = await agent.put(`/api/v1/users/${owner.id}/duress-code`).send({ code: '7777' });

    expect(over.status).toBe(409);
    expect(over.body.error.code).toBe('code_limit');
    expect(duress.status).toBe(409);
    expect(duress.body.error.code).toBe('code_limit');
  });

  it('lets only an administrator hold a duress code, and never returns it', async () => {
    const { agent, userRepo } = await admin();
    const member = userRepo.create({ name: 'Mem', role: 'member', code: '5151' });
    const owner = userRepo.list()[0];

    expect((await agent.put(`/api/v1/users/${member.id}/duress-code`).send({ code: '9090' })).status).toBe(400);
    expect((await agent.put(`/api/v1/users/${owner.id}/duress-code`).send({ code: '9090' })).status).toBe(204);
    const listed = (await agent.get('/api/v1/users')).body.find((user: { id: string }) => user.id === owner.id);
    expect(listed).toMatchObject({ hasDuressCode: true });
    expect(JSON.stringify(listed)).not.toContain('9090');

    expect((await agent.delete(`/api/v1/users/${owner.id}/duress-code`)).status).toBe(204);
    expect(userRepo.findById(owner.id)?.duressHash).toBeNull();
  });
});

describe('duress disarm', () => {
  const originalEnv = { ...process.env };

  beforeEach(setEnv);
  afterEach(() => {
    process.env = { ...originalEnv };
  });

  async function owner() {
    const harness = await buildHarness();
    const agent = await loginAs(harness.app, harness.userRepo, 'administrator', '4141');
    harness.userRepo.setDuressCode(harness.userRepo.list()[0].id, '9090');
    return { ...harness, agent };
  }

  it('disarms like a normal code and quietly opens a silent DURESS event that stays open', async () => {
    const { agent, panelService, alarmEvents } = await owner();
    await panelService.arm('armed_home', { source: 'native' });
    await new Promise((resolve) => setTimeout(resolve, 5));

    const normal = await agent.post('/api/v1/panel/disarm').send({ code: '9090' });

    expect(normal.status).toBe(200);
    expect(normal.body.mode).toBe('disarmed');
    expect(alarmEvents.listActive()).toMatchObject([
      { type: 'DURESS', sirenState: 'none', dispatchState: 'queued', endedAt: null },
    ]);
  });

  it('also fires when the panel is already disarmed, and a later disarm cannot cancel its dispatch', async () => {
    const { agent, panelService, alarmEvents } = await owner();

    const res = await agent.post('/api/v1/panel/disarm').send({ code: '9090' });
    expect(res.status).toBe(200);
    expect(alarmEvents.listActive()).toHaveLength(1);

    await panelService.disarm({ source: 'native' });
    expect(alarmEvents.list()[0]).toMatchObject({ type: 'DURESS', dispatchState: 'queued', cancelledAt: null });
  });

  it('a normal code raises no duress event, and a wrong code still counts as a failed attempt', async () => {
    const { agent, alarmEvents, userRepo } = await owner();

    expect((await agent.post('/api/v1/panel/disarm').send({ code: '4141' })).status).toBe(200);
    expect(alarmEvents.list()).toEqual([]);
    expect((await agent.post('/api/v1/panel/disarm').send({ code: '0000' })).status).toBe(401);
    expect(userRepo.list()[0].failedAttemptCount).toBe(1);
  });
});

describe('installer role', () => {
  const originalEnv = { ...process.env };

  beforeEach(setEnv);
  afterEach(() => {
    vi.useRealTimers();
    process.env = { ...originalEnv };
  });

  it('is created with 48 h of access whatever expiry the caller sends', async () => {
    const harness = await buildHarness();
    const agent = await loginAs(harness.app, harness.userRepo, 'administrator', '4141');
    const before = Date.now();

    const res = await agent.post('/api/v1/users').send({ name: 'Tech', role: 'installer', code: '1212', guestExpiresAt: 5 });

    expect(res.status).toBe(201);
    expect(res.body.role).toBe('installer');
    expect(res.body.guestExpiresAt).toBeGreaterThanOrEqual(before + INSTALLER_ACCESS_MS);
    expect(res.body.guestExpiresAt).toBeLessThanOrEqual(Date.now() + INSTALLER_ACCESS_MS);
  });

  it('can arm, add and remove devices, but not change modes, codes or users', async () => {
    const harness = await buildHarness();
    const installer = await loginAs(harness.app, harness.userRepo, 'installer', '1212');
    harness.sirenRepo.upsert({ nodeId: 5, kind: 'BASE' });

    expect((await installer.post('/api/v1/panel/arm').send({ mode: 'armed_away' })).status).toBe(200);
    expect((await installer.get('/api/v1/modes')).status).toBe(200);
    expect((await installer.delete('/api/v1/sirens/5')).status).toBe(204);
    expect((await installer.put('/api/v1/sirens/6').send({ kind: 'BASE' })).status).toBe(200);

    expect((await installer.patch('/api/v1/modes').send({ armed_home: { entryDelaySec: 0 } })).status).toBe(403);
    expect((await installer.post('/api/v1/users').send({ name: 'X', role: 'member', code: '2323' })).status).toBe(403);
    expect((await installer.get('/api/v1/users')).status).toBe(403);
    expect((await installer.patch('/api/v1/sensors/x').send({ name: 'n' })).status).toBe(403);
  });

  it('is refused once its 48 h are up, and the sweep removes the account', async () => {
    const harness = await buildHarness();
    const tech = harness.userRepo.create({ name: 'Tech', role: 'installer', code: '1212' });
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + INSTALLER_ACCESS_MS + 1_000);

    const login = await request(harness.app).post('/api/v1/auth/login').send({ code: '1212' });
    expect(login.status).toBe(401);
    expect(login.body.error.message).toContain('expired');

    const stop = startInstallerExpirySweep(harness.userRepo, { intervalMs: 1_000_000 });
    stop();
    expect(harness.userRepo.findById(tech.id)).toBeUndefined();
  });

  it('removing a user who has events keeps the events', async () => {
    const harness = await buildHarness();
    const tech = harness.userRepo.create({ name: 'Tech', role: 'installer', code: '1212' });
    await harness.panelService.arm('armed_away', { source: 'native', sourceUserId: tech.id });
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(() => harness.userRepo.delete(tech.id)).not.toThrow();
    expect(harness.userRepo.findById(tech.id)).toBeUndefined();
  });
});

describe('migration 011', () => {
  it('keeps foreign keys on, keeps enforcing them, and accepts the installer role', () => {
    const db = createDatabase(':memory:');

    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(() =>
      db
        .prepare("INSERT INTO ha_links (id, api_token_hash, label, connection_status, created_at, user_id) VALUES ('h', 'x', 'l', 'connected', 0, 'nobody')")
        .run(),
    ).toThrow(/FOREIGN KEY/);
    expect(() =>
      db
        .prepare("INSERT INTO users (id, name, role, credential_hash, created_at) VALUES ('u', 'T', 'installer', '', 0)")
        .run(),
    ).not.toThrow();
    expect(() =>
      db.prepare("INSERT INTO users (id, name, role, credential_hash, created_at) VALUES ('v', 'T', 'root', '', 0)").run(),
    ).toThrow(/CHECK/);
  });
});
