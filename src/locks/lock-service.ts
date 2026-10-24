import { EventEmitter } from 'node:events';
import { createLogger } from '../config/logger.js';
import type { ConnectivityStatus } from '../db/repositories/sensor-repository.js';
import {
  LockValueError,
  decodeParameter,
  encodeParameter,
  getParameterByKey,
  isWritable,
  occupiedUserSlots,
  parametersForModel,
  userSlotBytes,
  validatePin,
  USER_SLOT_COUNT,
  type LockModel,
  type SchlageParameter,
} from './schlage.js';

const logger = createLogger('locks/service');

/** Weekday numbers follow the Schedule Entry Lock CC: 0 Sunday ... 6 Saturday. */
export interface WeekDaySchedule {
  weekday: number;
  startHour: number;
  startMinute: number;
  stopHour: number;
  stopMinute: number;
}

export interface YearDaySchedule {
  startYear: number;
  startMonth: number;
  startDay: number;
  startHour: number;
  startMinute: number;
  stopYear: number;
  stopMonth: number;
  stopDay: number;
  stopHour: number;
  stopMinute: number;
}

export interface DailyRepeatingSchedule {
  weekdays: number[];
  startHour: number;
  startMinute: number;
  durationHour: number;
  durationMinute: number;
}

export type ScheduleKind = 'weekDay' | 'yearDay' | 'dailyRepeating';
export const SCHEDULE_KINDS: readonly ScheduleKind[] = ['weekDay', 'yearDay', 'dailyRepeating'];

export interface ScheduleByKind {
  weekDay: WeekDaySchedule;
  yearDay: YearDaySchedule;
  dailyRepeating: DailyRepeatingSchedule;
}

/** How many schedule slots each user has, from Schedule Entry Lock `Supported Get`. */
export interface ScheduleSlotCounts {
  weekDay: number;
  yearDay: number;
  dailyRepeating: number;
}

export type UserCodeStatus = 'enabled' | 'disabled';

/** What the lock reports for one user slot. The code itself is never read back. */
export interface UserSlot {
  userId: number;
  status: 'available' | UserCodeStatus;
}

/**
 * Everything `LockService` needs from the Z-Wave network. `ZwaveLockGateway` is the real one; tests
 * use a stub. Each method throws if the node is missing or does not answer.
 */
export interface LockPort {
  readParameter(nodeId: number, parameter: number): Promise<number | undefined>;
  writeParameter(nodeId: number, parameter: number, size: 1 | 4, value: number): Promise<void>;
  setUserCode(nodeId: number, userId: number, status: UserCodeStatus, code: string): Promise<void>;
  clearUserCode(nodeId: number, userId: number): Promise<void>;
  getUserSlot(nodeId: number, userId: number): Promise<UserSlot>;
  getScheduleSlotCounts(nodeId: number): Promise<ScheduleSlotCounts | undefined>;
  setScheduleEnabled(nodeId: number, userId: number, enabled: boolean): Promise<void>;
  setSchedule<K extends ScheduleKind>(nodeId: number, kind: K, userId: number, slotId: number, schedule: ScheduleByKind[K] | undefined): Promise<void>;
  getSchedule<K extends ScheduleKind>(nodeId: number, kind: K, userId: number, slotId: number): Promise<ScheduleByKind[K] | undefined>;
}

/** The read/write parameters of a lock, by API key. `null` is "not read yet" or "this model has none". */
export interface LockSettings {
  beeper: boolean | null;
  vacationMode: boolean | null;
  lockAndLeave: boolean | null;
  autoLock: boolean | null;
  pinLength: number | null;
  /** BE469 only. */
  alarmMode: string | null;
  alertSensitivity: number | null;
  tamperSensitivity: number | null;
  kickSensitivity: number | null;
  /** True when the keypad and thumb-turn work while the alarm is armed; false disables them. */
  localControls: boolean | null;
}

export const SETTING_KEYS = [
  'beeper',
  'vacationMode',
  'lockAndLeave',
  'autoLock',
  'pinLength',
  'alarmMode',
  'alertSensitivity',
  'tamperSensitivity',
  'kickSensitivity',
  'localControls',
] as const satisfies ReadonlyArray<keyof LockSettings>;

export type SettingKey = (typeof SETTING_KEYS)[number];
export type SettingsChange = Partial<{ [K in SettingKey]: NonNullable<LockSettings[K]> }>;

/** The read-only parameters of a lock. */
export interface LockDiagnostics {
  electronicTransitionCount: number | null;
  mechanicalTransitionCount: number | null;
  electronicFailedCount: number | null;
  electronicHighPreloadTransitionCount: number | null;
  bootloaderVersion: number | null;
  /** The four raw bytes of parameter 0x06; bytes 1-3 cover slots 1-24, byte 4 slots 25-30. */
  userSlotBitField: number[] | null;
  /** Occupied user slots (1-30) decoded from the bit field. */
  occupiedUserSlots: number[] | null;
}

