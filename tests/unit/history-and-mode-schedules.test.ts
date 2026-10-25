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
import { ModeScheduleRepository, ModeScheduleRunner } from '../../src/alarm/mode-schedule.js';
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
  const modeSchedules = new ModeScheduleRepository(db);
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
    modeSchedules,
    lockoutService,
    eventRepo,
    haLinkRepo: new HaLinkRepository(db),
    driver: { controller: { nodes: { get: (id: number) => (id === 5 || id === 6 ? {} : undefined) } } } as unknown as Driver,
  });
  return { app, userRepo, panelService, sensorRepo, zoneRepo, alarmEvents, sirenRepo, db, modeSchedules, eventRepo };
}

async function loginAs(app: Express, userRepo: UserRepository, role: 'administrator' | 'member' | 'installer', code: string) {
  userRepo.create({ name: role, role, code });
  const agent = request.agent(app);
  await agent.post('/api/v1/auth/login').send({ code }).expect(200);
  return agent;
}

describe('history events', () => {
  const originalEnv = { ...process.env };

  beforeEach(setEnv);
  afterEach(() => {
    vi.useRealTimers();
    process.env = { ...originalEnv };
  });

  async function admin() {
    const harness = await buildHarness();
    return { ...harness, agent: await loginAs(harness.app, harness.userRepo, 'administrator', '4141') };
  }

  it('fills the actor from the user, Home Assistant or System, and the device name from the sensor', async () => {
    const { eventRepo, userRepo, zoneRepo, sensorRepo } = await admin();
    const user = userRepo.list()[0];
    const sensor = sensorRepo.create({ zwaveNodeId: 5, zoneId: zoneRepo.create('House').id, name: 'Back door', category: 'intrusion' });

    const byUser = eventRepo.record({ type: 'armed', source: 'user', sourceUserId: user.id });
    const byHa = eventRepo.record({ type: 'armed', source: 'home_assistant' });
    const bySystem = eventRepo.record({ type: 'breach', source: 'system', relatedSensorId: sensor.id });
    const custom = eventRepo.record({ type: 'armed', source: 'system', actor: 'Schedule: Night', deviceId: 'node-9', deviceName: 'Front lock' });

    expect(byUser.actor).toBe('administrator');
    expect(byHa.actor).toBe('Home Assistant');
    expect(bySystem).toMatchObject({ actor: 'System', deviceId: sensor.id, deviceName: 'Back door' });
    expect(custom).toMatchObject({ actor: 'Schedule: Night', deviceId: 'node-9', deviceName: 'Front lock' });
  });

  it('records code changes without ever including the code', async () => {
    const { agent, eventRepo, userRepo } = await admin();
    const member = (await agent.post('/api/v1/users').send({ name: 'Mem', role: 'member', code: '2468' })).body;
    await agent.put(`/api/v1/users/${member.id}/code`).send({ code: '1357' });
    await agent.delete(`/api/v1/users/${member.id}/code`);
    const owner = userRepo.list().find((user) => user.role === 'administrator')!;
    await agent.put(`/api/v1/users/${owner.id}/duress-code`).send({ code: '9090' });
    await agent.delete(`/api/v1/users/${owner.id}/duress-code`);

    const events = eventRepo.list();
    expect(events.map((event) => event.type).slice(0, 5)).toEqual([
      'duress_code_removed',
      'duress_code_set',
      'code_removed',
      'code_changed',
      'code_added',
    ]);
    expect(JSON.stringify(events)).not.toMatch(/2468|1357|9090/);
    expect(events[0]).toMatchObject({ actor: 'administrator', source: 'user' });
  });

  it('records bypasses one per sensor, and the siren being silenced', async () => {
    const { panelService, eventRepo, zoneRepo, sensorRepo } = await admin();
    const door = sensorRepo.create({ zwaveNodeId: 5, zoneId: zoneRepo.create('House').id, name: 'Back door', category: 'intrusion', placement: 'WINDOW' });
    sensorRepo.updateState(door.id, { currentState: 'breached' });

    await panelService.arm('armed_away', { source: 'native', armSource: 'schedule', actor: 'Schedule: Night', systemEvent: true });
    const bypassed = eventRepo.list({ types: ['bypassed'] });
    panelService.raiseEmergency('PANIC');
    panelService.silence();

    expect(bypassed).toMatchObject([
      { type: 'bypassed', deviceId: door.id, deviceName: 'Back door', actor: 'Schedule: Night', source: 'system' },
    ]);
    expect(bypassed[0].details).toContain('(open)');
    expect(eventRepo.list({ types: ['siren_silenced'] })).toHaveLength(1);
  });

  it('records guest schedule changes', async () => {
    const { agent, eventRepo, userRepo } = await admin();
    const guest = userRepo.create({ name: 'Sitter', role: 'guest', code: '3333', guestExpiresAt: Date.now() + 1e9 });
    const created = (
      await agent.post(`/api/v1/users/${guest.id}/schedules`).send({ name: 'Days', days: ['mon'], start: '09:00', end: '17:00' })
    ).body;
    await agent.patch(`/api/v1/users/${guest.id}/schedules/${created.id}`).send({ end: '18:00' });
    await agent.delete(`/api/v1/users/${guest.id}/schedules/${created.id}`);

    const types = eventRepo.list().map((event) => event.type);
    expect(types.slice(0, 3)).toEqual(['guest_schedule_removed', 'guest_schedule_updated', 'guest_schedule_added']);
    expect(eventRepo.list()[2].details).toContain('Sitter');
  });
});

