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
  process.env.SESSION_SECRET = 'test-secret';
}

class MockNodeMap {
  private readonly byId = new Map<number, object>();
  get(id: number): object | undefined {
    return this.byId.get(id);
  }
}
class MockController {
  nodes = new MockNodeMap();
}
class MockDriver {
  controller = new MockController();
}

async function buildHarness(): Promise<{
  app: Express;
  userRepo: UserRepository;
  lockoutPolicyRepo: LockoutPolicyRepository;
}> {
  const db = createDatabase(':memory:');
  const panelRepo = new AlarmPanelRepository(db);
  const eventRepo = new EventRepository(db);
  const zoneRepo = new ZoneRepository(db);
  const sensorRepo = new SensorRepository(db);
  const userRepo = new UserRepository(db);
  const lockoutPolicyRepo = new LockoutPolicyRepository(db);
  // Long exit/entry delays: arm()/disarm() resolve synchronously with the
  // immediate 'arming'/'disarmed' snapshot regardless (PanelService doesn't
  // await the delay), but a short delay could let a stray timer fire mid-test.
  const panelService = new PanelService(panelRepo, eventRepo, { exitDelayMs: 100_000, entryDelayMs: 100_000 });
  const lockoutService = new LockoutService(userRepo, lockoutPolicyRepo, eventRepo, panelService);
  const driver = new MockDriver() as unknown as Driver;

  const { createApp } = await import('../../src/api/app.js');
  const app = createApp({ panelService, userRepo, zoneRepo, sensorRepo, lockoutService, driver });

  // Test-only bypass that establishes a session directly, skipping the real
  // login route's own guest-expiry check -- used to reach panel/disarm's
  // *own* expiry check with a guest whose window has already closed (a real
  // login attempt for such a guest would already 401 before ever reaching
  // disarm, per auth-routes.ts).
  app.post('/test/session', (req, res) => {
    req.session.userId = req.body.userId as string;
    req.session.role = req.body.role as 'administrator' | 'member' | 'guest';
    res.status(200).json({ ok: true });
  });

  return { app, userRepo, lockoutPolicyRepo };
}

async function loginAs(app: Express, code: string) {
  const agent = request.agent(app);
  await agent.post('/api/v1/auth/login').send({ code }).expect(200);
  return agent;
}

