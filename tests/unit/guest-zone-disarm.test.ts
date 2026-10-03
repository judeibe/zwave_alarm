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
import { buildLiveSnapshot } from '../../src/api/ws-broadcaster.js';

/**
 * FR-010a: a guest can be restricted to a single zone (say, the downstairs). When that guest
 * disarms the panel it disarms only their zone; the rest stays armed.
 */

const ENV_KEYS = ['SERIAL_PORT', 'DB_PATH', 'HTTP_PORT', 'ZWAVE_SERVER_PORT', 'SESSION_SECRET'] as const;
const DELAY_MS = 30_000;

function setEnv() {
  process.env.SERIAL_PORT = '/dev/ttyACM0';
  process.env.DB_PATH = ':memory:';
  process.env.HTTP_PORT = '3000';
  process.env.ZWAVE_SERVER_PORT = '3001';
  process.env.SESSION_SECRET = 'test-secret-0123456789abcdef0123456789';
}

function buildFixture() {
  const db = createDatabase(':memory:');
  const panelRepo = new AlarmPanelRepository(db);
  const eventRepo = new EventRepository(db);
  const zoneRepo = new ZoneRepository(db);
  const sensorRepo = new SensorRepository(db);
  const userRepo = new UserRepository(db);
  const newService = () => new PanelService(panelRepo, eventRepo, { exitDelayMs: DELAY_MS, entryDelayMs: DELAY_MS });
  const panelService = newService();

  const downstairs = zoneRepo.create('Downstairs');
  const upstairs = zoneRepo.create('Upstairs');
  const downDoor = sensorRepo.create({ zwaveNodeId: 2, zoneId: downstairs.id, name: 'Back door', category: 'intrusion' });
  const upWindow = sensorRepo.create({ zwaveNodeId: 3, zoneId: upstairs.id, name: 'Bedroom window', category: 'intrusion' });
  const downSmoke = sensorRepo.create({ zwaveNodeId: 4, zoneId: downstairs.id, name: 'Kitchen smoke', category: 'life-safety' });
  const owner = userRepo.create({ name: 'Owner', role: 'administrator', code: 'admin1' });
  const guest = userRepo.create({ name: 'Sitter', role: 'guest', code: 'guest1', guestZoneId: downstairs.id });

  /** Puts the panel straight into an armed state, as if it had been armed earlier. */
  const armPanel = (mode: 'armed_away' | 'armed_home' = 'armed_away') =>
    panelRepo.updatePanel({ mode, armedMode: mode, pendingDelayEndsAt: null, triggeredBy: null });
  const guestDisarm = () =>
    panelService.disarmZone(downstairs.id, {
      source: 'native',
      sourceUserId: guest.id,
      clearedBy: guest.name,
      zoneName: downstairs.name,
    });

  return {
    db, panelRepo, eventRepo, zoneRepo, sensorRepo, userRepo, panelService, newService,
    downstairs, upstairs, downDoor, upWindow, downSmoke, owner, guest, armPanel, guestDisarm,
  };
}

