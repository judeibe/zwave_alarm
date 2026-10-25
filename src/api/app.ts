import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import type { Driver } from 'zwave-js';
import { sessionMiddleware } from '../auth/session.js';
import { verifySameOrigin } from '../auth/csrf.js';
import type { LockoutService } from '../auth/lockout-service.js';
import type { UserRepository } from '../auth/user-repository.js';
import type { ZoneRepository } from '../db/repositories/zone-repository.js';
import type { SensorRepository } from '../db/repositories/sensor-repository.js';
import type { PanelService } from '../alarm/panel-service.js';
import type { AlarmEventService } from '../alarm/alarm-event-service.js';
import type { SirenRepository } from '../alarm/siren-repository.js';
import type { GuestScheduleRepository } from '../auth/guest-schedule.js';
import { createSirenRouter } from './routes/siren-routes.js';
import type { EventRepository } from '../events/event-repository.js';
import type { HaLinkRepository } from '../db/repositories/ha-link-repository.js';
import type { DriverState } from '../zwave/driver.js';
import { configureHaLinkAuth } from '../auth/token.js';
import { configureAuthRequired } from '../auth/authorize.js';
import { config } from '../config/index.js';
import { requestLogger } from './request-logger.js';
import { createAuthRouter } from './routes/auth-routes.js';
import { createPanelRouter } from './routes/panel-routes.js';
import { createZoneRouter } from './routes/zone-routes.js';
import { createUserRouter } from './routes/user-routes.js';
import { createEventRouter } from './routes/event-routes.js';
import { createHaLinkRouter } from './routes/ha-link-routes.js';
import { createLockoutPolicyRouter } from './routes/lockout-policy-routes.js';
import { createKeypadRouter } from './routes/keypad-routes.js';
import type { KeypadService } from '../keypads/keypad-service.js';
import type { KeypadSettingsService } from '../keypads/keypad-settings.js';
import { createLockRouter } from './routes/lock-routes.js';
import type { LockService } from '../locks/lock-service.js';

/**
 * Thrown by route handlers to produce the `{ error: { code, message } }`
 * response shape from contracts/rest-api.md's "Error format" section with a
 * specific HTTP status. Later phases (auth middleware, alarm command routes,
 * etc.) throw this instead of shaping error responses themselves.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  /** Extra fields merged into the response's `error` object (e.g. `faulted` on a 409 `needs_bypass`). */
  readonly details: Record<string, unknown>;

  constructor(status: number, code: string, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

// Resolves to dist/web at runtime (built) or src/web (tests import this
// module directly, unbundled) — both sit one directory up from this file's
// own compiled/source location, so the same relative path works either way.
// `npm run build`'s "copy-web-assets" step is what puts index.html/app.js/
// styles.css into dist/web in the first place; tsc alone only compiles .ts.
const WEB_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'web');

interface ErrorResponseBody {
  status: number;
  code: string;
  message: string;
  details: Record<string, unknown>;
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
    return { status: err.status, code: err.code, message: err.message, details: err.details };
  }

  // express.json()'s body-parser throws plain errors with a numeric
  // `status`/`statusCode` (e.g. malformed JSON -> 400) rather than ApiError.
  if (err instanceof Error && 'status' in err) {
    const status = (err as { status: unknown }).status;
    if (typeof status === 'number') {
      return { status, code: 'bad_request', message: err.message, details: {} };
    }
  }

  return {
    status: 500,
    code: 'internal_error',
    message: err instanceof Error ? err.message : 'Internal server error',
    details: {},
  };
}

