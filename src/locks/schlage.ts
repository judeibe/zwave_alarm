/**
 * Schlage Z-Wave lock knowledge (BE469 touchscreen deadbolt with alarm, BE468 connected touchscreen),
 * kept free of zwave-js so it can be unit-tested and reused by any transport.
 *
 * Everything the Schlage locks expose through the Configuration CC is described once in
 * `SCHLAGE_PARAMETERS`; `LockService` and the REST layer are driven by that table.
 */

export type LockModel = 'BE469' | 'BE468';

export const SCHLAGE_MANUFACTURER_ID = 0x003b;

/** The manufacturer/product ids zwave-js reports for each supported model (including the ZP variants). */
const MODEL_IDS: ReadonlyArray<{ productType: number; productId: number; model: LockModel; label: string }> = [
  { productType: 0x6341, productId: 0x5044, model: 'BE469', label: 'Schlage BE469 Touchscreen Deadbolt with Alarm' },
  { productType: 0x0001, productId: 0x0469, model: 'BE469', label: 'Schlage BE469ZP Touchscreen Deadbolt with Alarm' },
  { productType: 0x6349, productId: 0x5044, model: 'BE468', label: 'Schlage BE468 Connected Touchscreen Deadbolt' },
  { productType: 0x0001, productId: 0x0468, model: 'BE468', label: 'Schlage BE468ZP Connected Touchscreen Deadbolt' },
];

export interface SchlageIdentity {
  model: LockModel;
  label: string;
}

/** Recognises a Schlage lock by the ids from its interview. Anything else is not ours. */
export function identifySchlageLock(ids: { manufacturerId: number; productType: number; productId: number }): SchlageIdentity | undefined {
  if (ids.manufacturerId !== SCHLAGE_MANUFACTURER_ID) {
    return undefined;
  }
  const match = MODEL_IDS.find((entry) => entry.productType === ids.productType && entry.productId === ids.productId);
  return match && { model: match.model, label: match.label };
}

/** How a configuration parameter is presented over the API. */
export type ParameterKind = 'boolean' | 'enum' | 'integer' | 'counter' | 'bitfield';

export interface SchlageParameter {
  /** The key used in the REST API and in `LockSettings`/`LockDiagnostics`. */
  key: string;
  /** The Configuration CC parameter number. */
  parameter: number;
  /** Size in bytes on the wire. */
  size: 1 | 4;
  access: 'read-write' | 'read-only';
  kind: ParameterKind;
  /** The models that have the parameter; the others reject reads and writes. */
  models: readonly LockModel[];
  /** For `enum`: API name by wire value. */
  enumValues?: Readonly<Record<number, string>>;
  /** For `integer`: inclusive bounds of the API value. */
  min?: number;
  max?: number;
  description: string;
}

const BOTH: readonly LockModel[] = ['BE469', 'BE468'];
const BE469_ONLY: readonly LockModel[] = ['BE469'];

/** API names for the Alarm Mode parameter (0x07), by wire value. */
export const ALARM_MODES = { 0: 'off', 1: 'alert', 2: 'tamper', 3: 'forced_entry' } as const;
export type AlarmMode = (typeof ALARM_MODES)[keyof typeof ALARM_MODES];

/** Sensitivity wire values: 0 not supported, 1 most sensitive, 3 medium, 5 least; 2 and 4 are undocumented intermediates. */
export const SENSITIVITY_MIN = 0;
export const SENSITIVITY_MAX = 5;

export const PIN_LENGTH_MIN = 4;
export const PIN_LENGTH_MAX = 8;
export const PIN_LENGTH_DEFAULT = 4;

/** User slots on the lock; parameter 0x06 reports exactly these as a bit field. */
export const USER_SLOT_COUNT = 30;