describe('zone-restricted guest disarm', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('PanelService.disarmZone', () => {
    it('disarms only the guest zone: the panel stays armed and reports the zone as disarmed', async () => {
      const f = buildFixture();
      f.armPanel('armed_away');
      const changed = vi.fn();
      f.panelService.on('panel_changed', changed);

      const panel = await f.guestDisarm();

      expect(panel).toMatchObject({ mode: 'armed_away', disarmedZoneIds: [f.downstairs.id] });
      expect(changed).toHaveBeenCalledTimes(1); // clients must learn about it though the mode is unchanged
      expect(f.eventRepo.list()[0]).toMatchObject({
        type: 'disarmed',
        sourceUserId: f.guest.id,
        relatedZoneId: f.downstairs.id,
        details: expect.stringContaining('Downstairs'),
      });
    });

    it('ignores intrusion breaches in the disarmed zone but still reacts to other zones', async () => {
      const f = buildFixture();
      f.armPanel();
      await f.guestDisarm();

      f.panelService.reportSensorBreach(f.downDoor);
      expect(f.panelRepo.getPanel().mode).toBe('armed_away');

      f.panelService.reportSensorBreach(f.upWindow);
      expect(f.panelRepo.getPanel().mode).toBe('alarm_pending');
      f.panelService.stop();
    });

    it('never bypasses a life-safety sensor, even in the disarmed zone (FR-015)', async () => {
      const f = buildFixture();
      f.armPanel();
      await f.guestDisarm();

      f.panelService.reportSensorBreach(f.downSmoke);

      expect(f.panelRepo.getPanel().mode).toBe('alarm_triggered');
    });

    it('stands down a pending alarm caused by a breach in the guest zone, back to the armed mode', async () => {
      const f = buildFixture();
      f.armPanel('armed_home');
      f.panelService.reportSensorBreach(f.downDoor);
      expect(f.panelRepo.getPanel().mode).toBe('alarm_pending');

      const panel = await f.guestDisarm();
      await vi.advanceTimersByTimeAsync(DELAY_MS * 2); // the cancelled entry delay must not fire

      expect(panel).toMatchObject({ mode: 'armed_home', pendingDelayEndsAt: null, triggeredBy: null });
      expect(f.panelRepo.getPanel().mode).toBe('armed_home');
      expect(f.eventRepo.list()[0]).toMatchObject({ type: 'alarm_cleared', relatedZoneId: f.downstairs.id });
    });

    it('stands down a triggered alarm caused by a breach in the guest zone', async () => {
      const f = buildFixture();
      f.armPanel();
      f.panelService.reportSensorBreach(f.downDoor);
      await vi.advanceTimersByTimeAsync(DELAY_MS);
      expect(f.panelRepo.getPanel().mode).toBe('alarm_triggered');

      await f.guestDisarm();

      expect(f.panelRepo.getPanel()).toMatchObject({ mode: 'armed_away', triggeredBy: null });
    });

    it('cannot clear an alarm that another zone caused', async () => {
      const f = buildFixture();
      f.armPanel();
      f.panelService.reportSensorBreach(f.upWindow);

      const panel = await f.guestDisarm();
      expect(panel.mode).toBe('alarm_pending');

      await vi.advanceTimersByTimeAsync(DELAY_MS);
      expect(f.panelRepo.getPanel().mode).toBe('alarm_triggered');

      await f.guestDisarm();
      expect(f.panelRepo.getPanel().mode).toBe('alarm_triggered');
    });

    it('cannot clear an alarm with no zone at all, such as one raised by repeated wrong codes', async () => {
      const f = buildFixture();
      f.armPanel();
      f.panelService.triggerAlarm({ details: 'Failed disarm-attempt threshold exceeded' });

      await f.guestDisarm();

      expect(f.panelRepo.getPanel().mode).toBe('alarm_triggered');
    });

    it('clears a life-safety alarm in the guest zone raised while disarmed, returning to disarmed', async () => {
      const f = buildFixture();
      f.panelService.reportSensorBreach(f.downSmoke);
      expect(f.panelRepo.getPanel()).toMatchObject({ mode: 'alarm_triggered', armedMode: null });

      await f.guestDisarm();

      expect(f.panelRepo.getPanel()).toMatchObject({ mode: 'disarmed', disarmedZoneIds: [] });
    });

    it('is a no-op while the panel is disarmed', async () => {
      const f = buildFixture();

      const panel = await f.guestDisarm();

      expect(panel).toMatchObject({ mode: 'disarmed', disarmedZoneIds: [] });
      expect(f.eventRepo.list()).toHaveLength(0);
    });

    it('applies during the exit delay: the zone is already disarmed once the panel finishes arming', async () => {
      const f = buildFixture();
      const arming = f.panelService.arm('armed_away', { source: 'native', sourceUserId: f.owner.id });
      await vi.advanceTimersByTimeAsync(0);
      await arming;
      await f.guestDisarm();
      await vi.advanceTimersByTimeAsync(DELAY_MS);
      expect(f.panelRepo.getPanel().mode).toBe('armed_away');

      f.panelService.reportSensorBreach(f.downDoor);

      expect(f.panelRepo.getPanel().mode).toBe('armed_away');
    });

    it('is forgotten on a full disarm and on the next arming, so the zone is protected again', async () => {
      const f = buildFixture();
      f.armPanel();
      await f.guestDisarm();

      const disarm = f.panelService.disarm({ source: 'native', sourceUserId: f.owner.id });
      await vi.advanceTimersByTimeAsync(0);
      expect(await disarm).toMatchObject({ mode: 'disarmed', disarmedZoneIds: [] });

      f.armPanel();
      f.panelService.reportSensorBreach(f.downDoor);
      expect(f.panelRepo.getPanel().mode).toBe('alarm_pending');
      f.panelService.stop();
    });

    it('a fresh arming clears zones disarmed earlier', async () => {
      const f = buildFixture();
      f.armPanel();
      await f.guestDisarm();
      f.panelRepo.updatePanel({ mode: 'disarmed', armedMode: null }); // left the zone list behind on purpose

      const arming = f.panelService.arm('armed_away', { source: 'native', sourceUserId: f.owner.id });
      await vi.advanceTimersByTimeAsync(0);

      expect((await arming).disarmedZoneIds).toEqual([]);
      f.panelService.stop();
    });

    it('survives a restart', async () => {
      const f = buildFixture();
      f.armPanel();
      await f.guestDisarm();

      const restarted = f.newService();
      restarted.resume();
      restarted.reportSensorBreach(f.downDoor);

      expect(f.panelRepo.getPanel()).toMatchObject({ mode: 'armed_away', disarmedZoneIds: [f.downstairs.id] });
    });

    it('is included in the live WebSocket snapshot', async () => {
      const f = buildFixture();
      f.armPanel();
      await f.guestDisarm();

      const snapshot = buildLiveSnapshot({ panelService: f.panelService, zoneRepo: f.zoneRepo });

      expect(snapshot.panel).toMatchObject({ mode: 'armed_away', disarmedZoneIds: [f.downstairs.id] });
    });
  });
});