describe('panel routes', () => {
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

  it('rejects GET /panel with no auth as 401', async () => {
    const { app } = await buildHarness();

    const res = await request(app).get('/api/v1/panel');

    expect(res.status).toBe(401);
  });

  it('returns the disarmed default panel state to a member', async () => {
    const { app, userRepo } = await buildHarness();
    userRepo.create({ name: 'Mem', role: 'member', code: 'member1' });
    const agent = await loginAs(app, 'member1');

    const res = await agent.get('/api/v1/panel');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ mode: 'disarmed', pendingDelayEndsAt: null, triggeredBy: null });
  });

  it('rejects GET /panel for a guest as 403', async () => {
    const { app, userRepo } = await buildHarness();
    userRepo.create({ name: 'G', role: 'guest', code: 'guestcode', guestExpiresAt: Date.now() + 100_000 });
    const agent = await loginAs(app, 'guestcode');

    const res = await agent.get('/api/v1/panel');

    expect(res.status).toBe(403);
  });

  it('starts the exit delay on POST /panel/arm for a member', async () => {
    const { app, userRepo } = await buildHarness();
    userRepo.create({ name: 'Mem', role: 'member', code: 'member1' });
    const agent = await loginAs(app, 'member1');

    const res = await agent.post('/api/v1/panel/arm').send({ mode: 'armed_away' });

    expect(res.status).toBe(200);
    expect(res.body.mode).toBe('arming');
    expect(res.body.pendingDelayEndsAt).not.toBeNull();
  });

  it('rejects an arm request from a guest as 403', async () => {
    const { app, userRepo } = await buildHarness();
    userRepo.create({ name: 'G', role: 'guest', code: 'guestcode', guestExpiresAt: Date.now() + 100_000 });
    const agent = await loginAs(app, 'guestcode');

    const res = await agent.post('/api/v1/panel/arm').send({ mode: 'armed_away' });

    expect(res.status).toBe(403);
  });

  it('rejects an invalid arm mode as 400', async () => {
    const { app, userRepo } = await buildHarness();
    userRepo.create({ name: 'Mem', role: 'member', code: 'member1' });
    const agent = await loginAs(app, 'member1');

    const res = await agent.post('/api/v1/panel/arm').send({ mode: 'not_a_mode' });

    expect(res.status).toBe(400);
  });

  it('rejects a second arm request while already arming as 409', async () => {
    const { app, userRepo } = await buildHarness();
    userRepo.create({ name: 'Mem', role: 'member', code: 'member1' });
    const agent = await loginAs(app, 'member1');
    await agent.post('/api/v1/panel/arm').send({ mode: 'armed_away' }).expect(200);

    const res = await agent.post('/api/v1/panel/arm').send({ mode: 'armed_away' });

    expect(res.status).toBe(409);
  });

  it('rejects disarm with no auth as 401', async () => {
    const { app } = await buildHarness();

    const res = await request(app).post('/api/v1/panel/disarm').send({ code: 'whatever' });

    expect(res.status).toBe(401);
  });

  it('disarms successfully with the correct code and clears an active alarm', async () => {
    const { app, userRepo } = await buildHarness();
    userRepo.create({ name: 'Owner', role: 'administrator', code: '123456' });
    const agent = await loginAs(app, '123456');
    await agent.post('/api/v1/panel/arm').send({ mode: 'armed_away' }).expect(200);

    const res = await agent.post('/api/v1/panel/disarm').send({ code: '123456' });

    expect(res.status).toBe(200);
    expect(res.body.mode).toBe('disarmed');
  });

  it('increments failedAttemptCount on a wrong disarm code without locking below threshold', async () => {
    const { app, userRepo } = await buildHarness();
    const user = userRepo.create({ name: 'Owner', role: 'administrator', code: '123456' });
    const agent = await loginAs(app, '123456');

    const res = await agent.post('/api/v1/panel/disarm').send({ code: 'wrong' });

    expect(res.status).toBe(401);
    expect(userRepo.findById(user.id)?.failedAttemptCount).toBe(1);
  });

  it('locks the account after failedAttemptThreshold wrong disarm codes (default lockout mode)', async () => {
    const { app, userRepo, lockoutPolicyRepo } = await buildHarness();
    lockoutPolicyRepo.updatePolicy({ failedAttemptThreshold: 2 });
    const user = userRepo.create({ name: 'Owner', role: 'administrator', code: '123456' });
    const agent = await loginAs(app, '123456');

    await agent.post('/api/v1/panel/disarm').send({ code: 'wrong' }).expect(401);
    const res = await agent.post('/api/v1/panel/disarm').send({ code: 'wrong' });

    expect(res.status).toBe(423);
    expect(userRepo.findById(user.id)?.lockedUntil).not.toBeNull();
  });

  it('rejects further disarm attempts on an already-locked account as 423 without re-incrementing', async () => {
    const { app, userRepo, lockoutPolicyRepo } = await buildHarness();
    lockoutPolicyRepo.updatePolicy({ failedAttemptThreshold: 1 });
    const user = userRepo.create({ name: 'Owner', role: 'administrator', code: '123456' });
    const agent = await loginAs(app, '123456');
    await agent.post('/api/v1/panel/disarm').send({ code: 'wrong' }).expect(423);

    const res = await agent.post('/api/v1/panel/disarm').send({ code: 'wrong-again' });

    expect(res.status).toBe(423);
    expect(userRepo.findById(user.id)?.failedAttemptCount).toBe(1);
  });

  it('triggers the alarm instead of locking when onThresholdExceeded is trigger_alarm', async () => {
    const { app, userRepo, lockoutPolicyRepo } = await buildHarness();
    lockoutPolicyRepo.updatePolicy({ failedAttemptThreshold: 1, onThresholdExceeded: 'trigger_alarm' });
    userRepo.create({ name: 'Owner', role: 'administrator', code: '123456' });
    const agent = await loginAs(app, '123456');

    const res = await agent.post('/api/v1/panel/disarm').send({ code: 'wrong' });

    expect(res.status).toBe(200);
    expect(res.body.mode).toBe('alarm_triggered');
  });

  it('rejects an expired guest code on disarm as 401', async () => {
    const { app, userRepo } = await buildHarness();
    const guest = userRepo.create({
      name: 'G',
      role: 'guest',
      code: 'guestcode',
      guestExpiresAt: Date.now() - 1_000,
    });
    const agent = request.agent(app);
    await agent.post('/test/session').send({ userId: guest.id, role: 'guest' }).expect(200);

    const res = await agent.post('/api/v1/panel/disarm').send({ code: 'guestcode' });

    expect(res.status).toBe(401);
  });

  it('allows a guest to disarm within their configured window', async () => {
    const { app, userRepo } = await buildHarness();
    userRepo.create({ name: 'G', role: 'guest', code: 'guestcode', guestExpiresAt: Date.now() + 100_000 });
    const agent = await loginAs(app, 'guestcode');
    await agent.post('/api/v1/panel/arm').send({ mode: 'armed_away' }).expect(403); // FR-001: arm is admin/member only

    const res = await agent.post('/api/v1/panel/disarm').send({ code: 'guestcode' });

    expect(res.status).toBe(200);
    expect(res.body.mode).toBe('disarmed');
  });
});
