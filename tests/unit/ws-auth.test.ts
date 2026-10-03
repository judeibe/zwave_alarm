import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import type { Driver } from 'zwave-js';
import { WebSocket, type WebSocketServer } from 'ws';
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

/** What a client sees from the upgrade: the first message, or the HTTP status that refused it. */
type Outcome = { opened: true; firstMessage: Record<string, unknown> } | { opened: false; status: number };

describe('websocket connect-time authentication', () => {
  const originalEnv = { ...process.env };
  let httpServer: Server | undefined;
  let wss: WebSocketServer | undefined;

  beforeEach(() => {
    setEnv();
  });

  afterEach(async () => {
    for (const key of ENV_KEYS) {
      delete process.env[key];
    }
    process.env = { ...originalEnv };
    wss?.close();
    await new Promise<void>((resolve) => (httpServer ? httpServer.close(() => resolve()) : resolve()));
    httpServer = undefined;
    wss = undefined;
  });

  async function buildHarness() {
    const db = createDatabase(':memory:');
    const panelService = new PanelService(new AlarmPanelRepository(db), new EventRepository(db));
    const userRepo = new UserRepository(db);
    const zoneRepo = new ZoneRepository(db);
    const lockoutService = new LockoutService(
      userRepo,
      new LockoutPolicyRepository(db),
      new EventRepository(db),
      panelService,
    );

    // Dynamic imports: src/config/index.ts validates required env vars at import time.
    const { createApp } = await import('../../src/api/app.js');
    const { createWebSocketServer } = await import('../../src/api/ws.js');
    const { createWsVerifyClient } = await import('../../src/api/ws-auth.js');
    const { sessionMiddleware } = await import('../../src/auth/session.js');
    const { HaLinkRepository } = await import('../../src/db/repositories/ha-link-repository.js');
    const haLinkRepo = new HaLinkRepository(db);

    const app = createApp({
      panelService,
      userRepo,
      zoneRepo,
      sensorRepo: new SensorRepository(db),
      lockoutService,
      eventRepo: new EventRepository(db),
      haLinkRepo,
      driver: { controller: { nodes: new Map() } } as unknown as Driver,
    });
    httpServer = createServer(app);
    wss = createWebSocketServer(
      {
        server: httpServer,
        path: '/api/v1/stream',
        verifyClient: createWsVerifyClient({ haLinkLookup: haLinkRepo, sessionMiddleware }),
      },
      () => ({ type: 'snapshot', panel: { mode: 'disarmed', pendingDelayEndsAt: null }, zones: [] }),
    );
    httpServer.listen(0);
    await once(httpServer, 'listening');
    const port = (httpServer.address() as AddressInfo).port;

    /** Logs in over HTTP and returns the resulting `Cookie` header value. */
    async function login(code: string): Promise<string> {
      const res = await request(app).post('/api/v1/auth/login').send({ code }).expect(200);
      return (res.headers['set-cookie'] as unknown as string[]).map((c) => c.split(';')[0]).join('; ');
    }

    function connect(headers: Record<string, string> = {}): Promise<Outcome> {
      return new Promise((resolve) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/api/v1/stream`, { headers });
        ws.on('message', (data) => {
          resolve({ opened: true, firstMessage: JSON.parse(data.toString()) as Record<string, unknown> });
          ws.close();
        });
        ws.on('unexpected-response', (_req, res) => {
          resolve({ opened: false, status: res.statusCode ?? 0 });
          ws.terminate();
        });
        ws.on('error', () => {
          /* surfaced through unexpected-response above */
        });
      });
    }

    return { userRepo, haLinkRepo, login, connect };
  }

  it('refuses an unauthenticated client with 401 and sends no snapshot', async () => {
    const { connect } = await buildHarness();

    expect(await connect()).toEqual({ opened: false, status: 401 });
  });

  it('accepts a native-dashboard session cookie for an administrator', async () => {
    const { userRepo, login, connect } = await buildHarness();
    userRepo.create({ name: 'Owner', role: 'administrator', code: 'admin1' });

    const outcome = await connect({ Cookie: await login('admin1') });

    expect(outcome).toMatchObject({ opened: true, firstMessage: { type: 'snapshot' } });
  });

  it('accepts a member session', async () => {
    const { userRepo, login, connect } = await buildHarness();
    userRepo.create({ name: 'Mem', role: 'member', code: 'member1' });

    expect(await connect({ Cookie: await login('member1') })).toMatchObject({ opened: true });
  });

  it('refuses a guest session, matching who may read GET /panel', async () => {
    const { userRepo, login, connect } = await buildHarness();
    userRepo.create({ name: 'Guest', role: 'guest', code: 'guest1', guestExpiresAt: Date.now() + 60_000 });

    expect(await connect({ Cookie: await login('guest1') })).toEqual({ opened: false, status: 401 });
  });

  it('refuses a forged or unknown session cookie', async () => {
    const { connect } = await buildHarness();

    expect(await connect({ Cookie: 'zwave_alarm.sid=s%3Aforged.signature' })).toEqual({ opened: false, status: 401 });
  });

  it('accepts a valid Home Assistant bearer token', async () => {
    const { userRepo, haLinkRepo, connect } = await buildHarness();
    const admin = userRepo.create({ name: 'Owner', role: 'administrator', code: 'admin1' });
    const { token } = haLinkRepo.create('dev-ha', admin.id);

    const outcome = await connect({ Authorization: `Bearer ${token}` });

    expect(outcome).toMatchObject({ opened: true, firstMessage: { type: 'snapshot' } });
  });

  it('refuses an unknown or malformed bearer token', async () => {
    const { connect } = await buildHarness();

    expect(await connect({ Authorization: 'Bearer not-a-real-token' })).toEqual({ opened: false, status: 401 });
    expect(await connect({ Authorization: 'Basic abc' })).toEqual({ opened: false, status: 401 });
    expect(await connect({ Authorization: 'Bearer ' })).toEqual({ opened: false, status: 401 });
  });

  it('refuses a revoked bearer token', async () => {
    const { userRepo, haLinkRepo, connect } = await buildHarness();
    const admin = userRepo.create({ name: 'Owner', role: 'administrator', code: 'admin1' });
    const { link, token } = haLinkRepo.create('dev-ha', admin.id);
    haLinkRepo.revoke(link.id);

    expect(await connect({ Authorization: `Bearer ${token}` })).toEqual({ opened: false, status: 401 });
  });
});