describe('POST /api/v1/panel/disarm as a guest', () => {
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

  async function buildHarness() {
    const f = buildFixture();
    const lockoutService = new LockoutService(f.userRepo, new LockoutPolicyRepository(f.db), f.eventRepo, f.panelService);
    const { createApp } = await import('../../src/api/app.js');
    const { HaLinkRepository } = await import('../../src/db/repositories/ha-link-repository.js');
    const app: Express = createApp({
      panelService: f.panelService,
      userRepo: f.userRepo,
      zoneRepo: f.zoneRepo,
      sensorRepo: f.sensorRepo,
      lockoutService,
      eventRepo: f.eventRepo,
      haLinkRepo: new HaLinkRepository(f.db),
      driver: { controller: { nodes: new Map() } } as unknown as Driver,
    });
    return { ...f, app };
  }

  async function loginAs(app: Express, code: string) {
    const agent = request.agent(app);
    await agent.post('/api/v1/auth/login').send({ code }).expect(200);
    return agent;
  }

  beforeEach(() => {
    vi.useRealTimers(); // supertest needs real timers; the fixture's service has none running
  });

  it('disarms only the guest zone and reports it, leaving the panel armed', async () => {
    const h = await buildHarness();
    h.armPanel('armed_away');
    const guest = await loginAs(h.app, 'guest1');

    const res = await guest.post('/api/v1/panel/disarm').send({ code: 'guest1' });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ mode: 'armed_away', disarmedZoneIds: [h.downstairs.id] });
    expect(h.panelRepo.getPanel().mode).toBe('armed_away');
  });

  it('records guest_code_used and who disarmed which zone', async () => {
    const h = await buildHarness();
    h.armPanel();
    const guest = await loginAs(h.app, 'guest1');

    await guest.post('/api/v1/panel/disarm').send({ code: 'guest1' }).expect(200);

    const events = h.eventRepo.list();
    expect(events.map((e) => e.type)).toEqual(expect.arrayContaining(['guest_code_used', 'disarmed']));
    expect(events.find((e) => e.type === 'guest_code_used')).toMatchObject({
      sourceUserId: h.guest.id,
      relatedZoneId: h.downstairs.id,
    });
    expect(events.find((e) => e.type === 'disarmed')?.details).toContain('Downstairs');
  });

  it('does not record guest_code_used for a wrong code', async () => {
    const h = await buildHarness();
    h.armPanel();
    const guest = await loginAs(h.app, 'guest1');

    await guest.post('/api/v1/panel/disarm').send({ code: 'wrong' }).expect(401);

    expect(h.eventRepo.list().some((e) => e.type === 'guest_code_used')).toBe(false);
  });

  it('still lets an unrestricted guest (expiry only) disarm the whole panel, recording guest_code_used', async () => {
    const h = await buildHarness();
    h.userRepo.create({ name: 'Visitor', role: 'guest', code: 'visitor1', guestExpiresAt: Date.now() + 60_000 });
    h.armPanel();
    const visitor = await loginAs(h.app, 'visitor1');

    const res = await visitor.post('/api/v1/panel/disarm').send({ code: 'visitor1' });

    expect(res.body).toMatchObject({ mode: 'disarmed', disarmedZoneIds: [] });
    expect(h.eventRepo.list().some((e) => e.type === 'guest_code_used')).toBe(true);
  });

  it('leaves an administrator\'s disarm as a full disarm', async () => {
    const h = await buildHarness();
    h.armPanel();
    const admin = await loginAs(h.app, 'admin1');

    const res = await admin.post('/api/v1/panel/disarm').send({ code: 'admin1' });

    expect(res.body.mode).toBe('disarmed');
    expect(h.eventRepo.list().some((e) => e.type === 'guest_code_used')).toBe(false);
  });

  it('reports the disarmed zones to a member via GET /panel', async () => {
    const h = await buildHarness();
    h.armPanel();
    const guest = await loginAs(h.app, 'guest1');
    await guest.post('/api/v1/panel/disarm').send({ code: 'guest1' }).expect(200);
    const admin = await loginAs(h.app, 'admin1');

    const res = await admin.get('/api/v1/panel');

    expect(res.body).toMatchObject({ mode: 'armed_away', disarmedZoneIds: [h.downstairs.id] });
  });

  describe('creating a zone-restricted guest', () => {
    it('accepts an existing zone and rejects an unknown one with 400, not 500', async () => {
      const h = await buildHarness();
      const admin = await loginAs(h.app, 'admin1');

      const ok = await admin
        .post('/api/v1/users')
        .send({ name: 'Nanny', role: 'guest', code: 'nanny1', guestZoneId: h.upstairs.id });
      const unknown = await admin
        .post('/api/v1/users')
        .send({ name: 'Ghost', role: 'guest', code: 'ghost1', guestZoneId: 'no-such-zone' });

      expect(ok.status).toBe(201);
      expect(ok.body.guestZoneId).toBe(h.upstairs.id);
      expect(unknown.status).toBe(400);
      expect(unknown.body.error.message).toContain('guestZoneId');
    });
  });
});
