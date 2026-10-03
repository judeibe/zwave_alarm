export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface Logger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

/**
 * Minimum level to emit, from the `LOG_LEVEL` env var (debug | info | warn | error; default info).
 * Read on every call rather than cached at import so tests can change it; an unrecognized value
 * falls back to the default rather than silencing logs.
 */
function minimumLevel(): LogLevel {
  const configured = process.env.LOG_LEVEL?.toLowerCase();
  return configured !== undefined && configured in LEVEL_ORDER ? (configured as LogLevel) : 'info';
}

function write(level: LogLevel, module: string, message: string, fields: Record<string, unknown>): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[minimumLevel()]) {
    return;
  }
  const entry = {
    timestamp: new Date().toISOString(),
    level,
    module,
    message,
    ...fields,
  };
  const line = JSON.stringify(entry);
  if (level === 'error') {
    console.error(line);
  } else {
    console.log(line);
  }
}

/**
 * Returns a structured JSON logger scoped to `module`. Every call emits a
 * single-line JSON object (timestamp, level, module, message, plus any extra
 * fields) via console.log/console.error — the same shape T009/T010 emitted
 * ad hoc before this module existed, now centralized so every module in the
 * codebase logs consistently. Entries below `LOG_LEVEL` (default `info`) are dropped.
 */
export function createLogger(module: string): Logger {
  return {
    debug: (message, fields = {}) => write('debug', module, message, fields),
    info: (message, fields = {}) => write('info', module, message, fields),
    warn: (message, fields = {}) => write('warn', module, message, fields),
    error: (message, fields = {}) => write('error', module, message, fields),
  };
}
