import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { WebSocket, WebSocketServer } from 'ws';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDatabase } from '../../src/db/schema.js';
import { AlarmPanelRepository } from '../../src/alarm/panel-repository.js';
import { PanelService } from '../../src/alarm/panel-service.js';
import { EventRepository } from '../../src/events/event-repository.js';
import { createWebSocketServer } from '../../src/api/ws.js';
import { ZoneRepository } from '../../src/db/repositories/zone-repository.js';
import { SensorRepository } from '../../src/db/repositories/sensor-repository.js';
import { UserRepository } from '../../src/auth/user-repository.js';

/** Every JSON line the code under test wrote to console.log/console.error, parsed. */
function loggedEntries(...spies: Array<ReturnType<typeof vi.spyOn>>): Array<Record<string, unknown>> {
  return spies.flatMap((spy) => spy.mock.calls.map((call) => JSON.parse(String(call[0])) as Record<string, unknown>));
}

describe('structured logging (T046)', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  describe('REST requests', () => {
    async function buildApp() {
      vi.stubEnv('SERIAL_PORT', '/dev/ttyACM0');
      vi.stubEnv('DB_PATH', ':memory:');
      vi.stubEnv('HTTP_PORT', '3000');
      vi.stubEnv('ZWAVE_SERVER_PORT', '3001');
      vi.stubEnv('SESSION_SECRET', 'test-secret');
      const { createApp } = await import('../../src/api/app.js');
      return createApp();
    }

    it('logs method, path, status and duration for every /api request, without the query string', async () => {
      const app = await buildApp();

      await request(app).get('/api/nope?code=123456');

      const entry = loggedEntries(logSpy, errorSpy).find((e) => e.module === 'api/request');
      expect(entry).toMatchObject({ level: 'warn', message: 'request', method: 'GET', path: '/api/nope', status: 404 });
      expect(typeof entry?.durationMs).toBe('number');
      expect(JSON.stringify(entry)).not.toContain('123456');
    });

    it('still logs a request rejected by the body parser', async () => {
      const app = await buildApp();

      await request(app).post('/api/v1/auth/login').set('Content-Type', 'application/json').send('{"code":');

      const entry = loggedEntries(logSpy, errorSpy).find((e) => e.module === 'api/request');
      expect(entry).toMatchObject({ method: 'POST', path: '/api/v1/auth/login', status: 400 });
    });
  });

  describe('alarm state transitions', () => {
    /** Real user/zone/sensor rows, since SecurityEvents carry foreign keys to all three. */
    function buildFixture() {
      const db = createDatabase(':memory:');
      const service = new PanelService(new AlarmPanelRepository(db), new EventRepository(db), {
        exitDelayMs: 100,
        entryDelayMs: 100,
      });
      const user = new UserRepository(db).create({ name: 'Owner', role: 'administrator', code: '123456' });
      const zone = new ZoneRepository(db).create('Kitchen');
      const sensors = new SensorRepository(db);
      const door = sensors.create({ zwaveNodeId: 2, zoneId: zone.id, name: 'Door', category: 'intrusion' });
      const smoke = sensors.create({ zwaveNodeId: 3, zoneId: zone.id, name: 'Smoke', category: 'life-safety' });
      return { service, user, zone, door, smoke };
    }

    it('logs old mode, new mode and the triggering cause for the full arm -> breach -> alarm -> disarm path', async () => {
      vi.useFakeTimers();
      const { service, user, door } = buildFixture();

      const arming = service.arm('armed_away', { source: 'native', sourceUserId: user.id });
      await vi.advanceTimersByTimeAsync(0);
      await arming;
      await vi.advanceTimersByTimeAsync(100);
      service.reportSensorBreach({ id: door.id, zoneId: door.zoneId, category: 'intrusion' });
      await vi.advanceTimersByTimeAsync(100);
      const disarming = service.disarm({ source: 'native', sourceUserId: user.id, clearedBy: 'Owner' });
      await vi.advanceTimersByTimeAsync(0);
      await disarming;
      service.stop();

      const transitions = loggedEntries(logSpy, errorSpy)
        .filter((e) => e.message === 'panel state transition')
        .map(({ from, to, cause }) => ({ from, to, cause }));
      expect(transitions).toEqual([
        { from: 'disarmed', to: 'arming', cause: 'arm_command' },
        { from: 'arming', to: 'armed_away', cause: 'exit_delay_elapsed' },
        { from: 'armed_away', to: 'alarm_pending', cause: 'intrusion_breach' },
        { from: 'alarm_pending', to: 'alarm_triggered', cause: 'sensor_alarm' },
        { from: 'alarm_triggered', to: 'disarmed', cause: 'alarm_cleared' },
      ]);
    });

    it('records who and what caused a transition', async () => {
      vi.useFakeTimers();
      const { service, user, smoke } = buildFixture();

      const arming = service.arm('armed_home', { source: 'home_assistant', sourceUserId: user.id });
      await vi.advanceTimersByTimeAsync(0);
      await arming;
      service.reportSensorBreach({ id: smoke.id, zoneId: smoke.zoneId, category: 'life-safety' });
      service.stop();

      const entries = loggedEntries(logSpy, errorSpy).filter((e) => e.message === 'panel state transition');
      expect(entries[0]).toMatchObject({ source: 'home_assistant', sourceUserId: user.id, targetMode: 'armed_home' });
      expect(entries[1]).toMatchObject({ from: 'arming', to: 'alarm_triggered', sensorId: smoke.id, zoneId: smoke.zoneId });
    });
  });

  describe('WebSocket connections', () => {
    let wss: WebSocketServer | undefined;

    afterEach(async () => {
      await new Promise<void>((resolve) => wss?.close(() => resolve()));
      wss = undefined;
    });

    it('logs connect and disconnect with the live client count', async () => {
      wss = createWebSocketServer({ port: 0 });
      await once(wss, 'listening');
      const client = new WebSocket(`ws://127.0.0.1:${(wss.address() as AddressInfo).port}`);
      await once(client, 'open');
      client.close();
      await once(client, 'close');
      // The server-side close handler runs on its own socket; give the event loop a turn.
      await vi.waitFor(() => {
        expect(loggedEntries(logSpy).some((e) => e.message === 'websocket client disconnected')).toBe(true);
      });

      const entries = loggedEntries(logSpy).filter((e) => e.module === 'api/ws');
      expect(entries.map((e) => e.message)).toEqual(['websocket client connected', 'websocket client disconnected']);
      expect(entries[0]).toMatchObject({ clients: 1 });
      expect(entries[1]).toMatchObject({ clients: 0 });
    });
  });
});
