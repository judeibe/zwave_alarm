import { AlarmCommandDispatcher, type AlarmCommandRequest, type CommandSource } from './dispatcher.js';
import { AlarmPanelRepository, type AlarmMode, type AlarmPanel } from './panel-repository.js';
import { EventRepository } from '../events/event-repository.js';
import type { SensorDevice } from '../db/repositories/sensor-repository.js';

export type ArmMode = Extract<AlarmMode, 'armed_away' | 'armed_home'>;

/** Thrown when a command is requested from a panel mode that doesn't support it (e.g. arming while already armed). */
export class PanelStateError extends Error {}

export interface PanelCommandOptions {
  source: CommandSource;
  requestedAt?: number;
  /** The authenticated user who issued the command, if any (null for e.g. a schedule). */
  sourceUserId?: string | null;
}

export type SensorBreachInput = Pick<SensorDevice, 'id' | 'zoneId' | 'category'>;

export interface TriggerAlarmContext {
  relatedZoneId?: string | null;
  relatedSensorId?: string | null;
  details?: string | null;
}

const DEFAULT_EXIT_DELAY_MS = 30_000;
const DEFAULT_ENTRY_DELAY_MS = 30_000;

interface CommandContext {
  source: CommandSource;
  sourceUserId: string | null;
}

type PanelCommand = 'arm_away' | 'arm_home' | 'disarm';

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
 */
