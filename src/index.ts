import { createServer } from 'node:http';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config/index.js';
import { createLogger } from './config/logger.js';
import { createDatabase } from './db/schema.js';
import { createApp } from './api/app.js';
import { createWebSocketServer } from './api/ws.js';
import { createWsVerifyClient } from './api/ws-auth.js';
import { sessionMiddleware } from './auth/session.js';
import { attachWsBroadcaster, buildLiveSnapshot } from './api/ws-broadcaster.js';
import { startZwaveJsServer, stopZwaveJsServer } from './zwave/server.js';
import { getDriver, stopDriver } from './zwave/driver.js';
import { createShutdown } from './shutdown.js';
import { AlarmPanelRepository } from './alarm/panel-repository.js';
import { PanelService } from './alarm/panel-service.js';
import { Siren } from './alarm/siren.js';
import { EventRepository } from './events/event-repository.js';
import { ZoneRepository } from './db/repositories/zone-repository.js';
import { SensorRepository } from './db/repositories/sensor-repository.js';
import { SensorMapper } from './zwave/sensor-mapper.js';
import { UserRepository } from './auth/user-repository.js';
import { LockoutPolicyRepository } from './auth/lockout-policy-repository.js';
import { LockoutService } from './auth/lockout-service.js';
import { HaLinkRepository } from './db/repositories/ha-link-repository.js';
import { KeypadAdapterRegistry } from './keypads/keypad-registry.js';
import { discoverKeypadAdapters } from './keypads/discovery.js';
import { KeypadService } from './keypads/keypad-service.js';
import { KeypadController } from './keypads/keypad-controller.js';
import { KeypadGateway } from './zwave/keypad-gateway.js';

const logger = createLogger('index');

// better-sqlite3 requires the parent directory to already exist.
mkdirSync(dirname(config.dbPath), { recursive: true });
const db = createDatabase(config.dbPath);

const eventRepo = new EventRepository(db);
const panelRepo = new AlarmPanelRepository(db);
const zoneRepo = new ZoneRepository(db);
const sensorRepo = new SensorRepository(db);
const userRepo = new UserRepository(db);
const lockoutPolicyRepo = new LockoutPolicyRepository(db);
const haLinkRepo = new HaLinkRepository(db);

const panelService = new PanelService(panelRepo, eventRepo, {
  exitDelayMs: config.exitDelaySeconds * 1000,
  entryDelayMs: config.entryDelaySeconds * 1000,
});
const lockoutService = new LockoutService(userRepo, lockoutPolicyRepo, eventRepo, panelService);

const driver = getDriver();
// `driver.controller` throws until the driver actually finishes starting
// (zwave-js's own "not yet ready" guard), so SensorMapper.start() — which
// reads controller.nodes immediately — has to wait for "driver ready"
// rather than running right away. Siren only touches controller.nodes
// lazily inside its panel_changed handler, so it's safe to construct now.
const sensorMapper = new SensorMapper(driver, sensorRepo, panelService, eventRepo);
driver.once('driver ready', () => {
  sensorMapper.start();
  // A siren state that had to wait for the driver (e.g. alarm_triggered restored after a restart).
  siren.sync();
  // Keypads: load the adapters first so a node's identity can be matched as soon as it's attached.
  discoverKeypadAdapters(KEYPAD_ADAPTERS_DIR, keypadRegistry)
    .then(() => keypadGateway.start())
    .catch((err: unknown) => {
      logger.error('keypad support failed to start', { error: err instanceof Error ? err.message : String(err) });
    });
});
const siren = new Siren(driver, panelService, { nodeId: config.sirenNodeId });

// Keypads (src/keypads): adapters are auto-discovered from this directory, so supporting a new
// keypad means adding a file there, not editing this one.
const KEYPAD_ADAPTERS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'keypads', 'adapters');
const keypadRegistry = new KeypadAdapterRegistry();
const keypadService = new KeypadService((nodeId, writes) => keypadGateway.writeValues(nodeId, writes));
const keypadGateway: KeypadGateway = new KeypadGateway(driver, keypadRegistry, keypadService);
new KeypadController(keypadService, panelService, userRepo, lockoutService, eventRepo, zoneRepo, {
  requireCodeToArm: config.keypadRequireCodeToArm,
}).start();

const app = createApp({ panelService, userRepo, zoneRepo, sensorRepo, lockoutService, eventRepo, haLinkRepo, driver, keypadService });
const httpServer = createServer(app);

// Shares the REST API's HTTP server/port, per contracts/websocket-events.md's
// `wss://<host>/api/v1/stream` endpoint.
// Authenticated at connect time, same as the REST API (session cookie or HA bearer token).
const wss = createWebSocketServer(
  {
    server: httpServer,
    path: '/api/v1/stream',
    verifyClient: createWsVerifyClient({ haLinkLookup: haLinkRepo, sessionMiddleware }),
  },
  () => buildLiveSnapshot({ panelService, zoneRepo, keypadService }),
);
attachWsBroadcaster(wss, { panelService, sensorMapper, eventRepo, zoneRepo, keypadService });

// After the siren and broadcaster are listening: re-schedules an exit/entry delay that was in
// flight when the service last stopped (SC-006), which may itself commit a transition.
panelService.resume();

httpServer.listen(config.httpPort, () => {
  logger.info('HTTP/WebSocket server listening', {
    port: config.httpPort,
    wsPath: '/api/v1/stream',
  });
});

// The zwave-js driver/server own the serial port and can legitimately fail to
// start (missing/unavailable controller). That must not take down the
// REST/WebSocket surface, which has no dependency on it being up — log and
// keep running rather than crashing the whole process.
startZwaveJsServer().catch((err: unknown) => {
  logger.error('zwave-js-server failed to start', {
    error: err instanceof Error ? err.message : String(err),
  });
});

// On `docker stop`/Ctrl-C, release everything in order and exit promptly. Without a handler Node as
// PID 1 ignores SIGTERM and Docker kills it after 10 s. The panel's state is already persisted, so
// an exit/entry delay in flight is picked up again by `panelService.resume()` on the next start.
const shutdown = createShutdown([
  { name: 'stop delay timers', run: () => panelService.stop() },
  {
    name: 'close websocket clients',
    run: () => {
      for (const client of wss.clients) {
        client.terminate();
      }
      return new Promise<void>((resolve) => wss.close(() => resolve()));
    },
  },
  {
    name: 'close http server',
    run: () =>
      new Promise<void>((resolve, reject) => {
        httpServer.close((err) => (err ? reject(err) : resolve()));
        httpServer.closeAllConnections(); // don't wait on keep-alive connections
      }),
  },
  { name: 'stop zwave-js-server', run: stopZwaveJsServer },
  { name: 'stop zwave-js driver', run: stopDriver },
  { name: 'close database', run: () => db.close() },
]);
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => void shutdown(signal));
}
