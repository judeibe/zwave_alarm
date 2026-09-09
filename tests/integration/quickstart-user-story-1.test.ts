import request from 'supertest';
import type { Express } from 'express';
import type { Driver } from 'zwave-js';
import { SetValueStatus } from 'zwave-js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CommandClasses } from '@zwave-js/core';
import { createDatabase } from '../../src/db/schema.js';
import { AlarmPanelRepository } from '../../src/alarm/panel-repository.js';
import { PanelService } from '../../src/alarm/panel-service.js';
import { EventRepository, type SecurityEvent } from '../../src/events/event-repository.js';
import { ZoneRepository } from '../../src/db/repositories/zone-repository.js';
import { SensorRepository } from '../../src/db/repositories/sensor-repository.js';
import { UserRepository } from '../../src/auth/user-repository.js';
import { LockoutPolicyRepository } from '../../src/auth/lockout-policy-repository.js';
import { LockoutService } from '../../src/auth/lockout-service.js';
import { SensorMapper } from '../../src/zwave/sensor-mapper.js';
import { Siren } from '../../src/alarm/siren.js';

/**
 * End-to-end walkthrough of specs/001-zwave-alarm-ha-integration/quickstart.md
 * section 3 (User Story 1, no Home Assistant involved) plus section 6's
 * life-safety-gating and lockout scenarios, driven entirely through the real
 * Express app (supertest) and a mock zwave-js driver -- there is no Z-Wave
 * USB controller or Home Assistant instance available in this sandbox, so
 * this is the closest verifiable substitute for the manual quickstart
 * click-through: every service/repository from T017-T029 is real, only the
 * zwave-js `Driver` is mocked (same mocking precedent as
 * tests/unit/ws-broadcaster.test.ts and tests/unit/siren.test.ts).
 */

const ENV_KEYS = ['SERIAL_PORT', 'DB_PATH', 'HTTP_PORT', 'ZWAVE_SERVER_PORT', 'SESSION_SECRET'] as const;

function setEnv() {
  process.env.SERIAL_PORT = '/dev/ttyACM0';
  process.env.DB_PATH = ':memory:';
  process.env.HTTP_PORT = '3000';
  process.env.ZWAVE_SERVER_PORT = '3001';
  process.env.SESSION_SECRET = 'test-secret';
}

class MockNode {
  private readonly listeners: Record<string, (...args: never[]) => void> = {};
  setValue = vi.fn().mockResolvedValue({ status: SetValueStatus.Success });

  constructor(public readonly id: number) {}

  on(event: string, handler: (...args: never[]) => void): void {
    this.listeners[event] = handler;
  }

  emit(event: string, ...args: unknown[]): void {
    this.listeners[event]?.(...(args as never[]));
  }
}

class MockNodeMap {
  private readonly byId = new Map<number, MockNode>();
  add(node: MockNode): void {
    this.byId.set(node.id, node);
  }
  get(id: number): MockNode | undefined {
    return this.byId.get(id);
  }
  forEach(callback: (node: MockNode) => void): void {
    this.byId.forEach(callback);
  }
}

class MockController {
  nodes = new MockNodeMap();
  on(): void {
    // No nodes are paired after start() in these scenarios.
  }
}

class MockDriver {
  controller = new MockController();
}

function buildHarness() {
  const db = createDatabase(':memory:');
  const panelRepo = new AlarmPanelRepository(db);
  const eventRepo = new EventRepository(db);
  const zoneRepo = new ZoneRepository(db);
  const sensorRepo = new SensorRepository(db);
  const userRepo = new UserRepository(db);
  const lockoutPolicyRepo = new LockoutPolicyRepository(db);
  // Short but nonzero delays: long enough that 'arming'/'alarm_pending' are
  // observable before the timer fires, short enough that waitFor() below
  // settles quickly.
  const panelService = new PanelService(panelRepo, eventRepo, { exitDelayMs: 20, entryDelayMs: 20 });
  const lockoutService = new LockoutService(userRepo, lockoutPolicyRepo, eventRepo, panelService);

  const mockDriver = new MockDriver();
  // Nodes are paired to the Z-Wave network (present in the driver's node
  // map) before being assigned to a zone via the dashboard, same ordering a
  // real installation follows -- zone-routes.ts validates an assigned
  // zwaveNodeId against driver.controller.nodes.get().
  const doorNode = new MockNode(10);
  const smokeNode = new MockNode(20);
  const sirenNode = new MockNode(99);
  mockDriver.controller.nodes.add(doorNode);
  mockDriver.controller.nodes.add(smokeNode);
  mockDriver.controller.nodes.add(sirenNode);
  const driver = mockDriver as unknown as Driver;

  const sensorMapper = new SensorMapper(driver, sensorRepo, panelService, eventRepo);
  sensorMapper.start();
  new Siren(driver, panelService, { nodeId: 99 });

  return {
    eventRepo,
    zoneRepo,
    sensorRepo,
    userRepo,
    lockoutPolicyRepo,
    panelService,
    lockoutService,
    driver,
    doorNode,
    smokeNode,
    sirenNode,
  };
}