export class PanelService {
  private readonly dispatcher: AlarmCommandDispatcher;
  private readonly commandContext = new WeakMap<AlarmCommandRequest, CommandContext>();
  private readonly exitDelayMs: number;
  private readonly entryDelayMs: number;
  private pendingTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly panelRepo: AlarmPanelRepository,
    private readonly eventRepo: EventRepository,
    options: { exitDelayMs?: number; entryDelayMs?: number; dispatcherWindowMs?: number } = {},
  ) {
    this.exitDelayMs = options.exitDelayMs ?? DEFAULT_EXIT_DELAY_MS;
    this.entryDelayMs = options.entryDelayMs ?? DEFAULT_ENTRY_DELAY_MS;
    this.dispatcher = new AlarmCommandDispatcher((command) => this.handleCommand(command), {
      windowMs: options.dispatcherWindowMs,
    });
  }

  getState(): AlarmPanel {
    return this.panelRepo.getPanel();
  }

  /** disarmed → arming (exit delay starts); resolves once the delay elapses and armed_away/armed_home is committed. */
  arm(mode: ArmMode, options: PanelCommandOptions): Promise<AlarmPanel> {
    return this.submit(mode === 'armed_away' ? 'arm_away' : 'arm_home', options);
  }

  /** arming/armed_away/armed_home/alarm_pending/alarm_triggered → disarmed on a valid disarm code (validated by the caller). */
  disarm(options: PanelCommandOptions): Promise<AlarmPanel> {
    return this.submit('disarm', options);
  }

  /** Intrusion sensors are armed-state-gated (FR-003); life-safety sensors always trigger immediately (FR-015). */
  reportSensorBreach(sensor: SensorBreachInput): AlarmPanel {
    if (sensor.category === 'life-safety') {
      return this.triggerAlarm({ relatedZoneId: sensor.zoneId, relatedSensorId: sensor.id });
    }
    return this.reportIntrusionBreach(sensor);
  }

  /**
   * Any mode → alarm_triggered immediately, bypassing delays (FR-015). Used
   * directly for life-safety sensors and, in a later phase, by the
   * lockout-policy's `trigger_alarm` mode (FR-016).
   */
  triggerAlarm(context: TriggerAlarmContext = {}): AlarmPanel {
    this.clearPendingTimer();
    const event = this.eventRepo.record({
      type: 'alarm_triggered',
      source: 'system',
      relatedZoneId: context.relatedZoneId ?? null,
      relatedSensorId: context.relatedSensorId ?? null,
      details: context.details ?? null,
    });
    return this.panelRepo.updatePanel({ mode: 'alarm_triggered', pendingDelayEndsAt: null, triggeredBy: event.id });
  }

  /** Cancels any in-flight exit/entry-delay timer without changing state — for graceful shutdown/test teardown. */
  stop(): void {
    this.clearPendingTimer();
  }

  private submit(command: PanelCommand, options: PanelCommandOptions): Promise<AlarmPanel> {
    const request: AlarmCommandRequest = {
      command,
      source: options.source,
      requestedAt: options.requestedAt ?? Date.now(),
    };
    this.commandContext.set(request, { source: options.source, sourceUserId: options.sourceUserId ?? null });
    return this.dispatcher.dispatch<AlarmPanel>(request);
  }

  private handleCommand(request: AlarmCommandRequest): AlarmPanel {
    const context = this.commandContext.get(request) ?? { source: request.source, sourceUserId: null };
    this.commandContext.delete(request);

    switch (request.command as PanelCommand) {
      case 'arm_away':
        return this.beginArming('armed_away', context);
      case 'arm_home':
        return this.beginArming('armed_home', context);
      case 'disarm':
        return this.applyDisarm(context);
      default:
        throw new PanelStateError(`Unknown panel command: ${request.command}`);
    }
  }

  private beginArming(targetMode: ArmMode, context: CommandContext): AlarmPanel {
    const current = this.panelRepo.getPanel();
    if (current.mode !== 'disarmed') {
      throw new PanelStateError(`Cannot arm while panel is in mode "${current.mode}"; it must be disarmed first.`);
    }

    this.clearPendingTimer();
    const panel = this.panelRepo.updatePanel({
      mode: 'arming',
      pendingDelayEndsAt: Date.now() + this.exitDelayMs,
      triggeredBy: null,
    });

    this.pendingTimer = setTimeout(() => this.completeArming(targetMode, context), this.exitDelayMs);
    return panel;
  }

  private completeArming(targetMode: ArmMode, context: CommandContext): void {
    this.pendingTimer = null;
    const current = this.panelRepo.getPanel();
    if (current.mode !== 'arming') {
      return; // Superseded by a disarm during the exit delay.
    }

    this.panelRepo.updatePanel({ mode: targetMode, pendingDelayEndsAt: null });
    this.eventRepo.record({
      type: 'armed',
      source: context.source === 'home_assistant' ? 'home_assistant' : 'user',
      sourceUserId: context.sourceUserId,
    });
  }

  private applyDisarm(context: CommandContext): AlarmPanel {
    const current = this.panelRepo.getPanel();
    if (current.mode === 'disarmed') {
      return current; // Nothing to clear; not a state change worth logging.
    }

    this.clearPendingTimer();
    const wasAlarm = current.mode === 'alarm_pending' || current.mode === 'alarm_triggered';
    const panel = this.panelRepo.updatePanel({ mode: 'disarmed', pendingDelayEndsAt: null, triggeredBy: null });
    this.eventRepo.record({
      type: wasAlarm ? 'alarm_cleared' : 'disarmed',
      source: context.source === 'home_assistant' ? 'home_assistant' : 'user',
      sourceUserId: context.sourceUserId,
    });
    return panel;
  }

  private reportIntrusionBreach(sensor: SensorBreachInput): AlarmPanel {
    const current = this.panelRepo.getPanel();
    if (current.mode !== 'armed_away' && current.mode !== 'armed_home') {
      return current; // Intrusion sensors are only monitored while armed (FR-003).
    }

    this.clearPendingTimer();
    const breachEvent = this.eventRepo.record({
      type: 'breach',
      source: 'system',
      relatedZoneId: sensor.zoneId,
      relatedSensorId: sensor.id,
    });
    const panel = this.panelRepo.updatePanel({
      mode: 'alarm_pending',
      pendingDelayEndsAt: Date.now() + this.entryDelayMs,
      triggeredBy: breachEvent.id,
    });

    this.pendingTimer = setTimeout(() => this.completeEntryDelay(sensor), this.entryDelayMs);
    return panel;
  }

  private completeEntryDelay(sensor: SensorBreachInput): void {
    this.pendingTimer = null;
    const current = this.panelRepo.getPanel();
    if (current.mode !== 'alarm_pending') {
      return; // Disarmed during the entry delay.
    }

    const event = this.eventRepo.record({
      type: 'alarm_triggered',
      source: 'system',
      relatedZoneId: sensor.zoneId,
      relatedSensorId: sensor.id,
    });
    this.panelRepo.updatePanel({ mode: 'alarm_triggered', pendingDelayEndsAt: null, triggeredBy: event.id });
  }

  private clearPendingTimer(): void {
    if (this.pendingTimer) {
      clearTimeout(this.pendingTimer);
      this.pendingTimer = null;
    }
  }
}