export const SCHLAGE_PARAMETERS: readonly SchlageParameter[] = [
  { key: 'beeper', parameter: 0x03, size: 1, access: 'read-write', kind: 'boolean', models: BOTH, description: 'Keypad beeper' },
  { key: 'vacationMode', parameter: 0x04, size: 1, access: 'read-write', kind: 'boolean', models: BOTH, description: 'Vacation mode (disables user codes)' },
  { key: 'lockAndLeave', parameter: 0x05, size: 1, access: 'read-write', kind: 'boolean', models: BOTH, description: 'Lock & Leave (one-touch locking)' },
  { key: 'userSlotBitField', parameter: 0x06, size: 4, access: 'read-only', kind: 'bitfield', models: BOTH, description: 'Occupied user slots' },
  { key: 'alarmMode', parameter: 0x07, size: 1, access: 'read-write', kind: 'enum', models: BE469_ONLY, enumValues: ALARM_MODES, description: 'Lock-specific alarm mode' },
  { key: 'alertSensitivity', parameter: 0x08, size: 1, access: 'read-write', kind: 'integer', models: BE469_ONLY, min: SENSITIVITY_MIN, max: SENSITIVITY_MAX, description: 'Alarm alert sensitivity' },
  { key: 'tamperSensitivity', parameter: 0x09, size: 1, access: 'read-write', kind: 'integer', models: BE469_ONLY, min: SENSITIVITY_MIN, max: SENSITIVITY_MAX, description: 'Alarm tamper sensitivity' },
  { key: 'kickSensitivity', parameter: 0x0a, size: 1, access: 'read-write', kind: 'integer', models: BE469_ONLY, min: SENSITIVITY_MIN, max: SENSITIVITY_MAX, description: 'Alarm kick sensitivity' },
  // Wire 0x00 disables local control and 0xFF enables it, so the API value is "local controls enabled".
  { key: 'localControls', parameter: 0x0b, size: 1, access: 'read-write', kind: 'boolean', models: BE469_ONLY, description: 'Alarm: local controls enabled (false disables them)' },
  { key: 'electronicTransitionCount', parameter: 0x0c, size: 4, access: 'read-only', kind: 'counter', models: BOTH, description: 'Electronic transition count' },
  { key: 'mechanicalTransitionCount', parameter: 0x0d, size: 4, access: 'read-only', kind: 'counter', models: BOTH, description: 'Mechanical transition count' },
  { key: 'electronicFailedCount', parameter: 0x0e, size: 4, access: 'read-only', kind: 'counter', models: BOTH, description: 'Electronic failed count' },
  { key: 'autoLock', parameter: 0x0f, size: 1, access: 'read-write', kind: 'boolean', models: BOTH, description: 'Auto lock' },
  { key: 'pinLength', parameter: 0x10, size: 1, access: 'read-write', kind: 'integer', models: BOTH, min: PIN_LENGTH_MIN, max: PIN_LENGTH_MAX, description: 'User code PIN length' },
  { key: 'electronicHighPreloadTransitionCount', parameter: 0x11, size: 4, access: 'read-only', kind: 'counter', models: BOTH, description: 'Electronic high preload transition count' },
  { key: 'bootloaderVersion', parameter: 0x12, size: 1, access: 'read-only', kind: 'counter', models: BOTH, description: 'Bootloader version' },
];

const BY_KEY = new Map(SCHLAGE_PARAMETERS.map((definition) => [definition.key, definition]));

export function getParameterByKey(key: string): SchlageParameter | undefined {
  return BY_KEY.get(key);
}

export function parametersForModel(model: LockModel): SchlageParameter[] {
  return SCHLAGE_PARAMETERS.filter((definition) => definition.models.includes(model));
}

export function isWritable(definition: SchlageParameter): boolean {
  return definition.access === 'read-write';
}

/** Raised for a value the lock would reject, or a parameter the model does not have. */
export class LockValueError extends Error {}

/** Decodes a raw Configuration CC value into the value the API shows. */
export function decodeParameter(definition: SchlageParameter, raw: number): boolean | number | string | number[] {
  switch (definition.kind) {
    case 'boolean':
      return raw !== 0;
    case 'enum':
      return definition.enumValues?.[raw] ?? raw.toString();
    case 'bitfield':
      return userSlotBytes(raw);
    default:
      return raw;
  }
}

/** Encodes an API value into the raw Configuration CC value, validating it. */
export function encodeParameter(definition: SchlageParameter, value: unknown): number {
  switch (definition.kind) {
    case 'boolean':
      if (typeof value !== 'boolean') {
        throw new LockValueError(`${definition.key} must be a boolean`);
      }
      return value ? 0xff : 0x00;
    case 'enum': {
      const entry = Object.entries(definition.enumValues ?? {}).find(([, name]) => name === value);
      if (!entry) {
        throw new LockValueError(`${definition.key} must be one of: ${Object.values(definition.enumValues ?? {}).join(', ')}`);
      }
      return Number(entry[0]);
    }
    case 'integer': {
      const min = definition.min ?? 0;
      const max = definition.max ?? 0xff;
      if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
        throw new LockValueError(`${definition.key} must be an integer from ${String(min)} to ${String(max)}`);
      }
      return value;
    }
    default:
      throw new LockValueError(`${definition.key} is read-only`);
  }
}

/**
 * Splits the 4-byte user slot field into its bytes, most significant first as the lock documents
 * them: bytes 1-3 cover slots 1-24 and byte 4 covers slots 25-30.
 */
export function userSlotBytes(raw: number): number[] {
  return [(raw >>> 24) & 0xff, (raw >>> 16) & 0xff, (raw >>> 8) & 0xff, raw & 0xff];
}

/** The occupied slot numbers (1-30) from the raw bit field; the LSB of each byte is its lowest slot. */
export function occupiedUserSlots(raw: number): number[] {
  const bytes = userSlotBytes(raw);
  const slots: number[] = [];
  for (let slot = 1; slot <= USER_SLOT_COUNT; slot++) {
    const byte = bytes[Math.floor((slot - 1) / 8)] ?? 0;
    if (byte & (1 << ((slot - 1) % 8))) {
      slots.push(slot);
    }
  }
  return slots;
}

/** Checks a user code for the configured PIN length (4-8 digits, all numeric). */
export function validatePin(code: string, pinLength: number | null): void {
  if (!/^\d+$/.test(code)) {
    throw new LockValueError('A lock code must contain digits only');
  }
  if (code.length < PIN_LENGTH_MIN || code.length > PIN_LENGTH_MAX) {
    throw new LockValueError(`A lock code must be ${String(PIN_LENGTH_MIN)} to ${String(PIN_LENGTH_MAX)} digits`);
  }
  if (pinLength !== null && code.length !== pinLength) {
    throw new LockValueError(`The lock is set to ${String(pinLength)}-digit codes`);
  }
}