describe('GET /events filters', () => {
  const originalEnv = { ...process.env };

  beforeEach(setEnv);
  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('filters by type list, device, user and time, and pages with before', async () => {
    const { app, userRepo, eventRepo } = await buildHarness();
    const agent = await loginAs(app, userRepo, 'administrator', '4141');
    const user = userRepo.list()[0];
    const base = Date.now();
    for (let i = 0; i < 6; i += 1) {
      eventRepo.record({ type: i % 2 === 0 ? 'armed' : 'disarmed', source: 'user', sourceUserId: user.id, deviceId: i < 3 ? 'node-1' : 'node-2' });
    }
    eventRepo.record({ type: 'breach', source: 'system' });

    const types = await agent.get('/api/v1/events?type=armed,breach');
    expect(types.body.map((event: { type: string }) => event.type).sort()).toEqual(['armed', 'armed', 'armed', 'breach']);
    expect((await agent.get('/api/v1/events?deviceId=node-2')).body).toHaveLength(3);
    expect((await agent.get(`/api/v1/events?userId=${user.id}`)).body).toHaveLength(6);
    expect((await agent.get(`/api/v1/events?since=${String(base + 1e6)}`)).body).toEqual([]);
    expect((await agent.get(`/api/v1/events?until=${String(base - 1e6)}`)).body).toEqual([]);

    const first = (await agent.get('/api/v1/events?limit=3')).body;
    const second = (await agent.get(`/api/v1/events?limit=3&before=${first[2].id}`)).body;
    const third = (await agent.get(`/api/v1/events?limit=3&before=${second[2].id}`)).body;
    const ids = [...first, ...second, ...third].map((event: { id: string }) => event.id);
    expect(ids).toHaveLength(7);
    expect(new Set(ids).size).toBe(7);
    expect(first[0]).toMatchObject({ type: 'breach', actor: 'System' });
  });

  it('rejects an unknown type, a bad limit and an over-large limit', async () => {
    const { app, userRepo } = await buildHarness();
    const agent = await loginAs(app, userRepo, 'administrator', '4141');

    expect((await agent.get('/api/v1/events?type=armed,nope')).status).toBe(400);
    expect((await agent.get('/api/v1/events?limit=0')).status).toBe(400);
    expect((await agent.get('/api/v1/events?limit=501')).status).toBe(400);
    expect((await agent.get('/api/v1/events?limit=500')).status).toBe(200);
  });
});

