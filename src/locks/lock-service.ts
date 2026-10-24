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
  /** Door Lock CC: throw (`true`) or retract (`false`) the bolt. */
  setLocked(nodeId: number, locked: boolean): Promise<void>;
  /** Door Lock CC: whether the bolt is thrown, `undefined` when the lock does not say. */
  getLocked(nodeId: number): Promise<boolean | undefined>;
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

/** What a lock can do, so clients only offer what works. Schedule kinds are `null` until the lock has reported its slot counts. */
export interface LockCapabilities {
  /** Whether the lock was included with S0/S2; User Code and Schedule Entry Lock need it. `null` when unknown. */
  secure: boolean | null;
  userCodes: boolean;
  schedules: { weekDay: boolean | null; yearDay: boolean | null; dailyRepeating: boolean | null };
  /** BE469 only: alarm mode and sensitivities. */
  alarmSettings: boolean;
}

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
  /** Whether the bolt is thrown; `null` until the lock has reported it, or while it says unknown. */
  locked: boolean | null;
  capabilities: LockCapabilities;
}

/** A Schlage lock paired with the controller but not (yet) added to the alarm system. */
export interface AvailableLock {
  nodeId: number;
  model: LockModel;
  label: string;
  connectivityStatus: ConnectivityStatus;
  secure: boolean | null;
}

/** Where the set of enrolled lock nodes is kept; `LockEnrollmentRepository` persists it. */
export interface LockEnrollmentStore {
  isEnrolled(nodeId: number): boolean;
  enroll(nodeId: number): void;
  unenroll(nodeId: number): void;
}

class MemoryEnrollmentStore implements LockEnrollmentStore {
  private readonly nodeIds = new Set<number>();
  isEnrolled(nodeId: number): boolean {
    return this.nodeIds.has(nodeId);
  }
  enroll(nodeId: number): void {
    this.nodeIds.add(nodeId);
  }
  unenroll(nodeId: number): void {
    this.nodeIds.delete(nodeId);
  }
}

/** What was left on a lock when it was unenrolled. `failures` is empty when everything was cleared. */
export interface UnenrollResult {
  nodeId: number;
  cleared: boolean;
  failures: string[];
}

export class LockNotFoundError extends Error {}
/** The lock exists but cannot do what was asked (a BE469-only setting on a BE468). */
export class LockUnsupportedError extends Error {}
/** The lock was not included securely (S0/S2), so user codes and schedules cannot work; it cannot be enrolled. */
export class LockNotSecureError extends Error {}
/** A schedule kind the lock reports no slots for (some firmware has no week-day, year-day or daily-repeating schedules). */
export class LockScheduleKindUnsupportedError extends LockUnsupportedError {}
/** The lock did not answer, or rejected a write. */
export class LockCommunicationError extends Error {}

interface LockEntry {
  model: LockModel;
  label: string;
  connectivityStatus: ConnectivityStatus;
  batteryLevel: number | null;
  secure: boolean | null;
  locked: boolean | null;
  raw: Map<string, number>;
  scheduleSlots: ScheduleSlotCounts | null;
}

const MAX_SCHEDULE_SLOT = 255;

/**
 * The Schlage locks on the Z-Wave network and everything done with them: configuration parameters,
 * diagnostics counters, user codes and Schedule Entry Lock schedules. All parameter handling is
 * table-driven from `SCHLAGE_PARAMETERS`, so it never knows an individual parameter's number.
 *
 * A Schlage node on the network is only *discovered*. It is exposed to clients (`list`, `get`, every
 * operation, `lock_changed`) once an administrator has *enrolled* it into the alarm system; until
 * then it shows up only in `listAvailable`. Enrollment is kept in the `LockEnrollmentStore`.
 *
 * Emits `'lock_changed'` (LockSummary) when an enrolled lock appears or any of its state changes,
 * and `'lock_removed'` (nodeId) when it is unenrolled or leaves the network.
 */
export class LockService extends EventEmitter {
  private readonly locks = new Map<number, LockEntry>();

  constructor(
    private readonly port: LockPort,
    private readonly enrollment: LockEnrollmentStore = new MemoryEnrollmentStore(),
  ) {
    super();
  }

