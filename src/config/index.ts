export interface AppConfig {
  serialPort: string;
  dbPath: string;
  httpPort: number;
  zwaveServerPort: number;
  sessionSecret: string;
}

export class ConfigError extends Error {}

const REQUIRED_VARS = [
  'SERIAL_PORT',
  'DB_PATH',
  'HTTP_PORT',
  'ZWAVE_SERVER_PORT',
  'SESSION_SECRET',
] as const;

function readEnv(name: (typeof REQUIRED_VARS)[number]): string | undefined {
  const value = process.env[name];
  return value === undefined || value === '' ? undefined : value;
}

function parsePort(name: string, value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new ConfigError(`${name} must be an integer between 1 and 65535, got "${value}"`);
  }
  return port;
}

function loadConfig(): AppConfig {
  const missing = REQUIRED_VARS.filter((name) => readEnv(name) === undefined);
  if (missing.length > 0) {
    throw new ConfigError(
      `Missing required environment variable(s): ${missing.join(', ')}. Copy .env.example to .env and set them.`,
    );
  }

  const httpPort = parsePort('HTTP_PORT', readEnv('HTTP_PORT')!);
  const zwaveServerPort = parsePort('ZWAVE_SERVER_PORT', readEnv('ZWAVE_SERVER_PORT')!);
  if (httpPort === zwaveServerPort) {
    throw new ConfigError(
      `HTTP_PORT and ZWAVE_SERVER_PORT must be different (both set to ${httpPort})`,
    );
  }

  return {
    serialPort: readEnv('SERIAL_PORT')!,
    dbPath: readEnv('DB_PATH')!,
    httpPort,
    zwaveServerPort,
    sessionSecret: readEnv('SESSION_SECRET')!,
  };
}

export const config: AppConfig = loadConfig();
