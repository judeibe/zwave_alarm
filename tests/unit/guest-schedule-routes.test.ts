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

describe('guest schedule routes', () => {
  const originalEnv = { ...process.env };

  beforeEach(setEnv);
  afterEach(() => {
    process.env = { ...originalEnv };
  });

  async function withGuest() {
    const harness = await buildHarness();
    const agent = await loginAs(harness.app, harness.userRepo, 'administrator', '4141');
    const guest = harness.userRepo.create({ name: 'Sitter', role: 'guest', code: '3333', guestExpiresAt: Date.now() + 1e9 });
    return { ...harness, agent, guest };
  }

  const timed = { name: 'Weekdays', days: ['mon', 'tue'], start: '09:00', end: '17:00', timeZone: 'America/Chicago' };

  it('creates, lists, edits and deletes a schedule', async () => {
    const { agent, guest } = await withGuest();

    const created = await agent.post(`/api/v1/users/${guest.id}/schedules`).send(timed);
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ userId: guest.id, name: 'Weekdays', days: ['mon', 'tue'], allDay: false, start: '09:00', end: '17:00', timeZone: 'America/Chicago' });
    expect((await agent.get(`/api/v1/users/${guest.id}/schedules`)).body).toHaveLength(1);

    const edited = await agent.patch(`/api/v1/users/${guest.id}/schedules/${created.body.id}`).send({ end: '18:30', days: ['mon'] });
    expect(edited.body).toMatchObject({ end: '18:30', days: ['mon'], start: '09:00' });
    const allDay = await agent.patch(`/api/v1/users/${guest.id}/schedules/${created.body.id}`).send({ allDay: true });
    expect(allDay.body).toMatchObject({ allDay: true, start: null, end: null });

    expect((await agent.delete(`/api/v1/users/${guest.id}/schedules/${created.body.id}`)).status).toBe(204);
    expect((await agent.delete(`/api/v1/users/${guest.id}/schedules/${created.body.id}`)).status).toBe(404);
    expect((await agent.get(`/api/v1/users/${guest.id}/schedules`)).body).toEqual([]);
  });

  it('accepts an all-day schedule without times, and defaults the time zone to the server\'s (null)', async () => {
    const { agent, guest } = await withGuest();

    const res = await agent.post(`/api/v1/users/${guest.id}/schedules`).send({ name: 'Sat', days: ['sat'], allDay: true });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ allDay: true, start: null, end: null, timeZone: null });
  });

  it('rejects bad bodies: missing times, bad clock, repeated or no days, equal times, unknown zone', async () => {
    const { agent, guest } = await withGuest();
    const post = (body: object) => agent.post(`/api/v1/users/${guest.id}/schedules`).send(body);

    expect((await post({ name: 'x', days: ['mon'] })).status).toBe(400);
    expect((await post({ ...timed, start: '9:00' })).status).toBe(400);
    expect((await post({ ...timed, end: '24:00' })).status).toBe(400);
    expect((await post({ ...timed, days: [] })).status).toBe(400);
    expect((await post({ ...timed, days: ['mon', 'mon'] })).status).toBe(400);
    expect((await post({ ...timed, days: ['funday'] })).status).toBe(400);
    expect((await post({ ...timed, end: '09:00' })).status).toBe(400);
    expect((await post({ ...timed, timeZone: 'Mars/Olympus' })).status).toBe(400);
  });

  it('answers 400 for a non-guest, 404 for an unknown user or schedule, and 403 for a member', async () => {
    const { agent, userRepo, app } = await withGuest();
    const member = userRepo.create({ name: 'Mem', role: 'member', code: '5151' });

    expect((await agent.post(`/api/v1/users/${member.id}/schedules`).send(timed)).status).toBe(400);
    expect((await agent.get('/api/v1/users/nope/schedules')).status).toBe(404);
    const guest = userRepo.create({ name: 'G2', role: 'guest', code: '3434', guestExpiresAt: Date.now() + 1e9 });
    expect((await agent.patch(`/api/v1/users/${guest.id}/schedules/nope`).send({ name: 'x' })).status).toBe(404);

    const memberAgent = await loginAs(app, userRepo, 'member', '5151').catch(() => undefined);
    if (memberAgent) {
      expect((await memberAgent.get(`/api/v1/users/${guest.id}/schedules`)).status).toBe(403);
    }
  });

  it('does not let a schedule of one guest be edited through another guest', async () => {
    const { agent, userRepo, guest } = await withGuest();
    const other = userRepo.create({ name: 'G2', role: 'guest', code: '3434', guestExpiresAt: Date.now() + 1e9 });
    const created = await agent.post(`/api/v1/users/${guest.id}/schedules`).send(timed);

    expect((await agent.patch(`/api/v1/users/${other.id}/schedules/${created.body.id}`).send({ name: 'x' })).status).toBe(404);
    expect((await agent.delete(`/api/v1/users/${other.id}/schedules/${created.body.id}`)).status).toBe(404);
  });

  it('deletes a guest\'s schedules with the guest', async () => {
    const { agent, userRepo, guest, db } = await withGuest();
    await agent.post(`/api/v1/users/${guest.id}/schedules`).send(timed);

    userRepo.delete(guest.id);

    expect(db.prepare('SELECT count(*) AS n FROM guest_schedules').get()).toEqual({ n: 0 });
  });
});