  /** Records a Schlage node found on the network. It stays hidden from clients until it is enrolled. */
  add(nodeId: number, identity: { model: LockModel; label: string }, initial: Partial<Pick<LockEntry, 'connectivityStatus' | 'batteryLevel' | 'secure'>> = {}): void {
    if (this.locks.has(nodeId)) {
      return;
    }
    const entry: LockEntry = {
      model: identity.model,
      label: identity.label,
      connectivityStatus: initial.connectivityStatus ?? 'online',
      batteryLevel: initial.batteryLevel ?? null,
      secure: initial.secure ?? null,
      locked: null,
      raw: new Map(),
      scheduleSlots: null,
    };
    this.locks.set(nodeId, entry);
    if (this.enrollment.isEnrolled(nodeId)) {
      this.emit('lock_changed', this.summarize(nodeId, entry));
    }
  }

  /** True when the node is a Schlage lock that has been added to the alarm system. */
  isEnrolled(nodeId: number): boolean {
    return this.locks.has(nodeId) && this.enrollment.isEnrolled(nodeId);
  }

  /** The enrolled locks: the only ones clients ever see. */
  list(): LockSummary[] {
    return [...this.locks].filter(([nodeId]) => this.enrollment.isEnrolled(nodeId)).map(([nodeId, entry]) => this.summarize(nodeId, entry));
  }

  /** Locks paired with the controller but not added to the alarm system; candidates for `enroll`. */
  listAvailable(): AvailableLock[] {
    return [...this.locks]
      .filter(([nodeId]) => !this.enrollment.isEnrolled(nodeId))
      .map(([nodeId, entry]) => ({ nodeId, model: entry.model, label: entry.label, connectivityStatus: entry.connectivityStatus, secure: entry.secure }));
  }

  /**
   * Adds a discovered lock to the alarm system and reads its state. Idempotent. Refuses a lock known
   * to be included without S0/S2, since its user codes and schedules could not be managed.
   */
  async enroll(nodeId: number): Promise<LockSummary> {
    const entry = this.locks.get(nodeId);
    if (!entry) {
      throw new LockNotFoundError(`No lock with node id ${String(nodeId)}`);
    }
    if (this.enrollment.isEnrolled(nodeId)) {
      return this.summarize(nodeId, entry);
    }
    if (entry.secure === false) {
      throw new LockNotSecureError('The lock was included without security. Exclude it and include it again with S0 or S2.');
    }
    this.enrollment.enroll(nodeId);
    logger.info('lock enrolled', { nodeId, model: entry.model });
    return this.refresh(nodeId);
  }

  /**
   * Takes a lock out of the alarm system, first clearing every user code and schedule on it so the
   * codes do not keep working unmanaged. The lock is unenrolled even when it cannot be cleared (it is
   * offline, say): `cleared` is then `false` and `failures` says what is left on the lock. Idempotent;
   * a lock that is not enrolled has nothing to clear.
   */
  async unenroll(nodeId: number): Promise<UnenrollResult> {
    if (!this.locks.has(nodeId) && !this.enrollment.isEnrolled(nodeId)) {
      throw new LockNotFoundError(`No lock with node id ${String(nodeId)}`);
    }
    if (!this.isEnrolled(nodeId)) {
      this.enrollment.unenroll(nodeId);
      return { nodeId, cleared: true, failures: [] };
    }
    const failures = await this.clearLock(nodeId);
    this.enrollment.unenroll(nodeId);
    logger.info('lock unenrolled', { nodeId, cleared: failures.length === 0 });
    this.emit('lock_removed', nodeId);
    return { nodeId, cleared: failures.length === 0, failures };
  }

