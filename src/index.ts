import { createServer } from 'node:http';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { config } from './config/index.js';
import { createLogger } from './config/logger.js';
import { createDatabase } from './db/schema.js';
import { createApp } from './api/app.js';
import { createWebSocketServer } from './api/ws.js';
import { startZwaveJsServer } from './zwave/server.js';
import { getDriver } from './zwave/driver.js';
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

const panelService = new PanelService(panelRepo, eventRepo);
const lockoutService = new LockoutService(userRepo, lockoutPolicyRepo, eventRepo, panelService);

const driver = getDriver();
// `driver.controller` throws until the driver actually finishes starting
// (zwave-js's own "not yet ready" guard), so SensorMapper.start() — which
// reads controller.nodes immediately — has to wait for "driver ready"
// rather than running right away. Siren only touches controller.nodes
// lazily inside its panel_changed handler, so it's safe to construct now.
const sensorMapper = new SensorMapper(driver, sensorRepo, panelService, eventRepo);
driver.once('driver ready', () => sensorMapper.start());
new Siren(driver, panelService, { nodeId: config.sirenNodeId });

const app = createApp({ panelService, userRepo, zoneRepo, sensorRepo, lockoutService, eventRepo, driver });
const httpServer = createServer(app);

// Shares the REST API's HTTP server/port, per contracts/websocket-events.md's
// `wss://<host>/api/v1/stream` endpoint.
createWebSocketServer({ server: httpServer, path: '/api/v1/stream' });

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
