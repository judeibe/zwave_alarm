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
import { LockService } from '../../src/locks/lock-service.js';

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
  const raw: Record<number, number> = { 3: 0xff, 6: 0x01_00_00_00, 16: 4 };
  const port = {
    readParameter: vi.fn((_n: number, parameter: number) => Promise.resolve(raw[parameter])),
    writeParameter: vi.fn((_n: number, parameter: number, _s: 1 | 4, value: number) => {
      raw[parameter] = value;
      return Promise.resolve();
    }),
    setUserCode: vi.fn().mockResolvedValue(undefined),
    clearUserCode: vi.fn().mockResolvedValue(undefined),
    getUserSlot: vi.fn((_n: number, userId: number) => Promise.resolve({ userId, status: 'enabled' as const })),
    getScheduleSlotCounts: vi.fn().mockResolvedValue({ weekDay: 7, yearDay: 7, dailyRepeating: 7 }),
    setScheduleEnabled: vi.fn().mockResolvedValue(undefined),
    setSchedule: vi.fn().mockResolvedValue(undefined),
    getSchedule: vi.fn().mockResolvedValue({ weekday: 1, startHour: 8, startMinute: 0, stopHour: 17, stopMinute: 0 }),
  };
  const lockService = new LockService(port);
  lockService.add(5, { model: 'BE469', label: 'Schlage BE469' }, { batteryLevel: 90 });
  lockService.add(6, { model: 'BE468', label: 'Schlage BE468' });
  await lockService.refresh(5);

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
    lockService,
    driver: { controller: { nodes: new Map() } } as unknown as Driver,
  });
  return { app, userRepo, port };
}

async function loginAs(app: Express, userRepo: UserRepository, role: 'administrator' | 'member' | 'guest', code: string) {
  userRepo.create({ name: role, role, code, guestExpiresAt: role === 'guest' ? Date.now() + 100_000 : undefined });
  const agent = request.agent(app);
  await agent.post('/api/v1/auth/login').send({ code }).expect(200);
  return agent;
}

