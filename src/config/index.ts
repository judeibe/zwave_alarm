export interface AppConfig {
  serialPort: string;
  dbPath: string;
  httpPort: number;
  zwaveServerPort: number;
  /** Host/interface zwave-js-server binds to (T033). Defaults to all interfaces so the Home
   *  Assistant instance can reach it over the local network per spec.md's Assumptions. */
  zwaveServerHost: string;
  sessionSecret: string;
  /** Z-Wave node id of the configured siren/alert device (FR-013). Null until an installer sets it. */
  sirenNodeId: number | null;
  /** Seconds between arming and the panel becoming armed (FR-004). One value for the whole panel. */
  exitDelaySeconds: number;
  /** Seconds between a breach and the alarm triggering (FR-004). One value for the whole panel. */
  entryDelaySeconds: number;
  /** Z-Wave network keys (hex, 16 bytes each) from the environment. Omitted keys are left to zwave-js. */
  securityKeys: Partial<Record<SecurityKeyName, string>>;
  securityKeysLongRange: Partial<Record<LongRangeKeyName, string>>;
  /** When false (default), REST and stream requests need no session or bearer token, so Home Assistant
   *  connects with host and port only. Set API_AUTH_REQUIRED=true to enforce sessions/tokens again. */
  apiAuthRequired: boolean;
}

export type SecurityKeyName = 'S2_Unauthenticated' | 'S2_Authenticated' | 'S2_AccessControl' | 'S0_Legacy';
export type LongRangeKeyName = 'S2_Authenticated' | 'S2_AccessControl';

export class ConfigError extends Error {}

/** Session cookies are signed with this secret, so a short or example value would be guessable. */
const MIN_SESSION_SECRET_LENGTH = 32;
/** `.env.example` ships a value starting with this; copying it unchanged must not start a service. */
const SESSION_SECRET_PLACEHOLDER_PREFIX = 'change-me';

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

function validateSessionSecret(secret: string): string {
  if (secret.length < MIN_SESSION_SECRET_LENGTH || secret.startsWith(SESSION_SECRET_PLACEHOLDER_PREFIX)) {
    throw new ConfigError(
      `SESSION_SECRET must be a random value of at least ${MIN_SESSION_SECRET_LENGTH} characters and not the ` +
        `.env.example placeholder. Generate one with: openssl rand -hex 32`,
    );
  }
  return secret;
}

const DEFAULT_DELAY_SECONDS = 30;
const MAX_DELAY_SECONDS = 600;

/**
 * Optional delay in whole seconds, 0-600. 0 is allowed deliberately: no exit delay arms at once, and
 * no entry delay raises the alarm the instant an intrusion sensor trips.
 */
function parseDelaySeconds(name: string): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') {
    return DEFAULT_DELAY_SECONDS;
  }
  const seconds = Number(raw);
  if (!Number.isInteger(seconds) || seconds < 0 || seconds > MAX_DELAY_SECONDS) {
    throw new ConfigError(`${name} must be a whole number of seconds between 0 and ${MAX_DELAY_SECONDS}, got "${raw}"`);
  }
  return seconds;
}

function parseSirenNodeId(value: string): number {
  const nodeId = Number(value);
  if (!Number.isInteger(nodeId) || nodeId <= 0) {
    throw new ConfigError(`SIREN_NODE_ID must be a positive integer, got "${value}"`);
  }
  return nodeId;
}

const SECURITY_KEY_ENV: Record<SecurityKeyName, string> = {
  S2_Unauthenticated: 'ZWAVE_KEY_S2_UNAUTHENTICATED',
  S2_Authenticated: 'ZWAVE_KEY_S2_AUTHENTICATED',
  S2_AccessControl: 'ZWAVE_KEY_S2_ACCESS_CONTROL',
  S0_Legacy: 'ZWAVE_KEY_S0_LEGACY',
};
const LONG_RANGE_KEY_ENV: Record<LongRangeKeyName, string> = {
  S2_Authenticated: 'ZWAVE_LR_KEY_S2_AUTHENTICATED',
  S2_AccessControl: 'ZWAVE_LR_KEY_S2_ACCESS_CONTROL',
};

/** Reads optional 16-byte hex keys; the error names the variable but never echoes the key. */
function parseKeys<K extends string>(envNames: Record<K, string>): Partial<Record<K, string>> {
  const keys: Partial<Record<K, string>> = {};
  for (const [name, envName] of Object.entries<string>(envNames)) {
    const raw = process.env[envName];
    if (raw === undefined || raw === '') {
      continue;
    }
    if (!/^[0-9a-fA-F]{32}$/.test(raw)) {
      throw new ConfigError(`${envName} must be exactly 32 hexadecimal characters (16 bytes)`);
    }
    keys[name as K] = raw.toLowerCase();
  }
  return keys;
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

  // Optional, same pattern as SIREN_NODE_ID: defaults to 0.0.0.0 (all interfaces) rather than
  // being required, since most installs don't need to restrict the binding interface.
  const rawZwaveServerHost = process.env.ZWAVE_SERVER_HOST;
  const zwaveServerHost =
    rawZwaveServerHost === undefined || rawZwaveServerHost === '' ? '0.0.0.0' : rawZwaveServerHost;

  return {
    serialPort: readEnv('SERIAL_PORT')!,
    dbPath: readEnv('DB_PATH')!,
    httpPort,
    zwaveServerPort,
    zwaveServerHost,
    sessionSecret: validateSessionSecret(readEnv('SESSION_SECRET')!),
    sirenNodeId,
    exitDelaySeconds: parseDelaySeconds('EXIT_DELAY_SECONDS'),
    entryDelaySeconds: parseDelaySeconds('ENTRY_DELAY_SECONDS'),
    securityKeys: parseKeys(SECURITY_KEY_ENV),
    securityKeysLongRange: parseKeys(LONG_RANGE_KEY_ENV),
    apiAuthRequired: process.env.API_AUTH_REQUIRED?.toLowerCase() === 'true',
  };
}

export const config: AppConfig = loadConfig();