describe('mode schedule routes', () => {
  const originalEnv = { ...process.env };

  beforeEach(setEnv);
  afterEach(() => {
    process.env = { ...originalEnv };
  });

  const night = { name: 'Night', mode: 'armed_home', time: '22:30', days: ['mon', 'tue'], timeZone: 'America/Chicago' };

  it('creates, lists, toggles, edits and deletes, recording history', async () => {
    const { app, userRepo, eventRepo } = await buildHarness();
    const agent = await loginAs(app, userRepo, 'administrator', '4141');

    const created = await agent.post('/api/v1/mode-schedules').send(night);
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ ...night, enabled: true, lastRunAt: null });
    expect((await agent.get('/api/v1/mode-schedules')).body).toHaveLength(1);

    const off = await agent.patch(`/api/v1/mode-schedules/${created.body.id}`).send({ enabled: false });
    expect(off.body.enabled).toBe(false);
    const moved = await agent.patch(`/api/v1/mode-schedules/${created.body.id}`).send({ time: '23:00', mode: 'armed_away' });
    expect(moved.body).toMatchObject({ time: '23:00', mode: 'armed_away' });

    expect((await agent.delete(`/api/v1/mode-schedules/${created.body.id}`)).status).toBe(204);
    expect((await agent.delete(`/api/v1/mode-schedules/${created.body.id}`)).status).toBe(404);
    expect(eventRepo.list().map((event) => event.type).slice(0, 4)).toEqual([
      'mode_schedule_removed',
      'mode_schedule_updated',
      'mode_schedule_updated',
      'mode_schedule_added',
    ]);
  });

  it('rejects a conflicting schedule with 409 schedule_conflict, but not a different time, day, zone or a disabled one', async () => {
    const { app, userRepo } = await buildHarness();
    const agent = await loginAs(app, userRepo, 'administrator', '4141');
    const first = (await agent.post('/api/v1/mode-schedules').send(night)).body;

    const clash = await agent.post('/api/v1/mode-schedules').send({ ...night, name: 'Clash', mode: 'disarmed', days: ['tue', 'wed'] });
    expect(clash.status).toBe(409);
    expect(clash.body.error).toMatchObject({ code: 'schedule_conflict', conflictsWith: first.id });

    expect((await agent.post('/api/v1/mode-schedules').send({ ...night, name: 'a', time: '22:31' })).status).toBe(201);
    expect((await agent.post('/api/v1/mode-schedules').send({ ...night, name: 'b', days: ['wed'] })).status).toBe(201);
    expect((await agent.post('/api/v1/mode-schedules').send({ ...night, name: 'c', timeZone: 'UTC' })).status).toBe(201);
    expect((await agent.post('/api/v1/mode-schedules').send({ ...night, name: 'd', enabled: false })).status).toBe(201);

    const reenable = (await agent.get('/api/v1/mode-schedules')).body.find((s: { name: string }) => s.name === 'd');
    expect((await agent.patch(`/api/v1/mode-schedules/${reenable.id}`).send({ enabled: true })).status).toBe(409);
  });

  it('is owner-only to change, and rejects bad bodies', async () => {
    const { app, userRepo } = await buildHarness();
    const member = await loginAs(app, userRepo, 'member', '5151');

    expect((await member.get('/api/v1/mode-schedules')).status).toBe(200);
    expect((await member.post('/api/v1/mode-schedules').send(night)).status).toBe(403);
    const agent = await loginAs(app, userRepo, 'administrator', '4141');
    for (const body of [
      { ...night, mode: 'home' },
      { ...night, time: '25:00' },
      { ...night, days: [] },
      { ...night, timeZone: 'Mars/Olympus' },
      { name: 'x' },
    ]) {
      expect((await agent.post('/api/v1/mode-schedules').send(body)).status).toBe(400);
    }
  });
});

