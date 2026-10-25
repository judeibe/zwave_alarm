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
import { getDriver, getDriverState, onDriverStateChange, stopDriver } from './zwave/driver.js';
import { createShutdown } from './shutdown.js';
import { AlarmPanelRepository } from './alarm/panel-repository.js';
import { PanelService } from './alarm/panel-service.js';
import { AlarmEventRepository } from './alarm/alarm-event-repository.js';
import { AlarmEventService } from './alarm/alarm-event-service.js';
import { Siren } from './alarm/siren.js';
import { EventRepository } from './events/event-repository.js';
import { ModeConfigRepository } from './db/repositories/mode-config-repository.js';
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
import { KeypadSettingsRepository, KeypadSettingsService } from './keypads/keypad-settings.js';
import { KeypadController } from './keypads/keypad-controller.js';
import { KeypadGateway } from './zwave/keypad-gateway.js';
import { LockService } from './locks/lock-service.js';
import { LockEnrollmentRepository } from './db/repositories/lock-enrollment-repository.js';
import { ZwaveLockGateway } from './zwave/lock-gateway.js';

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

const modeConfigRepo = new ModeConfigRepository(db);
// The env vars only seed the first run; afterwards the delays live in the database (GET/PATCH /api/v1/modes).
modeConfigRepo.ensureSeeded({ exitDelaySec: config.exitDelaySeconds, entryDelaySec: config.entryDelaySeconds });
const alarmEvents = new AlarmEventService(new AlarmEventRepository(db));
const panelService = new PanelService(panelRepo, eventRepo, { modeConfig: modeConfigRepo, sensorRepo, alarmEvents });
const lockoutService = new LockoutService(userRepo, lockoutPolicyRepo, eventRepo, panelService);

const driver = getDriver();
// `driver.controller` throws until the driver actually finishes starting
// (zwave-js's own "not yet ready" guard), so SensorMapper.start() — which
// reads controller.nodes immediately — has to wait for "driver ready"
// rather than running right away. Siren only touches controller.nodes
// lazily inside its panel_changed handler, so it's safe to construct now.
const sensorMapper = new SensorMapper(driver, sensorRepo, panelService, eventRepo);
// `on`, not `once`: a driver restarted after a failure has new controller/node objects, so the
// mapper and keypad gateway re-attach on every "driver ready" (the driver facade carries this
// listener over to each replacement instance).
let keypadAdapters: Promise<void> | undefined;
driver.on('driver ready', () => {
  sensorMapper.start();
  // A siren state that had to wait for the driver (e.g. alarm_triggered restored after a restart).
  siren.sync();
  // Keypads: load the adapters first (once) so a node's identity can be matched as soon as it's attached.
  keypadAdapters ??= discoverKeypadAdapters(KEYPAD_ADAPTERS_DIR, keypadRegistry);
  keypadAdapters
    .then(() => keypadGateway.start())
    .catch((err: unknown) => {
      logger.error('keypad support failed to start', { error: err instanceof Error ? err.message : String(err) });
    });
  lockGateway.start();
});
const siren = new Siren(driver, panelService, { nodeId: config.sirenNodeId, alarmEvents });

// Keypads (src/keypads): adapters are auto-discovered from this directory, so supporting a new
// keypad means adding a file there, not editing this one.
const KEYPAD_ADAPTERS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'keypads', 'adapters');
const keypadRegistry = new KeypadAdapterRegistry();
const keypadService = new KeypadService((nodeId, writes) => keypadGateway.writeValues(nodeId, writes));
const keypadGateway: KeypadGateway = new KeypadGateway(driver, keypadRegistry, keypadService);
// Schlage locks (src/locks): recognised by manufacturer/product id, so there is nothing to configure.
const lockService = new LockService({
  readParameter: (...args) => lockGateway.readParameter(...args),
  writeParameter: (...args) => lockGateway.writeParameter(...args),
  setUserCode: (...args) => lockGateway.setUserCode(...args),
  clearUserCode: (...args) => lockGateway.clearUserCode(...args),
  getUserSlot: (...args) => lockGateway.getUserSlot(...args),
  getScheduleSlotCounts: (...args) => lockGateway.getScheduleSlotCounts(...args),
  setScheduleEnabled: (...args) => lockGateway.setScheduleEnabled(...args),
  setSchedule: (...args) => lockGateway.setSchedule(...args),
  getSchedule: (...args) => lockGateway.getSchedule(...args),
  setLocked: (...args) => lockGateway.setLocked(...args),
  getLocked: (...args) => lockGateway.getLocked(...args),
}, new LockEnrollmentRepository(db));
const lockGateway: ZwaveLockGateway = new ZwaveLockGateway(driver, lockService);
// KEYPAD_REQUIRE_CODE_TO_ARM is only the default; an administrator's choice (PATCH /keypad-settings) wins.
const keypadSettings = new KeypadSettingsService(new KeypadSettingsRepository(db), {
  requireCodeToArm: config.keypadRequireCodeToArm,
});
new KeypadController(keypadService, panelService, userRepo, lockoutService, eventRepo, zoneRepo, {
  requireCodeToArm: () => keypadSettings.get().requireCodeToArm,
}).start();

const app = createApp({ panelService, userRepo, zoneRepo, sensorRepo, lockoutService, eventRepo, alarmEvents, haLinkRepo, driver, keypadService, keypadSettings, lockService, driverState: getDriverState });
const httpServer = createServer(app);

// Shares the REST API's HTTP server/port, per contracts/websocket-events.md's
// `wss://<host>/api/v1/stream` endpoint.
// Authenticated at connect time, same as the REST API (session cookie or HA bearer token).
const driverStatus = { get: getDriverState, subscribe: onDriverStateChange };
const wss = createWebSocketServer(
  {
    server: httpServer,
    path: '/api/v1/stream',
    verifyClient: createWsVerifyClient({ haLinkLookup: haLinkRepo, sessionMiddleware }),
  },
  () => buildLiveSnapshot({ panelService, zoneRepo, keypadService, keypadSettings, lockService, driverStatus, alarmEvents }),
);
attachWsBroadcaster(wss, { panelService, sensorMapper, eventRepo, zoneRepo, keypadService, keypadSettings, lockService, driverStatus, alarmEvents });

// After the siren and broadcaster are listening: re-schedules an exit/entry delay that was in
// flight when the service last stopped (SC-006), which may itself commit a transition.
alarmEvents.resume();
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