export const DIAGNOSTIC_KEYS = [
  'electronicTransitionCount',
  'mechanicalTransitionCount',
  'electronicFailedCount',
  'electronicHighPreloadTransitionCount',
  'bootloaderVersion',
] as const satisfies ReadonlyArray<keyof LockDiagnostics>;

/** The `LockSummary` of contracts/locks.md: what clients see of a lock. */
export interface LockSummary {
  nodeId: number;
  model: LockModel;
  label: string;
  connectivityStatus: ConnectivityStatus;
  batteryLevel: number | null;
  /** Settings the model has; the BE469-only ones are absent from a BE468 summary's `supportedSettings`. */
  supportedSettings: SettingKey[];
  settings: LockSettings;
  diagnostics: LockDiagnostics;
  /** Schedule slots per user; `null` until the lock has answered. */
  scheduleSlots: ScheduleSlotCounts | null;
  userSlotCount: number;
}

export class LockNotFoundError extends Error {}
/** The lock exists but cannot do what was asked (a BE469-only setting on a BE468). */
export class LockUnsupportedError extends Error {}
/** The lock did not answer, or rejected a write. */
export class LockCommunicationError extends Error {}

interface LockEntry {
  model: LockModel;
  label: string;
  connectivityStatus: ConnectivityStatus;
  batteryLevel: number | null;
  raw: Map<string, number>;
  scheduleSlots: ScheduleSlotCounts | null;
}

const MAX_SCHEDULE_SLOT = 255;

/**
 * The Schlage locks on the Z-Wave network and everything done with them: configuration parameters,
 * diagnostics counters, user codes and Schedule Entry Lock schedules. All parameter handling is
 * table-driven from `SCHLAGE_PARAMETERS`, so it never knows an individual parameter's number.
 *
 * Emits `'lock_changed'` (LockSummary) when a lock appears or any of its state changes.
 */
export class LockService extends EventEmitter {
  private readonly locks = new Map<number, LockEntry>();

  constructor(private readonly port: LockPort) {
    super();
  }

  add(nodeId: number, identity: { model: LockModel; label: string }, initial: Partial<Pick<LockEntry, 'connectivityStatus' | 'batteryLevel'>> = {}): LockSummary {
    const existing = this.locks.get(nodeId);
    if (existing) {
      return this.summarize(nodeId, existing);
    }
    const entry: LockEntry = {
      model: identity.model,
      label: identity.label,
      connectivityStatus: initial.connectivityStatus ?? 'online',
      batteryLevel: initial.batteryLevel ?? null,
      raw: new Map(),
      scheduleSlots: null,
    };
    this.locks.set(nodeId, entry);
    const summary = this.summarize(nodeId, entry);
    this.emit('lock_changed', summary);
    return summary;
  }

  has(nodeId: number): boolean {
    return this.locks.has(nodeId);
  }

  list(): LockSummary[] {
    return [...this.locks].map(([nodeId, entry]) => this.summarize(nodeId, entry));
  }

  get(nodeId: number): LockSummary {
    return this.summarize(nodeId, this.entry(nodeId));
  }

  updateStatus(nodeId: number, changes: Partial<Pick<LockEntry, 'connectivityStatus' | 'batteryLevel'>>): void {
    const entry = this.locks.get(nodeId);
    if (!entry) {
      return;
    }
    const connectivityStatus = changes.connectivityStatus ?? entry.connectivityStatus;
    const batteryLevel = changes.batteryLevel === undefined ? entry.batteryLevel : changes.batteryLevel;
    if (connectivityStatus === entry.connectivityStatus && batteryLevel === entry.batteryLevel) {
      return;
    }
    entry.connectivityStatus = connectivityStatus;
    entry.batteryLevel = batteryLevel;
    this.emit('lock_changed', this.summarize(nodeId, entry));
  }

  /** Records a parameter value the lock reported unprompted (a Configuration Report), so clients see it without a poll. */
  recordReport(nodeId: number, parameter: number, raw: number): void {
    const entry = this.locks.get(nodeId);
    const definition = entry && parametersForModel(entry.model).find((candidate) => candidate.parameter === parameter);
    if (!entry || !definition || entry.raw.get(definition.key) === raw) {
      return;
    }
    entry.raw.set(definition.key, raw);
    this.emit('lock_changed', this.summarize(nodeId, entry));
  }

