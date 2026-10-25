import { EventEmitter } from 'node:events';
import { AlarmCommandDispatcher, type AlarmCommandRequest, type CommandSource } from './dispatcher.js';
import { AlarmPanelRepository, type AlarmMode, type AlarmPanel, type AlarmPanelUpdate, type ArmedMode } from './panel-repository.js';
import { EventRepository, type SecurityEventSource } from '../events/event-repository.js';
import { createLogger } from '../config/logger.js';
import type { SensorDevice, SensorRepository } from '../db/repositories/sensor-repository.js';
import { soundsSiren, type AlarmEventService } from './alarm-event-service.js';
import type { AlarmEvent, AlarmEventType, EmergencyService } from './alarm-event-repository.js';
import type { ModeConfig, ModeConfigRepository, ModeDelays } from '../db/repositories/mode-config-repository.js';

const logger = createLogger('alarm/panel');

export type ArmMode = ArmedMode;

/** Thrown when a command is requested from a panel mode that doesn't support it (e.g. arming while already armed). */
export class PanelStateError extends Error {}

/** Where an arm request came from (Ring spec, Arming). `lock` and `schedule` bypass faulted sensors automatically. */
export type ArmSource = 'app' | 'keypad' | 'lock' | 'schedule' | 'alexa';
const AUTO_BYPASS_SOURCES: ReadonlySet<ArmSource> = new Set(['lock', 'schedule']);

/** Why a sensor blocks arming. `not_set_up` and `updating` are reserved: the server does not track them yet. */
export type FaultReason = 'open' | 'tampered' | 'offline' | 'not_set_up' | 'updating';

export interface FaultedSensor {
  sensorId: string;
  name: string;
  zoneId: string;
  reason: FaultReason;
}

/** Thrown by arm() when sensors are faulted and the request neither auto-bypasses nor lists them in `bypass`. */
export class NeedsBypassError extends Error {
  constructor(readonly faulted: FaultedSensor[]) {
    super(`${String(faulted.length)} sensor(s) are open or offline; confirm a bypass to arm.`);
  }
}

/** Thrown by arm() when `bypass` names a sensor that does not exist or is not an intrusion sensor. */
export class UnknownBypassSensorError extends Error {
  constructor(readonly sensorIds: string[]) {
    super(`Cannot bypass unknown or non-intrusion sensor(s): ${sensorIds.join(', ')}.`);
  }
}

export interface PanelCommandOptions {
  source: CommandSource;
  requestedAt?: number;
  /** The authenticated user who issued the command, if any (null for e.g. a schedule). */
  sourceUserId?: string | null;
  /**
   * Human-readable identity of the caller (e.g. a user's display name, or "Home Assistant"
   * for an HA-originated command), recorded on the `alarm_cleared` SecurityEvent so recipients
   * can be told "cleared, and by whom" (User Story 3's second acceptance scenario in spec.md).
   */
  clearedBy?: string | null;
  /** For `disarmZone`: a display name for the zone, recorded in the SecurityEvent details. */
  zoneName?: string | null;
  /** For `arm`: where the request came from. Defaults to `app`. */
  armSource?: ArmSource;
  /** For `arm`: sensor ids the caller confirms to bypass for this arm session. */
  bypass?: string[];
  /** For `arm`: bypass every faulted sensor without confirmation (internal callers that cannot prompt). */
  autoBypass?: boolean;
  /** Display name recorded as the history actor, e.g. `Schedule: Night`. */
  actor?: string;
  /** Record the command's history events as the system's (used by mode schedules). */
  systemEvent?: boolean;
  /** The device the command came from (a lock), recorded as the history event's device. */
  device?: { id: string; name: string };
}

export type SensorBreachInput = Pick<SensorDevice, 'id' | 'zoneId' | 'category'> &
  Partial<Pick<SensorDevice, 'placement' | 'armedHome' | 'armedAway' | 'alertsOnly' | 'alarmKind'>>;

export interface TriggerAlarmContext {
  relatedZoneId?: string | null;
  relatedSensorId?: string | null;
  details?: string | null;
  /** What kind of alarm event this opens. Defaults to BURGLARY. */
  alarm?: { type: AlarmEventType; service?: EmergencyService | null };
}

/** The app's emergency buttons (and the keypad's), mapped onto alarm event types by `raiseEmergency`. */
export type EmergencyKind = 'PANIC' | 'FIRE' | 'MEDICAL' | 'SOS';