  /**
   * Clears the schedules and then the code of every occupied user slot (every slot when the occupied
   * ones are unknown). A first step that fails means the lock is unreachable, so the rest is skipped
   * rather than waiting out a timeout per slot; later failures are collected and the clearing goes on.
   */
  private async clearLock(nodeId: number): Promise<string[]> {
    const entry = this.entry(nodeId);
    await this.readInto(nodeId, entry, requiredDefinition('userSlotBitField'));
    const slots = await this.scheduleSlots(nodeId).catch(() => null);
    const users = this.occupied(entry) ?? Array.from({ length: USER_SLOT_COUNT }, (_, index) => index + 1);

    const failures: string[] = [];
    let attempted = 0;
    const step = async (what: string, run: () => Promise<void>): Promise<boolean> => {
      try {
        await run();
        attempted++;
        return true;
      } catch (err) {
        failures.push(`${what}: ${errorMessage(err)}`);
        return attempted > 0;
      }
    };

    for (const userId of users) {
      for (const kind of SCHEDULE_KINDS) {
        for (let slotId = 1; slotId <= (slots?.[kind] ?? 0); slotId++) {
          if (!(await step(`${kind} schedule ${String(userId)}/${String(slotId)}`, () => this.port.setSchedule(nodeId, kind, userId, slotId, undefined)))) {
            return failures;
          }
        }
      }
      if (!(await step(`user code ${String(userId)}`, () => this.port.clearUserCode(nodeId, userId)))) {
        return failures;
      }
    }
    return failures;
  }

  /** The node left the Z-Wave network: forget it and, if it was enrolled, drop the enrollment too. */
  remove(nodeId: number): void {
    this.locks.delete(nodeId);
    if (this.enrollment.isEnrolled(nodeId)) {
      this.enrollment.unenroll(nodeId);
      this.emit('lock_removed', nodeId);
    }
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
    this.publish(nodeId, entry);
  }

  /**
   * Throws or retracts the bolt. The lock moves after it answers, so the returned summary may still
   * show the old state; the new one arrives as a `lock_changed` when the lock reports it.
   */
  async setLocked(nodeId: number, locked: boolean): Promise<LockSummary> {
    const entry = this.entry(nodeId);
    await this.communicate(locked ? 'Locking' : 'Unlocking', () => this.port.setLocked(nodeId, locked));
    return this.summarize(nodeId, entry);
  }

  /** Records the bolt state the lock reported (a Door Lock report or an Access Control notification). */
  recordLocked(nodeId: number, locked: boolean | null): void {
    const entry = this.locks.get(nodeId);
    if (!entry || entry.locked === locked) {
      return;
    }
    entry.locked = locked;
    this.publish(nodeId, entry);
  }

  /** Records a parameter value the lock reported unprompted (a Configuration Report), so clients see it without a poll. */
  recordReport(nodeId: number, parameter: number, raw: number): void {
    const entry = this.locks.get(nodeId);
    const definition = entry && parametersForModel(entry.model).find((candidate) => candidate.parameter === parameter);
    if (!entry || !definition || entry.raw.get(definition.key) === raw) {
      return;
    }
    entry.raw.set(definition.key, raw);
    this.publish(nodeId, entry);
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
    try {
      entry.locked = (await this.port.getLocked(nodeId)) ?? entry.locked;
    } catch (err) {
      logger.warn('reading the lock state failed', { nodeId, error: errorMessage(err) });
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
    if (count === 0) {
      throw new LockScheduleKindUnsupportedError(`This lock does not support ${kind} schedules`);
    }
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

  /** Emits `lock_changed`, but only for an enrolled lock: clients never hear about the others. */
  private publish(nodeId: number, entry: LockEntry): LockSummary {
    const summary = this.summarize(nodeId, entry);
    if (this.enrollment.isEnrolled(nodeId)) {
      this.emit('lock_changed', summary);
    }
    return summary;
  }

  /** The enrolled lock, or `LockNotFoundError`: a lock that is only paired looks the same as no lock. */
  private entry(nodeId: number): LockEntry {
    const entry = this.locks.get(nodeId);
    if (!entry || !this.enrollment.isEnrolled(nodeId)) {
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
      locked: entry.locked,
      capabilities: {
        secure: entry.secure,
        userCodes: true,
        schedules: {
          weekDay: entry.scheduleSlots && entry.scheduleSlots.weekDay > 0,
          yearDay: entry.scheduleSlots && entry.scheduleSlots.yearDay > 0,
          dailyRepeating: entry.scheduleSlots && entry.scheduleSlots.dailyRepeating > 0,
        },
        alarmSettings: parametersForModel(entry.model).some((definition) => definition.key === 'alarmMode'),
      },
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
