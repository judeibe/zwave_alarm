import { createServer } from 'node:http';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { config } from './config/index.js';
import { createLogger } from './config/logger.js';
import { createDatabase } from './db/schema.js';
import { createApp } from './api/app.js';
import { createWebSocketServer } from './api/ws.js';
import { startZwaveJsServer } from './zwave/server.js';

const logger = createLogger('index');

// better-sqlite3 requires the parent directory to already exist.
mkdirSync(dirname(config.dbPath), { recursive: true });
createDatabase(config.dbPath);

const app = createApp();
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