const DEFAULT_DELAY_MS = 60_000;

interface CommandContext {
  /** Set only for a zone-restricted disarm (`disarm_zone`). */
  zoneId: string | null;
  zoneName: string | null;
  /** `system` is a delay resumed after a restart, where the original requester is no longer known. */
  source: CommandSource | 'system';
  sourceUserId: string | null;
  clearedBy: string | null;
  armSource: ArmSource;
  bypass: string[];
  autoBypass: boolean;
  /** Human-readable bypass list for the `armed` event, filled in when arming begins. */
  bypassNote: string | null;
  /** The sensors bypassed for this arm session, recorded as `bypassed` history events once arming starts. */
  bypassedSensors: { id: string; name: string; reason: FaultReason | null }[];
  /** Display name for the history log, e.g. `Schedule: Night`; null derives it from the user or source. */
  actor: string | null;
  /** Record this command's events as caused by the system (a schedule) rather than a person. */
  systemEvent: boolean;
  /** The device the command came from, recorded on its history events. */
  device: { id: string; name: string } | null;
}

type PanelCommand = 'arm_away' | 'arm_home' | 'disarm' | 'disarm_zone';

/** Why a transition happened, logged alongside the old/new mode (e.g. `{ cause: 'arm_command', source: 'native' }`). */
type TransitionCause = { cause: string } & Record<string, unknown>;

function eventSource(source: CommandContext['source'], systemEvent = false): 'user' | 'home_assistant' | 'system' {
  if (systemEvent) {
    return 'system';
  }
  return source === 'home_assistant' ? 'home_assistant' : source === 'system' ? 'system' : 'user';
}

/**
 * AlarmPanel state-machine service (data-model.md's AlarmPanel state-transitions
 * section; FR-001, FR-003, FR-004, FR-015). Arm/disarm requests are serialized
 * through the AlarmCommandDispatcher built in Phase 01 so FR-014's
 * native-interface-precedence rule is enforced before a transition is ever
 * committed. Sensor-triggered transitions (breach, life-safety) bypass the
 * dispatcher entirely — they aren't a race between two competing command
 * sources, they're the panel reacting to the world.
 *
 * better-sqlite3 is synchronous and Node is single-threaded, so a dispatcher
 * command handler and a delay timer's callback can never actually run at the
 * same instant — each one's read-modify-write of the panel row runs to
 * completion in a single tick before anything else gets a turn. That's what
 * lets completeArming()/completeEntryDelay() safely re-check the current mode
 * before acting instead of needing an explicit lock.
 *
 * Every committed state change emits a `'panel_changed'` event (current
 * AlarmPanel snapshot) so other modules can react without polling — e.g.
 * `src/alarm/siren.ts` (T026) turning the siren on/off around
 * `alarm_triggered`.
 */
