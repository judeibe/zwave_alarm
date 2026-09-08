import express, { type Express, type NextFunction, type Request, type Response } from 'express';

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

/**
 * Builds the Express app skeleton: JSON body parsing, a `/healthz` route,
 * and the catch-all error-handling middleware. Route registration for the
 * actual REST API surface (contracts/rest-api.md) happens in later phases;
 * this module does not call `.listen()` — process bootstrap is out of scope
 * here per T009/T010's precedent.
 */
export function createApp(): Express {
  const app = express();

  app.use(express.json());

  app.get('/healthz', (_req: Request, res: Response) => {
    res.status(200).json({ status: 'ok' });
  });

  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- Express only recognizes error middleware with all four parameters present.
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const { status, code, message } = toErrorResponse(err);
    res.status(status).json({ error: { code, message } });
  });

  return app;
}