  /**
   * Reads every parameter the model has, plus the schedule slot counts, from the lock. A parameter
   * that fails to read is logged and left as it was, so one flaky read does not lose the rest.
   */
  async refresh(nodeId: number): Promise<LockSummary> {
    const entry = this.entry(nodeId);
    for (const definition of parametersForModel(entry.model)) {
      await this.readInto(nodeId, entry, definition);
    }
    try {
      entry.scheduleSlots = (await this.port.getScheduleSlotCounts(nodeId)) ?? entry.scheduleSlots;
    } catch (err) {
      logger.warn('reading schedule slot counts failed', { nodeId, error: errorMessage(err) });
    }
    return this.publish(nodeId, entry);
  }

  /**
   * Writes a set of settings, each validated against its parameter definition first so nothing is
   * written if any one is invalid. Throws `LockUnsupportedError` for a setting the model lacks and
   * `LockValueError` for an out-of-range value.
   */
  async updateSettings(nodeId: number, changes: SettingsChange): Promise<LockSummary> {
    const entry = this.entry(nodeId);
    const writes = Object.entries(changes)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => {
        const definition = this.settingDefinition(entry, key);
        return { definition, raw: encodeParameter(definition, value) };
      });

    for (const { definition, raw } of writes) {
      try {
        await this.port.writeParameter(nodeId, definition.parameter, definition.size, raw);
      } catch (err) {
        throw new LockCommunicationError(`Setting ${definition.key} failed: ${errorMessage(err)}`);
      }
      entry.raw.set(definition.key, raw);
    }
    return this.publish(nodeId, entry);
  }

  /** The user slots the lock reports, 1 to 30. */
  async listUsers(nodeId: number): Promise<UserSlot[]> {
    const entry = this.entry(nodeId);
    const occupied = this.occupied(entry);
    const slots: UserSlot[] = [];
    for (let userId = 1; userId <= USER_SLOT_COUNT; userId++) {
      // The bit field says which slots hold a code, so the empty ones need no round trip.
      slots.push(occupied && !occupied.includes(userId) ? { userId, status: 'available' } : await this.getUser(nodeId, userId));
    }
    return slots;
  }

  async getUser(nodeId: number, userId: number): Promise<UserSlot> {
    this.entry(nodeId);
    assertUserId(userId);
    return this.communicate('Reading the user code', () => this.port.getUserSlot(nodeId, userId));
  }

  /** Sets a user code, validated against the lock's configured PIN length (4-8 digits). */
  async setUserCode(nodeId: number, userId: number, code: string, status: UserCodeStatus = 'enabled'): Promise<UserSlot> {
    const entry = this.entry(nodeId);
    assertUserId(userId);
    validatePin(code, this.pinLength(entry));
    await this.communicate('Setting the user code', () => this.port.setUserCode(nodeId, userId, status, code));
    await this.readInto(nodeId, entry, requiredDefinition('userSlotBitField'));
    this.publish(nodeId, entry);
    return { userId, status };
  }

  async clearUserCode(nodeId: number, userId: number): Promise<void> {
    const entry = this.entry(nodeId);
    assertUserId(userId);
    await this.communicate('Clearing the user code', () => this.port.clearUserCode(nodeId, userId));
    await this.readInto(nodeId, entry, requiredDefinition('userSlotBitField'));
    this.publish(nodeId, entry);
  }

  /** Turns schedule enforcement on or off for one user. */
  async setScheduleEnabled(nodeId: number, userId: number, enabled: boolean): Promise<void> {
    this.entry(nodeId);
    assertUserId(userId);
    await this.communicate('Changing the schedule state', () => this.port.setScheduleEnabled(nodeId, userId, enabled));
  }

  async getSchedule<K extends ScheduleKind>(nodeId: number, kind: K, userId: number, slotId: number): Promise<ScheduleByKind[K] | undefined> {
    const entry = this.entry(nodeId);
    this.assertSlot(entry, kind, userId, slotId);
    return this.communicate('Reading the schedule', () => this.port.getSchedule(nodeId, kind, userId, slotId));
  }

  async setSchedule<K extends ScheduleKind>(nodeId: number, kind: K, userId: number, slotId: number, schedule: ScheduleByKind[K]): Promise<void> {
    const entry = this.entry(nodeId);
    this.assertSlot(entry, kind, userId, slotId);
    await this.communicate('Setting the schedule', () => this.port.setSchedule(nodeId, kind, userId, slotId, schedule));
  }

  async clearSchedule(nodeId: number, kind: ScheduleKind, userId: number, slotId: number): Promise<void> {
    const entry = this.entry(nodeId);
    this.assertSlot(entry, kind, userId, slotId);
    await this.communicate('Clearing the schedule', () => this.port.setSchedule(nodeId, kind, userId, slotId, undefined));
  }

  /** The schedule slot counts, read from the lock when not yet known. */
  async scheduleSlots(nodeId: number): Promise<ScheduleSlotCounts | null> {
    const entry = this.entry(nodeId);
    if (!entry.scheduleSlots) {
      entry.scheduleSlots = (await this.communicate('Reading the schedule slot counts', () => this.port.getScheduleSlotCounts(nodeId))) ?? null;
      this.publish(nodeId, entry);
    }
    return entry.scheduleSlots;
  }

  private assertSlot(entry: LockEntry, kind: ScheduleKind, userId: number, slotId: number): void {
    assertUserId(userId);
    const count = entry.scheduleSlots?.[kind] ?? MAX_SCHEDULE_SLOT;
    if (!Number.isInteger(slotId) || slotId < 1 || slotId > count) {
      throw new LockValueError(`${kind} slot must be an integer from 1 to ${String(count)}`);
    }
  }

  private async communicate<T>(action: string, run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (err) {
      throw new LockCommunicationError(`${action} failed: ${errorMessage(err)}`);
    }
  }

  private async readInto(nodeId: number, entry: LockEntry, definition: SchlageParameter): Promise<void> {
    try {
      const raw = await this.port.readParameter(nodeId, definition.parameter);
      if (raw !== undefined) {
        entry.raw.set(definition.key, raw);
      }
    } catch (err) {
      logger.warn('reading a lock parameter failed', { nodeId, parameter: definition.parameter, error: errorMessage(err) });
    }
  }

  private publish(nodeId: number, entry: LockEntry): LockSummary {
    const summary = this.summarize(nodeId, entry);
    this.emit('lock_changed', summary);
    return summary;
  }

  private entry(nodeId: number): LockEntry {
    const entry = this.locks.get(nodeId);
    if (!entry) {
      throw new LockNotFoundError(`No lock with node id ${String(nodeId)}`);
    }
    return entry;
  }

  private settingDefinition(entry: LockEntry, key: string): SchlageParameter {
    const definition = getParameterByKey(key);
    if (!definition || !(SETTING_KEYS as readonly string[]).includes(key)) {
      throw new LockValueError(`Unknown setting "${key}"`);
    }
    if (!isWritable(definition)) {
      throw new LockValueError(`${key} is read-only`);
    }
    if (!definition.models.includes(entry.model)) {
      throw new LockUnsupportedError(`${key} is not supported by the ${entry.model}`);
    }
    return definition;
  }

  private pinLength(entry: LockEntry): number | null {
    return entry.raw.get('pinLength') ?? null;
  }

  private occupied(entry: LockEntry): number[] | null {
    const raw = entry.raw.get('userSlotBitField');
    return raw === undefined ? null : occupiedUserSlots(raw);
  }

  private summarize(nodeId: number, entry: LockEntry): LockSummary {
    const value = <T>(key: string): T | null => {
      const definition = getParameterByKey(key);
      const raw = entry.raw.get(key);
      return definition && raw !== undefined && definition.models.includes(entry.model) ? (decodeParameter(definition, raw) as T) : null;
    };
    const slotRaw = entry.raw.get('userSlotBitField');
    return {
      nodeId,
      model: entry.model,
      label: entry.label,
      connectivityStatus: entry.connectivityStatus,
      batteryLevel: entry.batteryLevel,
      supportedSettings: SETTING_KEYS.filter((key) => getParameterByKey(key)?.models.includes(entry.model)),
      settings: {
        beeper: value('beeper'),
        vacationMode: value('vacationMode'),
        lockAndLeave: value('lockAndLeave'),
        autoLock: value('autoLock'),
        pinLength: value('pinLength'),
        alarmMode: value('alarmMode'),
        alertSensitivity: value('alertSensitivity'),
        tamperSensitivity: value('tamperSensitivity'),
        kickSensitivity: value('kickSensitivity'),
        localControls: value('localControls'),
      },
      diagnostics: {
        electronicTransitionCount: value('electronicTransitionCount'),
        mechanicalTransitionCount: value('mechanicalTransitionCount'),
        electronicFailedCount: value('electronicFailedCount'),
        electronicHighPreloadTransitionCount: value('electronicHighPreloadTransitionCount'),
        bootloaderVersion: value('bootloaderVersion'),
        userSlotBitField: slotRaw === undefined ? null : userSlotBytes(slotRaw),
        occupiedUserSlots: slotRaw === undefined ? null : occupiedUserSlots(slotRaw),
      },
      scheduleSlots: entry.scheduleSlots,
      userSlotCount: USER_SLOT_COUNT,
    };
  }
}

function assertUserId(userId: number): void {
  if (!Number.isInteger(userId) || userId < 1 || userId > USER_SLOT_COUNT) {
    throw new LockValueError(`userId must be an integer from 1 to ${String(USER_SLOT_COUNT)}`);
  }
}

function requiredDefinition(key: string): SchlageParameter {
  const definition = getParameterByKey(key);
  if (!definition) {
    throw new Error(`missing Schlage parameter definition: ${key}`);
  }
  return definition;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