async function buildApp(harness: ReturnType<typeof buildHarness>): Promise<Express> {
  const { createApp } = await import('../../src/api/app.js');
  return createApp({
    panelService: harness.panelService,
    userRepo: harness.userRepo,
    zoneRepo: harness.zoneRepo,
    sensorRepo: harness.sensorRepo,
    lockoutService: harness.lockoutService,
    eventRepo: harness.eventRepo,
    driver: harness.driver,
  });
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('waitFor() timed out waiting for condition');
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe('quickstart.md section 3 -- standalone arm/disarm/monitor, Home Assistant NOT running', () => {
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

  it('walks the full flow: bootstrap, arm, breach, entry delay, trigger, siren, disarm, sensor fault', async () => {
    const harness = buildHarness();
    const app = await buildApp(harness);

    // Quickstart step 2 ("Bootstrap the first administrator and a zone"):
    // POST /api/v1/users is requireAuth + requireRole('administrator')
    // (src/api/routes/user-routes.ts), so -- as actually implemented --
    // there is no unauthenticated bootstrap path through the REST API for
    // the very first account, unlike the bare curl example in
    // quickstart.md step 2. Every route-level test in this repo works
    // around the same gap by seeding the first user directly via the
    // repository; done the same way here rather than silently masking it.
    // This is a real quickstart-vs-implementation mismatch worth flagging,
    // not a defect in any of T017-T030 (none of them specify a bootstrap
    // endpoint), so it doesn't block this verification.
    harness.userRepo.create({ name: 'Owner', role: 'administrator', code: '123456' });
    const agent = request.agent(app);
    await agent.post('/api/v1/auth/login').send({ code: '123456' }).expect(200);

    const zoneRes = await agent.post('/api/v1/zones').send({ name: 'Front Door' }).expect(201);
    const zoneId = zoneRes.body.id as string;

    // Step 3.1: assign a paired intrusion contact sensor to the zone.
    const sensorRes = await agent
      .post(`/api/v1/zones/${zoneId}/sensors`)
      .send({ zwaveNodeId: 10, name: 'Front door contact', category: 'intrusion' })
      .expect(201);
    const sensorId = sensorRes.body.id as string;

    // Step 3.2: arm away; GET /panel shows arming, then armed_away after the exit delay.
    const armRes = await agent.post('/api/v1/panel/arm').send({ mode: 'armed_away' }).expect(200);
    expect(armRes.body.mode).toBe('arming');
    await waitFor(() => harness.panelService.getState().mode === 'armed_away');
    expect((await agent.get('/api/v1/panel').expect(200)).body.mode).toBe('armed_away');

    // Step 3.3: open the door -> alarm_pending, then alarm_triggered after
    // the entry delay, and the configured siren activates (SC-001, SC-002).
    harness.doorNode.emit('notification', {}, CommandClasses.Notification, {
      type: 6,
      label: 'Access Control',
      event: 22,
      eventLabel: 'Door/window open',
    });
    await waitFor(() => harness.panelService.getState().mode === 'alarm_pending');
    const pendingPanel = (await agent.get('/api/v1/panel').expect(200)).body;
    expect(pendingPanel.triggeredBy).toEqual(expect.any(String));

    await waitFor(() => harness.panelService.getState().mode === 'alarm_triggered');
    expect((await agent.get('/api/v1/panel').expect(200)).body.mode).toBe('alarm_triggered');
    expect(harness.sirenNode.setValue).toHaveBeenCalledWith(
      { commandClass: CommandClasses['Binary Switch'], property: 'targetValue' },
      true,
    );

    // The breach SecurityEvent the panel's triggeredBy points at is
    // attributed to the exact sensor/zone that opened.
    const eventsAfterTrigger = (await agent.get('/api/v1/events').expect(200)).body as SecurityEvent[];
    const breachEvent = eventsAfterTrigger.find((e) => e.type === 'breach');
    expect(breachEvent).toMatchObject({ relatedSensorId: sensorId, relatedZoneId: zoneId });

    // Step 3.4: disarm with the administrator's code -> disarmed, siren silences.
    const disarmRes = await agent.post('/api/v1/panel/disarm').send({ code: '123456' }).expect(200);
    expect(disarmRes.body.mode).toBe('disarmed');
    expect(harness.sirenNode.setValue).toHaveBeenLastCalledWith(
      { commandClass: CommandClasses['Binary Switch'], property: 'targetValue' },
      false,
    );

    // Step 3.5: a disconnected sensor reports as a device_fault, distinct from a breach (FR-012).
    harness.doorNode.emit('dead', harness.doorNode, 'Awake');
    await waitFor(
      () => harness.sensorRepo.list().find((s) => s.id === sensorId)?.connectivityStatus === 'offline',
    );
    const eventsAfterFault = (await agent.get('/api/v1/events').expect(200)).body as SecurityEvent[];
    const faultEvent = eventsAfterFault.find((e) => e.type === 'device_fault' && e.relatedSensorId === sensorId);
    expect(faultEvent).toBeDefined();
    expect(faultEvent!.type).not.toBe('breach');
  });

  it('quickstart section 6: a life-safety sensor triggers alarm_triggered immediately while disarmed, no entry delay', async () => {
    const harness = buildHarness();
    const app = await buildApp(harness);
    harness.userRepo.create({ name: 'Owner', role: 'administrator', code: '123456' });
    const agent = request.agent(app);
    await agent.post('/api/v1/auth/login').send({ code: '123456' }).expect(200);

    const zoneRes = await agent.post('/api/v1/zones').send({ name: 'Hallway' }).expect(201);
    await agent
      .post(`/api/v1/zones/${zoneRes.body.id}/sensors`)
      .send({ zwaveNodeId: 20, name: 'Smoke detector', category: 'life-safety' })
      .expect(201);
    expect((await agent.get('/api/v1/panel').expect(200)).body.mode).toBe('disarmed');

    harness.smokeNode.emit('notification', {}, CommandClasses.Notification, {
      type: 1,
      label: 'Smoke Alarm',
      event: 1,
      eventLabel: 'Smoke detected',
    });

    // FR-015: no entry delay for a life-safety trigger -- the mapper's call
    // into PanelService.triggerAlarm() is synchronous, so no waitFor() is needed.
    expect(harness.panelService.getState().mode).toBe('alarm_triggered');
    expect((await agent.get('/api/v1/panel').expect(200)).body.mode).toBe('alarm_triggered');
  });

  it('quickstart section 6: repeated wrong disarm codes lock the account, then trigger_alarm mode raises the alarm instead', async () => {
    const harness = buildHarness();
    const app = await buildApp(harness);
    harness.lockoutPolicyRepo.updatePolicy({ failedAttemptThreshold: 2 });
    const owner = harness.userRepo.create({ name: 'Owner', role: 'administrator', code: '123456' });
    const agent = request.agent(app);
    await agent.post('/api/v1/auth/login').send({ code: '123456' }).expect(200);

    await agent.post('/api/v1/panel/disarm').send({ code: 'wrong' }).expect(401);
    const lockRes = await agent.post('/api/v1/panel/disarm').send({ code: 'wrong' });
    expect(lockRes.status).toBe(423);
    expect(harness.userRepo.findById(owner.id)?.lockedUntil).not.toBeNull();

    const eventsAfterLock = (await agent.get('/api/v1/events').expect(200)).body as SecurityEvent[];
    expect(eventsAfterLock.some((e) => e.type === 'lockout')).toBe(true);

    // Flip to trigger_alarm mode: repeated failures raise the alarm instead of locking.
    harness.userRepo.resetFailedAttempts(owner.id);
    harness.lockoutPolicyRepo.updatePolicy({ onThresholdExceeded: 'trigger_alarm', failedAttemptThreshold: 1 });

    const triggerRes = await agent.post('/api/v1/panel/disarm').send({ code: 'wrong' });
    expect(triggerRes.status).toBe(200);
    expect(triggerRes.body.mode).toBe('alarm_triggered');
  });
});