describe('lock routes', () => {
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

  it('lists locks with settings, diagnostics and supported settings', async () => {
    const { app, userRepo } = await buildHarness();
    const agent = await loginAs(app, userRepo, 'member', '1234');

    const res = await agent.get('/api/v1/locks').expect(200);

    expect(res.body.locks).toHaveLength(2);
    expect(res.body.locks[0]).toMatchObject({
      nodeId: 5,
      model: 'BE469',
      batteryLevel: 90,
      settings: { beeper: true, pinLength: 4 },
      diagnostics: { occupiedUserSlots: [1], userSlotBitField: [1, 0, 0, 0] },
      scheduleSlots: { weekDay: 7, yearDay: 7, dailyRepeating: 7 },
      userSlotCount: 30,
    });
    expect(res.body.locks[1].supportedSettings).not.toContain('alarmMode');
  });

  it('requires authentication and refuses guests', async () => {
    const { app, userRepo } = await buildHarness();
    await request(app).get('/api/v1/locks').expect(401);
    const guest = await loginAs(app, userRepo, 'guest', '9999');
    await guest.get('/api/v1/locks').expect(403);
  });

  it('returns one lock, and 404 for an unknown one', async () => {
    const { app, userRepo } = await buildHarness();
    const agent = await loginAs(app, userRepo, 'member', '1234');
    await agent.get('/api/v1/locks/5').expect(200);
    await agent.get('/api/v1/locks/99').expect(404);
    await agent.get('/api/v1/locks/abc').expect(400);
  });

  describe('PATCH settings', () => {
    it('writes the settings and returns the updated lock', async () => {
      const { app, userRepo, port } = await buildHarness();
      const agent = await loginAs(app, userRepo, 'administrator', '1234');

      const res = await agent.patch('/api/v1/locks/5/settings').send({ autoLock: true, alarmMode: 'alert', pinLength: 6 }).expect(200);

      expect(res.body.settings).toMatchObject({ autoLock: true, alarmMode: 'alert', pinLength: 6 });
      expect(port.writeParameter).toHaveBeenCalledWith(5, 15, 1, 0xff);
    });

    it('rejects invalid bodies with 400 and BE469-only settings on a BE468', async () => {
      const { app, userRepo } = await buildHarness();
      const agent = await loginAs(app, userRepo, 'administrator', '1234');

      await agent.patch('/api/v1/locks/5/settings').send({}).expect(400);
      await agent.patch('/api/v1/locks/5/settings').send({ pinLength: 3 }).expect(400);
      await agent.patch('/api/v1/locks/5/settings').send({ alarmMode: 'loud' }).expect(400);
      await agent.patch('/api/v1/locks/5/settings').send({ electronicFailedCount: 0 }).expect(400);
      await agent.patch('/api/v1/locks/6/settings').send({ kickSensitivity: 3 }).expect(400);
    });

    it('answers 502 when the lock does not take the write', async () => {
      const { app, userRepo, port } = await buildHarness();
      const agent = await loginAs(app, userRepo, 'administrator', '1234');
      port.writeParameter.mockRejectedValueOnce(new Error('no ack'));

      const res = await agent.patch('/api/v1/locks/5/settings').send({ beeper: false }).expect(502);
      expect(res.body.error.code).toBe('lock_unavailable');
    });
  });

  describe('user codes', () => {
    it('sets a code matching the PIN length without echoing it back', async () => {
      const { app, userRepo, port } = await buildHarness();
      const agent = await loginAs(app, userRepo, 'administrator', '1234');

      const res = await agent.put('/api/v1/locks/5/users/3/code').send({ code: '4321', status: 'disabled' }).expect(200);

      expect(res.body).toEqual({ userId: 3, status: 'disabled' });
      expect(port.setUserCode).toHaveBeenCalledWith(5, 3, 'disabled', '4321');
    });

    it('rejects wrong-length and non-numeric codes', async () => {
      const { app, userRepo } = await buildHarness();
      const agent = await loginAs(app, userRepo, 'administrator', '1234');

      await agent.put('/api/v1/locks/5/users/3/code').send({ code: '123456' }).expect(400);
      await agent.put('/api/v1/locks/5/users/3/code').send({ code: 'abcd' }).expect(400);
      await agent.put('/api/v1/locks/5/users/31/code').send({ code: '1234' }).expect(400);
    });

    it('clears a code and lists the slots', async () => {
      const { app, userRepo, port } = await buildHarness();
      const agent = await loginAs(app, userRepo, 'administrator', '1234');

      await agent.delete('/api/v1/locks/5/users/1/code').expect(204);
      expect(port.clearUserCode).toHaveBeenCalledWith(5, 1);

      const res = await agent.get('/api/v1/locks/5/users').expect(200);
      expect(res.body.users).toHaveLength(30);
    });
  });

  describe('schedules', () => {
    it('reports the slot counts', async () => {
      const { app, userRepo } = await buildHarness();
      const agent = await loginAs(app, userRepo, 'member', '1234');
      const res = await agent.get('/api/v1/locks/5/schedules').expect(200);
      expect(res.body).toEqual({ slots: { weekDay: 7, yearDay: 7, dailyRepeating: 7 } });
    });

    it('sets a weekday, year-day and daily-repeating schedule', async () => {
      const { app, userRepo, port } = await buildHarness();
      const agent = await loginAs(app, userRepo, 'administrator', '1234');
      const weekDay = { weekday: 2, startHour: 9, startMinute: 0, stopHour: 17, stopMinute: 0 };
      const yearDay = { startYear: 26, startMonth: 1, startDay: 2, startHour: 0, startMinute: 0, stopYear: 26, stopMonth: 1, stopDay: 9, stopHour: 12, stopMinute: 0 };
      const daily = { weekdays: [1, 2, 3], startHour: 8, startMinute: 30, durationHour: 9, durationMinute: 0 };

      await agent.put('/api/v1/locks/5/users/2/schedules/weekDay/1').send(weekDay).expect(204);
      await agent.put('/api/v1/locks/5/users/2/schedules/yearDay/2').send(yearDay).expect(204);
      await agent.put('/api/v1/locks/5/users/2/schedules/dailyRepeating/3').send(daily).expect(204);

      expect(port.setSchedule).toHaveBeenCalledWith(5, 'weekDay', 2, 1, weekDay);
      expect(port.setSchedule).toHaveBeenCalledWith(5, 'yearDay', 2, 2, yearDay);
      expect(port.setSchedule).toHaveBeenCalledWith(5, 'dailyRepeating', 2, 3, daily);
    });

    it('rejects an invalid schedule, a bad kind and an out-of-range slot', async () => {
      const { app, userRepo } = await buildHarness();
      const agent = await loginAs(app, userRepo, 'administrator', '1234');

      await agent.put('/api/v1/locks/5/users/2/schedules/weekDay/1').send({ weekday: 9, startHour: 9, startMinute: 0, stopHour: 17, stopMinute: 0 }).expect(400);
      await agent.put('/api/v1/locks/5/users/2/schedules/weekDay/1').send({ weekday: 1, startHour: 18, startMinute: 0, stopHour: 17, stopMinute: 0 }).expect(400);
      await agent.put('/api/v1/locks/5/users/2/schedules/dailyRepeating/1').send({ weekdays: [1, 1], startHour: 8, startMinute: 0, durationHour: 1, durationMinute: 0 }).expect(400);
      await agent.put('/api/v1/locks/5/users/2/schedules/monthly/1').send({}).expect(404);
      await agent.delete('/api/v1/locks/5/users/2/schedules/weekDay/8').expect(400);
    });

    it('reads, clears and toggles schedules', async () => {
      const { app, userRepo, port } = await buildHarness();
      const agent = await loginAs(app, userRepo, 'administrator', '1234');

      const read = await agent.get('/api/v1/locks/5/users/2/schedules/weekDay/1').expect(200);
      expect(read.body).toMatchObject({ kind: 'weekDay', userId: 2, slotId: 1, schedule: { weekday: 1 } });

      await agent.delete('/api/v1/locks/5/users/2/schedules/weekDay/1').expect(204);
      expect(port.setSchedule).toHaveBeenCalledWith(5, 'weekDay', 2, 1, undefined);

      await agent.put('/api/v1/locks/5/users/2/schedules/enabled').send({ enabled: false }).expect(204);
      expect(port.setScheduleEnabled).toHaveBeenCalledWith(5, 2, false);
      await agent.put('/api/v1/locks/5/users/2/schedules/enabled').send({ enabled: 'no' }).expect(400);
    });
  });
});
