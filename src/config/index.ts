export interface AppConfig {
  serialPort: string;
  dbPath: string;
  httpPort: number;
  zwaveServerPort: number;
  sessionSecret: string;
  /** Z-Wave node id of the configured siren/alert device (FR-013). Null until an installer sets it. */
  sirenNodeId: number | null;
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

function parseSirenNodeId(value: string): number {
  const nodeId = Number(value);
  if (!Number.isInteger(nodeId) || nodeId <= 0) {
    throw new ConfigError(`SIREN_NODE_ID must be a positive integer, got "${value}"`);
  }
  return nodeId;
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

  // Optional: unlike REQUIRED_VARS, a fresh install has no siren device paired yet (it's assigned
  // post-setup), so this is read directly from process.env rather than going through readEnv()'s
  // required-var machinery.
  const rawSirenNodeId = process.env.SIREN_NODE_ID;
  const sirenNodeId =
    rawSirenNodeId === undefined || rawSirenNodeId === '' ? null : parseSirenNodeId(rawSirenNodeId);

  return {
    serialPort: readEnv('SERIAL_PORT')!,
    dbPath: readEnv('DB_PATH')!,
    httpPort,
    zwaveServerPort,
    sessionSecret: readEnv('SESSION_SECRET')!,
    sirenNodeId,
  };
}

export const config: AppConfig = loadConfig();