/** Wires the REST API surface (contracts/rest-api.md, T027) onto an app when supplied. */
export interface AppDeps {
  panelService: PanelService;
  userRepo: UserRepository;
  zoneRepo: ZoneRepository;
  sensorRepo: SensorRepository;
  lockoutService: LockoutService;
  eventRepo: EventRepository;
  /** Serves `GET /api/v1/alarm-events`. */
  alarmEvents?: AlarmEventService;
  /** Optional: the siren routes (`/sirens`) are mounted only when supplied. */
  sirenRepo?: SirenRepository;
  /** Optional: `/users/{id}/schedules` is mounted only when supplied. */
  guestSchedules?: GuestScheduleRepository;
  haLinkRepo: HaLinkRepository;
  /** Optional: the keypad routes (`/keypads`) are mounted only when supplied. */
  keypadService?: KeypadService;
  /** Optional: `/keypad-settings` is mounted only when this and `keypadService` are supplied. */
  keypadSettings?: KeypadSettingsService;
  /** Optional: the Schlage lock routes (`/locks`) are mounted only when supplied. */
  lockService?: LockService;
  /** Only `controller.nodes` is read (zone-routes.ts validates an assigned zwaveNodeId against it). */
  driver: Pick<Driver, 'controller'>;
  /** Reports the driver's start-up state on `GET /api/v1/panel`; src/index.ts passes `getDriverState`. */
  driverState?: () => DriverState;
}

/**
 * Builds the Express app: JSON body parsing, `/healthz` (and `/readyz` once a driver state is supplied) routes, and the
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

  // Scoped to /api so the dashboard's static assets don't flood the log; mounted before the body
  // parser so a request rejected for malformed JSON is still recorded.
  app.use('/api', requestLogger);
  app.use(express.json());

  app.get('/healthz', (_req: Request, res: Response) => {
    res.status(200).json({ status: 'ok' });
  });

  // Readiness, unlike liveness above: 503 until the Z-Wave driver is ready, and again while it is
  // restarting. For load balancers and monitors; the Docker health check stays on /healthz so a
  // missing stick doesn't put the container in a restart loop.
  const driverState = deps?.driverState;
  if (driverState) {
    app.get('/readyz', (_req: Request, res: Response) => {
      const driver = driverState();
      const ready = driver.status === 'ready';
      res.status(ready ? 200 : 503).json({ status: ready ? 'ready' : 'unavailable', driver });
    });
  }

  // The minimal bundled dashboard (T030): index.html/app.js/styles.css,
  // served as plain static files ahead of the /api/v1 mount below so they
  // never compete with a route path. Unconditional (not gated on `deps`)
  // since it has no dependency on the services graph — it talks to the API
  // over fetch()/WebSocket at runtime, same as a Home Assistant client would.
  app.use(express.static(WEB_DIR));

  if (deps) {
    // Wires T031's HaLinkRepository into requireHaToken (src/auth/token.ts),
    // replacing Phase 01's always-reject stub, so both this mount's
    // requireAuth calls and ha-link-routes.ts's own resolve real tokens.
    configureHaLinkAuth(deps.haLinkRepo);
    configureAuthRequired(config.apiAuthRequired);

    app.use(sessionMiddleware);
    app.use('/api', verifySameOrigin);
    const routeDeps = {
      panelService: deps.panelService,
      userRepo: deps.userRepo,
      zoneRepo: deps.zoneRepo,
      sensorRepo: deps.sensorRepo,
      lockoutService: deps.lockoutService,
      eventRepo: deps.eventRepo,
      alarmEvents: deps.alarmEvents,
      guestSchedules: deps.guestSchedules,
      haLinkRepo: deps.haLinkRepo,
      driver: deps.driver,
      driverState: deps.driverState,
    };
    app.use('/api/v1', createAuthRouter(routeDeps));
    app.use('/api/v1', createPanelRouter(routeDeps));
    app.use('/api/v1', createZoneRouter(routeDeps));
    app.use('/api/v1', createUserRouter(routeDeps));
    app.use('/api/v1', createEventRouter(routeDeps));
    app.use('/api/v1', createHaLinkRouter(routeDeps));
    app.use('/api/v1', createLockoutPolicyRouter(routeDeps));
    if (deps.keypadService) {
      app.use('/api/v1', createKeypadRouter({ keypadService: deps.keypadService, keypadSettings: deps.keypadSettings }));
    }
    if (deps.lockService) {
      app.use('/api/v1', createLockRouter({ lockService: deps.lockService }));
    }
    if (deps.sirenRepo) {
      app.use('/api/v1', createSirenRouter({ sirenRepo: deps.sirenRepo, driver: deps.driver }));
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- Express only recognizes error middleware with all four parameters present.
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const { status, code, message, details } = toErrorResponse(err);
    res.status(status).json({ error: { code, message, ...details } });
  });

  return app;
}