export class PanelService extends EventEmitter {
  private readonly dispatcher: AlarmCommandDispatcher;
  private readonly modeConfig: ModeConfigRepository | undefined;
  private readonly commandContext = new WeakMap<AlarmCommandRequest, CommandContext>();
  private pendingTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly panelRepo: AlarmPanelRepository,
    private readonly eventRepo: EventRepository,
    /**
     * `modeConfig` is the source of the per-mode delays; `exitDelayMs` / `entryDelayMs` override it for every
     * mode (tests). With neither, a mode falls back to 60 s.
     */
    private readonly options: {
      modeConfig?: ModeConfigRepository;
      /** Records alarm events and drives the siren's lifecycle; without it alarms still change the panel only. */
      alarmEvents?: AlarmEventService;
      /** Enables the pre-arm check; without it every arm request succeeds with no bypass. */
      sensorRepo?: SensorRepository;
      exitDelayMs?: number;
      entryDelayMs?: number;
      dispatcherWindowMs?: number;
    } = {},
  ) {
    super();
    this.modeConfig = options.modeConfig;
    this.dispatcher = new AlarmCommandDispatcher((command) => this.handleCommand(command), {
      windowMs: this.options.dispatcherWindowMs,
    });
  }

  getState(): AlarmPanel {
    return this.panelRepo.getPanel();
  }

  /** The per-mode entry and exit delays, for snapshots and `panel.changed`. */
  getModes(): ModeConfig {
    return this.modeConfig?.getAll() ?? {
      armed_home: this.delaysFor('armed_home'),
      armed_away: this.delaysFor('armed_away'),
    };
  }

  /** Persists a delay change and tells listeners (the WebSocket broadcaster) via `panel_changed`. */
  updateModes(changes: Partial<Record<ArmedMode, Partial<ModeDelays>>>): ModeConfig {
    if (!this.modeConfig) {
      throw new PanelStateError('Mode configuration is not available.');
    }
    const modes = this.modeConfig.update(changes);
    this.emit('panel_changed', this.panelRepo.getPanel());
    return modes;
  }

  private delaysFor(mode: ArmedMode): ModeDelays {
    const stored = this.modeConfig?.getMode(mode);
    return {
      entryDelaySec: this.options.entryDelayMs !== undefined ? this.options.entryDelayMs / 1000 : (stored?.entryDelaySec ?? DEFAULT_DELAY_MS / 1000),
      exitDelaySec: this.options.exitDelayMs !== undefined ? this.options.exitDelayMs / 1000 : (stored?.exitDelaySec ?? DEFAULT_DELAY_MS / 1000),
    };
  }

  /** disarmed → arming (exit delay starts); resolves once the delay elapses and armed_away/armed_home is committed. */
  arm(mode: ArmMode, options: PanelCommandOptions): Promise<AlarmPanel> {
    return this.submit(mode === 'armed_away' ? 'arm_away' : 'arm_home', options);
  }

  /** arming/armed_away/armed_home/alarm_pending/alarm_triggered → disarmed on a valid disarm code (validated by the caller). */
  disarm(options: PanelCommandOptions): Promise<AlarmPanel> {
    return this.submit('disarm', options);
  }

  /**
   * A zone-restricted guest's disarm (FR-010a): disarms only `zoneId`, leaving the rest of the
   * panel armed. Intrusion breaches in that zone are ignored until the panel is next fully
   * disarmed or armed again, and an alarm that a breach *in that zone* caused is cleared back to
   * the armed mode. An alarm from anywhere else is untouched, and life-safety sensors still
   * trigger (FR-015). A no-op while the panel is disarmed.
   */
  disarmZone(zoneId: string, options: PanelCommandOptions): Promise<AlarmPanel> {
    return this.submit('disarm_zone', { ...options, zoneId });
  }

  /** Intrusion sensors are armed-state-gated (FR-003); life-safety sensors always trigger immediately (FR-015). */
  reportSensorBreach(sensor: SensorBreachInput): AlarmPanel {
    if (sensor.category === 'life-safety') {
      return this.triggerAlarm({
        relatedZoneId: sensor.zoneId,
        relatedSensorId: sensor.id,
        alarm: { type: sensor.alarmKind ?? 'SMOKE' },
      });
    }
    return this.reportIntrusionBreach(sensor);
  }

  /**
   * A tamper report (cover removed or moved) from an intrusion sensor (Ring spec, Triggers). It cannot be
   * disabled: while the panel is armed it raises a BURGLARY at once, ignoring the per-mode armed flag, the
   * placement and the entry delay (a bypassed sensor is the one exception, as for any breach). While disarmed
   * or in the exit delay it only shows on the sensor and in the history, which the caller records.
   */
  reportSensorTamper(sensor: SensorBreachInput & Partial<Pick<SensorDevice, 'name'>>): AlarmPanel {
    const current = this.panelRepo.getPanel();
    if (sensor.category !== 'intrusion') {
      return current;
    }
    if (current.mode !== 'armed_home' && current.mode !== 'armed_away' && current.mode !== 'alarm_pending') {
      return current;
    }
    if (current.bypassedDeviceIds.includes(sensor.id)) {
      logger.info('tamper ignored: the sensor is bypassed for this arm session', { sensorId: sensor.id });
      return current;
    }
    return this.triggerAlarm({
      relatedZoneId: sensor.zoneId,
      relatedSensorId: sensor.id,
      details: `Tamper: ${sensor.name ?? sensor.id}`,
    });
  }

  /**
   * Any mode → alarm_triggered immediately, bypassing delays (FR-015). Used
   * directly for life-safety sensors and, in a later phase, by the
   * lockout-policy's `trigger_alarm` mode (FR-016).
   */
  triggerAlarm(context: TriggerAlarmContext = {}): AlarmPanel {
    return this.raise(context).panel;
  }

  /**
   * Opens an alarm event for an emergency button (Ring spec, Events). PANIC is a police request, FIRE a fire
   * request (siren), MEDICAL a medical request (no siren), SOS the app's button with a chosen `service`
   * (default police). Always allowed, in every mode.
   */
  raiseEmergency(kind: EmergencyKind, options: { service?: EmergencyService | null; details?: string | null } = {}): AlarmEvent {
    const alarm: NonNullable<TriggerAlarmContext['alarm']> =
      kind === 'PANIC'
        ? { type: 'PANIC', service: 'police' }
        : kind === 'FIRE'
          ? { type: 'FIRE_MEDICAL', service: 'fire' }
          : kind === 'MEDICAL'
            ? { type: 'FIRE_MEDICAL', service: 'medical' }
            : { type: 'SOS', service: options.service ?? 'police' };
    const { event } = this.raise({ alarm, details: options.details ?? `${kind} requested` });
    if (!event) {
      throw new PanelStateError('Alarm events are not available.');
    }
    return event;
  }

  /**
   * Opens a silent DURESS alarm event (Ring spec, Events): police are requested at once, contacts are not
   * called and it cannot be cancelled. Call it right after the disarm the duress code performed, so the
   * disarm doesn't close the new event. Works whatever the panel's mode, including already disarmed.
   */
  raiseDuress(details: string): AlarmEvent {
    const { event } = this.raise({ alarm: { type: 'DURESS' }, details });
    if (!event) {
      throw new PanelStateError('Alarm events are not available.');
    }
    return event;
  }

  /** Mutes the siren of every sounding alarm event; the alarm stays active. Throws when nothing is sounding. */
  silence(options: { source?: SecurityEventSource; sourceUserId?: string | null } = {}): AlarmEvent[] {
    const silenced = this.options.alarmEvents?.silence() ?? [];
    if (silenced.length === 0) {
      throw new PanelStateError('No siren is sounding.');
    }
    this.eventRepo.record({
      type: 'siren_silenced',
      source: options.source ?? 'user',
      sourceUserId: options.sourceUserId ?? null,
      details: `Silenced ${silenced.map((event) => event.type).join(', ')}; the alarm stays active`,
    });
    return silenced;
  }

  private raise(context: TriggerAlarmContext): { panel: AlarmPanel; event: AlarmEvent | null } {
    const type = context.alarm?.type ?? 'BURGLARY';
    const service = context.alarm?.service ?? null;
    const securityEvent = this.eventRepo.record({
      type: 'alarm_triggered',
      source: 'system',
      relatedZoneId: context.relatedZoneId ?? null,
      relatedSensorId: context.relatedSensorId ?? null,
      details: context.details ?? null,
    });
    const event =
      this.options.alarmEvents?.open({
        type,
        service,
        triggerDeviceId: context.relatedSensorId ?? null,
        details: context.details ?? null,
      }) ?? null;

    if (!soundsSiren(type, service)) {
      // Medical, duress and flood/freeze are silent: they open an event but do not put the panel into alarm.
      return { panel: this.panelRepo.getPanel(), event };
    }
    this.clearPendingTimer();
    const panel = this.commitPanel(
      { mode: 'alarm_triggered', pendingDelayEndsAt: null, triggeredBy: securityEvent.id },
      {
        cause: context.relatedSensorId ? 'sensor_alarm' : 'alarm_triggered',
        alarmType: type,
        sensorId: context.relatedSensorId ?? null,
        zoneId: context.relatedZoneId ?? null,
        details: context.details ?? null,
      },
    );
    return { panel, event };
  }

  /**
   * Re-establishes the exit/entry-delay timer for a mode that was persisted across a restart
   * (SC-006). The panel row survives a restart but the `setTimeout` that drives it does not, so
   * without this an `arming` panel never finishes arming and an `alarm_pending` one never escalates
   * to `alarm_triggered`. Call once at start-up, after the `panel_changed` listeners (siren,
   * WebSocket broadcaster) are attached.
   *
   * A delay that already elapsed while the service was down fires on the next tick, so an overdue
   * breach escalates immediately rather than being given a fresh grace period. `alarm_triggered`
   * needs nothing here: the siren re-evaluates the persisted state itself once the Z-Wave driver is
   * ready (src/alarm/siren.ts `sync`).
   */
  resume(): void {
    const panel = this.panelRepo.getPanel();
    const remainingMs = Math.max(0, (panel.pendingDelayEndsAt ?? 0) - Date.now());

    if (panel.mode === 'arming') {
      if (panel.armedMode === null) {
        // A row written before `armed_mode` existed: the target is unknowable. Fail to the state
        // the user can see and re-arm from rather than guessing.
        logger.warn('arming interrupted by a restart with no recorded target mode; falling back to disarmed');
        this.panelRepo.clearDisarmedZones();
        this.commitPanel(
          { mode: 'disarmed', pendingDelayEndsAt: null, triggeredBy: null, armedMode: null, bypassedDeviceIds: [] },
          { cause: 'restart_recovery' },
        );
        return;
      }
      const target = panel.armedMode;
      const context: CommandContext = {
        zoneId: null,
        zoneName: null,
        source: 'system',
        sourceUserId: null,
        clearedBy: null,
        armSource: 'app',
        bypass: [],
        autoBypass: false,
        bypassNote: null,
        bypassedSensors: [],
        actor: null,
        systemEvent: false,
        device: null,
      };
      this.clearPendingTimer();
      this.pendingTimer = setTimeout(() => this.completeArming(target, context), remainingMs);
    } else if (panel.mode === 'alarm_pending') {
      const trigger = panel.triggeredBy ? this.eventRepo.findById(panel.triggeredBy) : undefined;
      const sensor = { id: trigger?.relatedSensorId ?? null, zoneId: trigger?.relatedZoneId ?? null };
      this.clearPendingTimer();
      this.pendingTimer = setTimeout(() => this.completeEntryDelay(sensor), remainingMs);
    }

    logger.info('panel state resumed after restart', { mode: panel.mode, remainingMs });
  }

  /** Cancels any in-flight exit/entry-delay timer without changing state — for graceful shutdown/test teardown. */
  stop(): void {
    this.clearPendingTimer();
  }

  private submit(command: PanelCommand, options: PanelCommandOptions & { zoneId?: string | null }): Promise<AlarmPanel> {
    const request: AlarmCommandRequest = {
      command,
      source: options.source,
      requestedAt: options.requestedAt ?? Date.now(),
    };
    this.commandContext.set(request, {
      zoneId: options.zoneId ?? null,
      zoneName: options.zoneName ?? null,
      source: options.source,
      sourceUserId: options.sourceUserId ?? null,
      clearedBy: options.clearedBy ?? null,
      armSource: options.armSource ?? 'app',
      bypass: options.bypass ?? [],
      autoBypass: options.autoBypass ?? false,
      bypassNote: null,
      bypassedSensors: [],
      actor: options.actor ?? null,
      systemEvent: options.systemEvent ?? false,
      device: options.device ?? null,
    });
    return this.dispatcher.dispatch<AlarmPanel>(request);
  }

  private handleCommand(request: AlarmCommandRequest): AlarmPanel {
    const context = this.commandContext.get(request) ?? {
      zoneId: null,
      zoneName: null,
      source: request.source,
      sourceUserId: null,
      clearedBy: null,
      armSource: 'app' as ArmSource,
      bypass: [],
      autoBypass: false,
      bypassNote: null,
      bypassedSensors: [],
      actor: null,
      systemEvent: false,
      device: null,
    };
    this.commandContext.delete(request);

    switch (request.command as PanelCommand) {
      case 'arm_away':
        return this.beginArming('armed_away', context);
      case 'arm_home':
        return this.beginArming('armed_home', context);
      case 'disarm':
        return this.applyDisarm(context);
      case 'disarm_zone':
        return this.applyZoneDisarm(context);
      default:
        throw new PanelStateError(`Unknown panel command: ${request.command}`);
    }
  }

  private beginArming(targetMode: ArmMode, context: CommandContext): AlarmPanel {
    const current = this.panelRepo.getPanel();
    if (current.mode !== 'disarmed') {
      throw new PanelStateError(`Cannot arm while panel is in mode "${current.mode}"; it must be disarmed first.`);
    }

    const bypassedDeviceIds = this.preArmCheck(targetMode, context);
    this.clearPendingTimer();
    this.panelRepo.clearDisarmedZones(); // a fresh arming covers every zone again
    const exitDelayMs = this.delaysFor(targetMode).exitDelaySec * 1000;
    const panel = this.commitPanel(
      {
        mode: 'arming',
        pendingDelayEndsAt: Date.now() + exitDelayMs,
        triggeredBy: null,
        armedMode: targetMode,
        bypassedDeviceIds,
      },
      {
        cause: 'arm_command',
        targetMode,
        source: context.source,
        armSource: context.armSource,
        sourceUserId: context.sourceUserId,
        bypassedDeviceIds,
      },
    );

    this.pendingTimer = setTimeout(() => this.completeArming(targetMode, context), exitDelayMs);
    for (const sensor of context.bypassedSensors) {
      this.eventRepo.record({
        type: 'bypassed',
        source: eventSource(context.source, context.systemEvent),
        sourceUserId: context.sourceUserId,
        actor: context.actor,
        deviceId: sensor.id,
        deviceName: sensor.name,
        relatedSensorId: sensor.id,
        details: `Bypassed for this arm session${sensor.reason ? ` (${sensor.reason})` : ''}; armed via ${context.armSource}`,
      });
    }
    return panel;
  }

  private completeArming(targetMode: ArmMode, context: CommandContext): void {
    this.pendingTimer = null;
    const current = this.panelRepo.getPanel();
    if (current.mode !== 'arming') {
      return; // Superseded by a disarm during the exit delay.
    }

    this.commitPanel({ mode: targetMode, pendingDelayEndsAt: null }, { cause: 'exit_delay_elapsed' });
    this.eventRepo.record({
      type: 'armed',
      source: eventSource(context.source, context.systemEvent),
      actor: context.actor,
      deviceId: context.device?.id ?? null,
      deviceName: context.device?.name ?? null,
      sourceUserId: context.sourceUserId,
      details: context.bypassNote,
    });
  }

  /**
   * The pre-arm check (Ring spec, Arming): the intrusion sensors armed for `targetMode` that are open or
   * offline are faulted. A `lock`/`schedule` source (or `autoBypass`) bypasses them all; any other source must
   * list every one in `bypass`, otherwise arming is refused with NeedsBypassError and nothing changes. Arming
   * succeeds even if every sensor ends up bypassed. Returns the sensor ids bypassed for this arm session.
   */
  private preArmCheck(targetMode: ArmMode, context: CommandContext): string[] {
    const sensorRepo = this.options.sensorRepo;
    if (!sensorRepo) {
      return [];
    }
    const sensors = sensorRepo.list();

    const unknown = context.bypass.filter(
      (id) => !sensors.some((sensor) => sensor.id === id && sensor.category === 'intrusion'),
    );
    if (unknown.length > 0) {
      throw new UnknownBypassSensorError(unknown);
    }

    const faulted: FaultedSensor[] = [];
    for (const sensor of sensors) {
      const armedForMode = targetMode === 'armed_home' ? sensor.armedHome : sensor.armedAway;
      if (sensor.category !== 'intrusion' || sensor.alertsOnly || !armedForMode) {
        continue;
      }
      const reason: FaultReason | null = sensor.tampered
        ? 'tampered'
        : sensor.connectivityStatus === 'offline'
          ? 'offline'
          : sensor.currentState === 'breached'
            ? 'open'
            : null;
      if (reason !== null) {
        faulted.push({ sensorId: sensor.id, name: sensor.name, zoneId: sensor.zoneId, reason });
      }
    }

    const autoBypass = context.autoBypass || AUTO_BYPASS_SOURCES.has(context.armSource);
    const confirmed = new Set(context.bypass);
    if (!autoBypass && faulted.some((entry) => !confirmed.has(entry.sensorId))) {
      throw new NeedsBypassError(faulted);
    }

    const bypassed = new Set(context.bypass);
    if (autoBypass) {
      faulted.forEach((entry) => bypassed.add(entry.sensorId));
    }
    if (bypassed.size > 0) {
      const label = (id: string): string => {
        const entry = faulted.find((candidate) => candidate.sensorId === id);
        const name = sensors.find((sensor) => sensor.id === id)?.name ?? id;
        return entry ? `${name} (${entry.reason})` : name;
      };
      context.bypassedSensors = [...bypassed].map((id) => ({
        id,
        name: sensors.find((sensor) => sensor.id === id)?.name ?? id,
        reason: faulted.find((candidate) => candidate.sensorId === id)?.reason ?? null,
      }));
      context.bypassNote = `Armed via ${context.armSource}; bypassed ${[...bypassed].map(label).join(', ')}`;
      logger.info('arming with bypassed sensors', { armSource: context.armSource, bypassed: [...bypassed] });
    }
    return [...bypassed];
  }

  private applyDisarm(context: CommandContext): AlarmPanel {
    const current = this.panelRepo.getPanel();
    if (current.mode === 'disarmed') {
      // A silent event (medical, flood) can be open while disarmed; a disarm still closes it.
      this.options.alarmEvents?.endAll();
      return current; // Nothing else to clear; not a state change worth logging.
    }

    this.clearPendingTimer();
    this.panelRepo.clearDisarmedZones();
    this.options.alarmEvents?.endAll();
    const wasAlarm = current.mode === 'alarm_pending' || current.mode === 'alarm_triggered';
    const panel = this.commitPanel(
      { mode: 'disarmed', pendingDelayEndsAt: null, triggeredBy: null, armedMode: null, bypassedDeviceIds: [] },
      {
        cause: wasAlarm ? 'alarm_cleared' : 'disarm_command',
        source: context.source,
        sourceUserId: context.sourceUserId,
      },
    );
    this.eventRepo.record({
      type: wasAlarm ? 'alarm_cleared' : 'disarmed',
      source: eventSource(context.source, context.systemEvent),
      actor: context.actor,
      deviceId: context.device?.id ?? null,
      deviceName: context.device?.name ?? null,
      sourceUserId: context.sourceUserId,
      // Only the alarm-clearing case needs "cleared, and by whom" (User Story 3's second
      // acceptance scenario); a plain disarm from an already-safe state doesn't.
      details: wasAlarm && context.clearedBy ? `Cleared by ${context.clearedBy}` : null,
    });
    return panel;
  }

  private applyZoneDisarm(context: CommandContext): AlarmPanel {
    const zoneId = context.zoneId;
    if (zoneId === null) {
      throw new PanelStateError('A zone is required for a zone-restricted disarm.');
    }
    const current = this.panelRepo.getPanel();
    if (current.mode === 'disarmed') {
      return current; // Nothing is armed, so there is nothing to disarm in this zone.
    }

    this.panelRepo.addDisarmedZone(zoneId, context.sourceUserId);

    const alarming = current.mode === 'alarm_pending' || current.mode === 'alarm_triggered';
    const alarmZoneId =
      alarming && current.triggeredBy ? (this.eventRepo.findById(current.triggeredBy)?.relatedZoneId ?? null) : null;
    const label = context.zoneName ? `Zone "${context.zoneName}"` : 'The guest\'s zone';
    const who = context.clearedBy ? ` by ${context.clearedBy}` : '';

    if (alarming && alarmZoneId === zoneId) {
      // The breach that raised this alarm was in the guest's own zone, so the guest can stand it
      // down. The panel goes back to the armed mode it was in (or disarmed, if a life-safety
      // sensor raised the alarm while the panel was disarmed).
      this.clearPendingTimer();
      this.options.alarmEvents?.endBurglary();
      const next: AlarmMode = current.armedMode ?? 'disarmed';
      if (next === 'disarmed') {
        this.panelRepo.clearDisarmedZones();
      }
      const panel = this.commitPanel(
        { mode: next, pendingDelayEndsAt: null, triggeredBy: null, ...(next === 'disarmed' && { bypassedDeviceIds: [] }) },
        { cause: 'zone_alarm_cleared', zoneId, source: context.source, sourceUserId: context.sourceUserId },
      );
      this.eventRepo.record({
        type: 'alarm_cleared',
        source: eventSource(context.source, context.systemEvent),
      actor: context.actor,
      deviceId: context.device?.id ?? null,
      deviceName: context.device?.name ?? null,
        sourceUserId: context.sourceUserId,
        relatedZoneId: zoneId,
        details: `${label} alarm cleared${who}; the rest of the panel stays armed`,
      });
      return panel;
    }

    this.eventRepo.record({
      type: 'disarmed',
      source: eventSource(context.source, context.systemEvent),
      actor: context.actor,
      deviceId: context.device?.id ?? null,
      deviceName: context.device?.name ?? null,
      sourceUserId: context.sourceUserId,
      relatedZoneId: zoneId,
      details: `${label} disarmed${who}; the rest of the panel stays armed`,
    });
    logger.info('zone disarmed', { zoneId, sourceUserId: context.sourceUserId, panelMode: current.mode });
    // The mode didn't change, but clients need to learn which zones are now disarmed.
    const panel = this.panelRepo.getPanel();
    this.emit('panel_changed', panel);
    return panel;
  }

  /**
   * Burglary-class evaluation order (Ring spec, Triggers), after the panel-level checks:
   * disarmed -> ignore; zone disarmed by a guest -> ignore; sensor not armed for this mode (or alerts-only)
   * -> notify only; exit delay -> no alarm (`arming` is not an armed mode, so it never reaches here);
   * MAIN_DOOR / ENTRYWAY with an entry delay -> start it (once); otherwise -> alarm at once.
   * A second sensor tripping during a running entry delay alarms at once unless it is itself a delayed placement.
   */
  private reportIntrusionBreach(sensor: SensorBreachInput): AlarmPanel {
    const current = this.panelRepo.getPanel();
    if (current.mode !== 'armed_away' && current.mode !== 'armed_home' && current.mode !== 'alarm_pending') {
      return current; // Intrusion sensors are only monitored while armed (FR-003).
    }
    if (current.disarmedZoneIds.includes(sensor.zoneId)) {
      logger.info('intrusion breach ignored: its zone was disarmed by a zone-restricted guest', {
        sensorId: sensor.id,
        zoneId: sensor.zoneId,
      });
      return current;
    }

    if (current.bypassedDeviceIds.includes(sensor.id)) {
      logger.info('intrusion breach ignored: the sensor is bypassed for this arm session', { sensorId: sensor.id });
      return current;
    }

    const armedMode = current.mode === 'alarm_pending' ? current.armedMode : current.mode;
    const armedForMode = armedMode === 'armed_home' ? sensor.armedHome : sensor.armedAway;
    if (sensor.alertsOnly === true || armedForMode === false) {
      logger.info('intrusion breach not armed for this mode: notification only', {
        sensorId: sensor.id,
        mode: armedMode,
        alertsOnly: sensor.alertsOnly === true,
      });
      return current;
    }

    const delayed = sensor.placement === undefined || sensor.placement === null || sensor.placement === 'MAIN_DOOR' || sensor.placement === 'ENTRYWAY';
    const entryDelayMs = armedMode ? this.delaysFor(armedMode).entryDelaySec * 1000 : 0;

    if (current.mode === 'alarm_pending') {
      if (delayed) {
        return current; // The entry delay is already running; it is not restarted.
      }
      return this.triggerAlarm({ relatedZoneId: sensor.zoneId, relatedSensorId: sensor.id });
    }
    if (!delayed || entryDelayMs === 0) {
      return this.triggerAlarm({ relatedZoneId: sensor.zoneId, relatedSensorId: sensor.id });
    }

    this.clearPendingTimer();
    const breachEvent = this.eventRepo.record({
      type: 'breach',
      source: 'system',
      relatedZoneId: sensor.zoneId,
      relatedSensorId: sensor.id,
    });
    const panel = this.commitPanel(
      {
        mode: 'alarm_pending',
        pendingDelayEndsAt: Date.now() + entryDelayMs,
        triggeredBy: breachEvent.id,
      },
      { cause: 'intrusion_breach', sensorId: sensor.id, zoneId: sensor.zoneId },
    );

    this.pendingTimer = setTimeout(() => this.completeEntryDelay(sensor), entryDelayMs);
    return panel;
  }

  private completeEntryDelay(sensor: { id: string | null; zoneId: string | null }): void {
    this.pendingTimer = null;
    const current = this.panelRepo.getPanel();
    if (current.mode !== 'alarm_pending') {
      return; // Disarmed during the entry delay.
    }

    this.triggerAlarm({ relatedZoneId: sensor.zoneId, relatedSensorId: sensor.id });
  }

  /**
   * Persists a panel update, logs the transition (old/new mode and `cause`), and emits
   * 'panel_changed' with the resulting snapshot (e.g. for T026's siren).
   */
  private commitPanel(changes: AlarmPanelUpdate, cause: TransitionCause): AlarmPanel {
    const previousMode = this.panelRepo.getPanel().mode;
    const panel = this.panelRepo.updatePanel(changes);
    logger.info('panel state transition', { from: previousMode, to: panel.mode, ...cause });
    this.emit('panel_changed', panel);
    return panel;
  }

  private clearPendingTimer(): void {
    if (this.pendingTimer) {
      clearTimeout(this.pendingTimer);
      this.pendingTimer = null;
    }
  }
}
