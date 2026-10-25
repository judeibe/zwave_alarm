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
import { UserRepository } from '../../src/auth/user-repository.js';
import { LockService } from '../../src/locks/lock-service.js';
import { LockModeSettingsRepository } from '../../src/locks/lock-mode-settings.js';
import { LockCodeSlotRepository } from '../../src/locks/lock-code-slots.js';
import { LockCodeSync } from '../../src/locks/lock-code-sync.js';
import { GuestScheduleRepository } from '../../src/auth/guest-schedule.js';
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
  const settings = new LockModeSettingsRepository(db);
  const slots = new LockCodeSlotRepository(db);
  const portMock = {
    readParameter: vi.fn().mockResolvedValue(undefined),
    writeParameter: vi.fn().mockResolvedValue(undefined),
    setUserCode: vi.fn().mockResolvedValue(undefined),
    clearUserCode: vi.fn().mockResolvedValue(undefined),
    getUserSlot: vi.fn((_n: number, userId: number) => Promise.resolve({ userId, status: 'available' as const })),
    getScheduleSlotCounts: vi.fn().mockResolvedValue(undefined),
    setScheduleEnabled: vi.fn().mockResolvedValue(undefined),
    setSchedule: vi.fn().mockResolvedValue(undefined),
    getSchedule: vi.fn().mockResolvedValue(undefined),
    setLocked: vi.fn().mockResolvedValue(undefined),
    getLocked: vi.fn().mockResolvedValue(undefined),
  };
  const enrolled = new Set([5]);
  const lockService = new LockService(portMock, { isEnrolled: (n) => enrolled.has(n), enroll: (n) => void enrolled.add(n), unenroll: (n) => void enrolled.delete(n) }, settings);
  lockService.add(5, { model: 'BE469', label: 'Front door' });
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
    guestSchedules: new GuestScheduleRepository(db),
    lockService,
    lockModeSettings: settings,
    lockCodeSync: new LockCodeSync(lockService, slots),
    lockCodeSlots: slots,
    lockoutService,
    eventRepo,
    haLinkRepo: new HaLinkRepository(db),
    driver: { controller: { nodes: { get: (id: number) => (id === 5 || id === 6 ? {} : undefined) } } } as unknown as Driver,
  });
  return { app, userRepo, panelService, sensorRepo, zoneRepo, alarmEvents, sirenRepo, db, portMock, slots, lockService };
}

async function loginAs(app: Express, userRepo: UserRepository, role: 'administrator' | 'member' | 'installer', code: string) {
  userRepo.create({ name: role, role, code });
  const agent = request.agent(app);
  await agent.post('/api/v1/auth/login').send({ code }).expect(200);
  return agent;
}

describe('lock mode-settings routes', () => {
  const originalEnv = { ...process.env };

  beforeEach(setEnv);
  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('returns defaults, merges partial changes, and shows them on the lock summary', async () => {
    const { app, userRepo } = await buildHarness();
    const agent = await loginAs(app, userRepo, 'administrator', '4141');

    const defaults = await agent.get('/api/v1/locks/5/mode-settings');
    expect(defaults.body).toEqual({
      armOnLockWithCode: false,
      armOnOneTouch: false,
      disarmOnUnlock: false,
      actions: { disarmed: null, armed_home: null, armed_away: null },
    });

    const put = await agent.put('/api/v1/locks/5/mode-settings').send({ armOnLockWithCode: true, actions: { armed_away: 'lock' } });
    expect(put.status).toBe(200);
    const merged = await agent.put('/api/v1/locks/5/mode-settings').send({ actions: { disarmed: 'unlock' } });
    expect(merged.body).toMatchObject({ armOnLockWithCode: true, actions: { disarmed: 'unlock', armed_home: null, armed_away: 'lock' } });
    const cleared = await agent.put('/api/v1/locks/5/mode-settings').send({ actions: { armed_away: null } });
    expect(cleared.body.actions.armed_away).toBeNull();

    const summary = (await agent.get('/api/v1/locks')).body.locks[0];
    expect(summary.modeSettings).toMatchObject({ armOnLockWithCode: true, actions: { disarmed: 'unlock' } });
  });

  it('rejects bad bodies, unknown locks, and a member changing them', async () => {
    const { app, userRepo } = await buildHarness();
    const agent = await loginAs(app, userRepo, 'administrator', '4141');

    expect((await agent.put('/api/v1/locks/5/mode-settings').send({})).status).toBe(400);
    expect((await agent.put('/api/v1/locks/5/mode-settings').send({ actions: { armed_away: 'open' } })).status).toBe(400);
    expect((await agent.put('/api/v1/locks/5/mode-settings').send({ armOnLockWithCode: 'yes' })).status).toBe(400);
    expect((await agent.put('/api/v1/locks/99/mode-settings').send({ disarmOnUnlock: true })).status).toBe(404);
    expect((await agent.get('/api/v1/locks/99/mode-settings')).status).toBe(404);

    const member = await loginAs(app, userRepo, 'member', '5151');
    expect((await member.get('/api/v1/locks/5/mode-settings')).status).toBe(200);
    expect((await member.put('/api/v1/locks/5/mode-settings').send({ disarmOnUnlock: true })).status).toBe(403);
  });
});

