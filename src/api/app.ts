import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import type { Driver } from 'zwave-js';
import { sessionMiddleware } from '../auth/session.js';
import type { LockoutService } from '../auth/lockout-service.js';
import type { UserRepository } from '../auth/user-repository.js';
import type { ZoneRepository } from '../db/repositories/zone-repository.js';
import type { SensorRepository } from '../db/repositories/sensor-repository.js';
import type { PanelService } from '../alarm/panel-service.js';
import { createAuthRouter } from './routes/auth-routes.js';
import { createPanelRouter } from './routes/panel-routes.js';
import { createZoneRouter } from './routes/zone-routes.js';
import { createUserRouter } from './routes/user-routes.js';

/**
 * Thrown by route handlers to produce the `{ error: { code, message } }`
 * response shape from contracts/rest-api.md's "Error format" section with a
 * specific HTTP status. Later phases (auth middleware, alarm command routes,
 * etc.) throw this instead of shaping error responses themselves.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

interface ErrorResponseBody {
  status: number;
  code: string;
  message: string;
}

/**
 * Exported for direct unit testing: real route handlers that can throw are
 * only registered by later phases, always *before* this module's error
 * middleware in the stack (Express only routes an error to handlers
 * registered after the one that threw), so exercising the mapping logic
 * itself is more reliable than mounting a throwing route post hoc.
 */
export function toErrorResponse(err: unknown): ErrorResponseBody {
  if (err instanceof ApiError) {
    return { status: err.status, code: err.code, message: err.message };
  }

  // express.json()'s body-parser throws plain errors with a numeric
  // `status`/`statusCode` (e.g. malformed JSON -> 400) rather than ApiError.
  if (err instanceof Error && 'status' in err) {
    const status = (err as { status: unknown }).status;
    if (typeof status === 'number') {
      return { status, code: 'bad_request', message: err.message };
    }
  }

  return {
    status: 500,
    code: 'internal_error',
    message: err instanceof Error ? err.message : 'Internal server error',
  };
}

/** Wires the REST API surface (contracts/rest-api.md, T027) onto an app when supplied. */
export interface AppDeps {
  panelService: PanelService;
  userRepo: UserRepository;
  zoneRepo: ZoneRepository;
  sensorRepo: SensorRepository;
  lockoutService: LockoutService;
  /** Only `controller.nodes` is read (zone-routes.ts validates an assigned zwaveNodeId against it). */
  driver: Pick<Driver, 'controller'>;
}

/**
 * Builds the Express app: JSON body parsing, a `/healthz` route, and the
 * catch-all error-handling middleware — always present. When `deps` is
 * supplied, also mounts the session middleware (src/auth/session.ts) and the
 * full `/api/v1` REST surface (T027) wired to the given
 * services/repositories; `deps` is optional so this module stays testable in
 * isolation (as tests/unit/app.test.ts already does) without constructing a
 * real database/driver/services graph. This module still does not call
 * `.listen()` — process bootstrap (src/index.ts) owns that.
 */
export function createApp(deps?: AppDeps): Express {
  const app = express();

  app.use(express.json());

  app.get('/healthz', (_req: Request, res: Response) => {
    res.status(200).json({ status: 'ok' });
  });

  if (deps) {
    app.use(sessionMiddleware);
    const routeDeps = {
      panelService: deps.panelService,
      userRepo: deps.userRepo,
      zoneRepo: deps.zoneRepo,
      sensorRepo: deps.sensorRepo,
      lockoutService: deps.lockoutService,
      driver: deps.driver,
    };
    app.use('/api/v1', createAuthRouter(routeDeps));
    app.use('/api/v1', createPanelRouter(routeDeps));
    app.use('/api/v1', createZoneRouter(routeDeps));
    app.use('/api/v1', createUserRouter(routeDeps));
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- Express only recognizes error middleware with all four parameters present.
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const { status, code, message } = toErrorResponse(err);
    res.status(status).json({ error: { code, message } });
  });

  return app;
}