describe('mode schedule runner', () => {
  const originalEnv = { ...process.env };

  beforeEach(setEnv);
  afterEach(() => {
    process.env = { ...originalEnv };
  });

  // 2026-10-26 is a Monday; 03:30Z is 22:30 the evening before in Chicago (CDT).
  const MONDAY_2230_CHICAGO = Date.parse('2026-10-27T03:30:30Z');
  const schedule = { name: 'Night', mode: 'armed_away' as const, time: '22:30', days: ['mon' as const], enabled: true, timeZone: 'America/Chicago' };

  async function runnerHarness() {
    const harness = await buildHarness();
    const runner = new ModeScheduleRunner(harness.modeSchedules, harness.panelService, harness.eventRepo, { now: () => MONDAY_2230_CHICAGO });
    return { ...harness, runner };
  }

  it('arms with source schedule at the right local minute, bypassing faulted sensors, and runs once per minute', async () => {
    const { runner, modeSchedules, panelService, eventRepo, sensorRepo, zoneRepo } = await runnerHarness();
    const door = sensorRepo.create({ zwaveNodeId: 5, zoneId: zoneRepo.create('House').id, name: 'Back door', category: 'intrusion', placement: 'WINDOW' });
    sensorRepo.updateState(door.id, { currentState: 'breached' });
    const created = modeSchedules.create(schedule);

    await runner.tick();
    await runner.tick();

    expect(panelService.getState()).toMatchObject({ mode: 'arming', armedMode: 'armed_away', bypassedDeviceIds: [door.id] });
    const applied = eventRepo.list({ types: ['mode_schedule_applied'] });
    expect(applied).toMatchObject([{ actor: 'Schedule: Night', source: 'system' }]);
    expect(eventRepo.list({ types: ['bypassed'] })).toMatchObject([{ actor: 'Schedule: Night', deviceId: door.id }]);
    expect(modeSchedules.findById(created.id)?.lastRunAt).toBe(MONDAY_2230_CHICAGO);
  });

  it('does nothing at another time, on another day, or when disabled', async () => {
    const { modeSchedules, panelService, eventRepo } = await runnerHarness();
    modeSchedules.create({ ...schedule, name: 'wrong time', time: '22:31' });
    modeSchedules.create({ ...schedule, name: 'wrong day', days: ['tue'] });
    modeSchedules.create({ ...schedule, name: 'off', time: '22:30', enabled: false });
    const runner = new ModeScheduleRunner(modeSchedules, panelService, eventRepo, { now: () => MONDAY_2230_CHICAGO });

    await runner.tick();

    expect(panelService.getState().mode).toBe('disarmed');
    expect(eventRepo.list({ types: ['mode_schedule_applied', 'mode_schedule_skipped'] })).toEqual([]);
  });

  it('switches between armed modes by disarming first, disarms on a disarmed schedule, and skips what is already true', async () => {
    const { runner, modeSchedules, panelService, eventRepo } = await runnerHarness();
    await panelService.arm('armed_home', { source: 'native' });
    modeSchedules.create(schedule);
    await new Promise((resolve) => setTimeout(resolve, 5));

    await runner.tick();
    expect(panelService.getState()).toMatchObject({ mode: 'arming', armedMode: 'armed_away' });

    modeSchedules.create({ ...schedule, name: 'Skip', time: '22:31', mode: 'disarmed' });
    const skipRunner = new ModeScheduleRunner(modeSchedules, panelService, eventRepo, { now: () => MONDAY_2230_CHICAGO + 60_000 });
    await skipRunner.tick();
    expect(panelService.getState().mode).toBe('disarmed');

    const again = modeSchedules.create({ ...schedule, name: 'Again', time: '22:32', mode: 'disarmed' });
    await new ModeScheduleRunner(modeSchedules, panelService, eventRepo, { now: () => MONDAY_2230_CHICAGO + 120_000 }).tick();
    expect(eventRepo.list({ types: ['mode_schedule_skipped'] })[0]).toMatchObject({ actor: 'Schedule: Again' });
    expect(modeSchedules.findById(again.id)?.lastRunAt).not.toBeNull();
  });

  it('never disarms or arms over an alarm, and records why it skipped', async () => {
    const { runner, modeSchedules, panelService, eventRepo } = await runnerHarness();
    panelService.raiseEmergency('PANIC');
    modeSchedules.create({ ...schedule, mode: 'disarmed' });

    await runner.tick();

    expect(panelService.getState().mode).toBe('alarm_triggered');
    expect(eventRepo.list({ types: ['mode_schedule_skipped'] })[0].details).toContain('alarm is in progress');
  });
});

describe('migration 013 and 014', () => {
  it('keep every existing event with its actor and device filled in, and the panel pointing at its trigger', () => {
    const db = createDatabase(':memory:');
    const eventRepo = new EventRepository(db);

    const event = eventRepo.record({ type: 'alarm_triggered', source: 'system' });
    db.prepare("UPDATE alarm_panel SET triggered_by = NULL").run();

    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(eventRepo.findById(event.id)?.actor).toBe('System');
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'mode_schedules'").get()).toBeTruthy();
    expect(() => db.prepare("INSERT INTO mode_schedules (id, name, mode, time_of_day, days, enabled, created_at) VALUES ('x','n','away','22:30','[]',1,0)").run()).toThrow(/CHECK/);
  });
});