describe('codes pushed to locks through the user routes', () => {
  const originalEnv = { ...process.env };

  beforeEach(setEnv);
  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('POST /users pushes the code and reports lockSync; GET /users shows the slot, never the code', async () => {
    const { app, userRepo, portMock } = await buildHarness();
    const agent = await loginAs(app, userRepo, 'administrator', '4141');

    const created = await agent.post('/api/v1/users').send({ name: 'Sitter', role: 'member', code: '2468' });

    expect(created.status).toBe(201);
    expect(created.body.lockSync).toEqual([{ nodeId: 5, slot: 1, status: 'synced' }]);
    expect(portMock.setUserCode).toHaveBeenCalledWith(5, 1, 'enabled', '2468');
    const listed = (await agent.get('/api/v1/users')).body.find((u: { name: string }) => u.name === 'Sitter');
    expect(listed.lockSlots).toEqual([{ nodeId: 5, slot: 1, status: 'synced' }]);
    expect(JSON.stringify(listed)).not.toContain('2468');
  });

  it('PUT /code answers 200 with lockSync and reuses the slot; DELETE /code clears it', async () => {
    const { app, userRepo, portMock } = await buildHarness();
    const agent = await loginAs(app, userRepo, 'administrator', '4141');
    const user = (await agent.post('/api/v1/users').send({ name: 'Sitter', role: 'member', code: '2468' })).body;

    const changed = await agent.put(`/api/v1/users/${user.id}/code`).send({ code: '1357' });
    expect(changed.status).toBe(200);
    expect(changed.body).toEqual({ lockSync: [{ nodeId: 5, slot: 1, status: 'synced' }] });
    expect(portMock.setUserCode).toHaveBeenLastCalledWith(5, 1, 'enabled', '1357');

    const removed = await agent.delete(`/api/v1/users/${user.id}/code`);
    expect(removed.status).toBe(200);
    expect(removed.body.lockSync).toEqual([{ nodeId: 5, slot: 1, status: 'synced' }]);
    expect(portMock.clearUserCode).toHaveBeenCalledWith(5, 1);
  });

  it('a lock that refuses the code is a failed entry, not a failed request, and the user still has the code', async () => {
    const { app, userRepo, portMock } = await buildHarness();
    const agent = await loginAs(app, userRepo, 'administrator', '4141');
    portMock.setUserCode.mockRejectedValueOnce(new Error('The lock is set to 6-digit codes'));

    const created = await agent.post('/api/v1/users').send({ name: 'Sitter', role: 'member', code: '2468' });

    expect(created.status).toBe(201);
    expect(created.body.lockSync[0]).toMatchObject({ nodeId: 5, status: 'failed' });
    expect(created.body.hasCode).toBe(true);
  });

  it('deleting a user clears their slot first, and a duress code is never pushed', async () => {
    const { app, userRepo, portMock, slots } = await buildHarness();
    const agent = await loginAs(app, userRepo, 'administrator', '4141');
    const owner = userRepo.list().find((u) => u.role === 'administrator')!;
    portMock.setUserCode.mockClear();
    await agent.put(`/api/v1/users/${owner.id}/duress-code`).send({ code: '9090' });
    expect(portMock.setUserCode).not.toHaveBeenCalled();

    const user = (await agent.post('/api/v1/users').send({ name: 'Sitter', role: 'member', code: '2468' })).body;
    expect((await agent.delete(`/api/v1/users/${user.id}`)).status).toBe(204);

    expect(portMock.clearUserCode).toHaveBeenCalledWith(5, 1);
    expect(slots.forUser(user.id)).toEqual([]);
  });

  it('a user with no code and no locks still gets lockSync: []', async () => {
    const { app, userRepo } = await buildHarness();
    const agent = await loginAs(app, userRepo, 'administrator', '4141');

    const created = await agent.post('/api/v1/users').send({ name: 'No code', role: 'member' });

    expect(created.body.lockSync).toEqual([]);
  });
});
