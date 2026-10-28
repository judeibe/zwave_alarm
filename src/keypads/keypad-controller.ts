import { createLogger } from '../config/logger.js';
import type { AlarmPanel } from '../alarm/panel-repository.js';
import { NeedsBypassError, PanelStateError, type PanelService, type SensorBreachInput } from '../alarm/panel-service.js';
import { CommandRejectedError } from '../alarm/dispatcher.js';
import type { AlarmEventService } from '../alarm/alarm-event-service.js';
import { isWithinSchedules, type GuestScheduleRepository } from '../auth/guest-schedule.js';
import { isExpired, type User, type UserRepository } from '../auth/user-repository.js';
import type { LockoutService } from '../auth/lockout-service.js';
import type { EventRepository } from '../events/event-repository.js';
import type { ZoneRepository } from '../db/repositories/zone-repository.js';
import type { KeypadIndication } from './keypad.js';
import type { KeypadInputEvent, KeypadService, KeypadSummary } from './keypad-service.js';

const logger = createLogger('keypads/controller');

export interface KeypadControllerOptions {
  /** Read on every arm: when true, arming from a keypad needs a valid user code too. */
  requireCodeToArm: () => boolean;
  /** Clock, injectable so the delay countdown is testable. */
  now?: () => number;
  /** When supplied, a guest's code works at the keypad only inside one of their schedules (none = always). */
  guestSchedules?: GuestScheduleRepository;
  /**
   * When supplied, the keypad siren follows the alarm events (on while one is sounding; off when it is silenced,
   * times out or a disarm ends it) instead of the panel's `alarm_triggered` mode.
   */
  alarmEvents?: AlarmEventService;
  /** Level (0-99) for sensor chirps; read when each chirp plays. */
  chirpVolume?: () => number;
}

/** How long after a "bypass needed" prompt the same arm request, repeated, confirms the bypass. */
export const BYPASS_CONFIRM_WINDOW_MS = 10_000;

/** A "bypass needed" prompt waiting for the arm request to be repeated. */
interface PendingBypass {
  mode: 'armed_away' | 'armed_home';
  /** Who asked (null when arming needs no code). The confirming request must be from the same user. */
  userId: string | null;
  sensorIds: string[];
  expiresAt: number;
}

/**
 * The use case that joins keypads to the alarm panel, expressed only in generic keypad terms:
 * keypad input drives the panel, and panel state is shown back on every keypad. It has no idea
 * which device a keypad is, so supporting a new one never touches this file.
 */
export class KeypadController {
  private readonly now: () => number;
  /** Whether the keypads' own siren is currently on, so it is only switched when that changes. */
  private sirenOn = false;
  private pendingBypass: PendingBypass | null = null;

  constructor(
    private readonly keypads: KeypadService,
    private readonly panelService: PanelService,
    private readonly userRepo: UserRepository,
    private readonly lockoutService: LockoutService,
    private readonly eventRepo: EventRepository,
    private readonly zoneRepo: ZoneRepository,
    private readonly options: KeypadControllerOptions,
  ) {
    this.now = options.now ?? Date.now;
  }

  /** Starts listening to keypad input and to panel changes. */
  start(): void {
    this.keypads.on('keypad_input', (event: KeypadInputEvent) => {
      void this.handleInput(event).catch((err: unknown) => {
        logger.error('keypad input handling failed', {
          nodeId: event.nodeId,
          kind: event.input.kind,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    });
    this.panelService.on('panel_changed', (panel: AlarmPanel) => {
      void this.show(this.indicationFor(panel));
    });
    // The keypad siren follows the alarm events: silenced, timed out or ended means off, even while the panel
    // stays in alarm. A silent event (medical, duress, flood) never turns it on.
    this.options.alarmEvents?.on('alarm_event', () => {
      if (this.isSounding() !== this.sirenOn) {
        void this.show(this.indicationFor(this.panelService.getState()));
      }
    });
    // A tripped sensor chirps on the keypads, if the current mode has chirps on and the sensor has a tone.
    this.panelService.on('sensor_tripped', (sensor: SensorBreachInput, panel: AlarmPanel) => {
      void this.chirp(sensor, panel);
    });
    // A keypad that appears, or comes back online, shows the current panel state straight away.
    this.keypads.on('keypad_changed', (keypad: KeypadSummary) => {
      if (keypad.connectivityStatus === 'online') {
        void this.keypads.indicate(keypad.nodeId, this.indicationFor(this.panelService.getState()));
      }
    });
  }

  private async handleInput({ nodeId, input }: KeypadInputEvent): Promise<void> {
    switch (input.kind) {
      case 'code_entered':
        // Entering a code and pressing Enter is how a keypad disarms; with nothing to disarm it is a no-op,
        // except for a duress code, which raises its silent alarm even when the panel is already disarmed.
        if (
          this.panelService.getState().mode !== 'disarmed' ||
          (input.code !== undefined && this.userRepo.findByDuressCode(input.code) !== undefined)
        ) {
          await this.disarm(nodeId, input.code);
        }
        return;
      case 'disarm':
        await this.disarm(nodeId, input.code);
        return;
      case 'arm_away':
      case 'arm_home':
        await this.arm(nodeId, input.kind === 'arm_away' ? 'armed_away' : 'armed_home', input.code);
        return;
      case 'emergency':
this.panelService.raiseEmergency(
          input.emergency === 'fire' ? 'FIRE' : input.emergency === 'medical' ? 'MEDICAL' : 'PANIC',
          { details: `${input.emergency} button pressed on keypad (node ${String(nodeId)})` },
        );
        return;
      case 'cancel':
        return;
    }
  }

  private async arm(nodeId: number, mode: 'armed_away' | 'armed_home', code: string | undefined): Promise<void> {
    let user: User | undefined;
    if (this.options.requireCodeToArm()) {
      const auth = this.authenticate(code);
      if (!auth || auth.duress) {
        await this.reject(nodeId, 'arm'); // a duress code only disarms
        return;
      }
      user = auth.user;
    }
    try {
      // A repeat of the same arm request within the confirm window, from the same user, accepts the bypass of
      // the sensors the keypad just asked about. (The Gen2 keypad has no check key; this repeat is the confirm.)
      const pending = this.pendingBypass;
      const confirming =
        pending !== null && pending.expiresAt > this.now() && pending.mode === mode && pending.userId === (user?.id ?? null);
      this.pendingBypass = null;
      await this.panelService.arm(mode, {
        source: 'native',
        sourceUserId: user?.id ?? null,
        armSource: 'keypad',
        ...(confirming && pending && { bypass: pending.sensorIds }),
      });
    } catch (err) {
      if (err instanceof NeedsBypassError) {
        this.pendingBypass = {
          mode,
          userId: user?.id ?? null,
          sensorIds: err.faulted.map((entry) => entry.sensorId),
          expiresAt: this.now() + BYPASS_CONFIRM_WINDOW_MS,
        };
        logger.info('keypad arm needs a bypass; waiting for it to be repeated', {
          nodeId,
          sensors: err.faulted.map((entry) => entry.name),
        });
        await this.keypads.indicate(nodeId, { kind: 'bypass_required' });
        return;
      }
      if (!this.isExpectedRefusal(err)) throw err;
      logger.info('keypad arm request refused', { nodeId, reason: err.message });
    }
  }

  private async disarm(nodeId: number, code: string | undefined): Promise<void> {
    const auth = this.authenticate(code);
    if (!auth) {
      await this.reject(nodeId, 'disarm');
      return;
    }
    const { user, duress } = auth;

    try {
      if (user.role === 'guest') {
        // FR-011: a guest code being used is itself a security-relevant event.
        this.eventRepo.record({
          type: 'guest_code_used',
          source: 'user',
          sourceUserId: user.id,
          relatedZoneId: user.guestZoneId,
          details: user.guestZoneId === null ? 'Guest code used to disarm' : 'Zone-restricted guest code used to disarm',
        });
      }
      if (user.role === 'guest' && user.guestZoneId !== null) {
        // FR-010a: a zone-restricted guest only disarms their own zone, never the whole panel.
        const zoneName = this.zoneRepo.list().find((zone) => zone.id === user.guestZoneId)?.name ?? null;
        await this.panelService.disarmZone(user.guestZoneId, {
          source: 'native',
          sourceUserId: user.id,
          clearedBy: user.name,
          zoneName,
        });
        return;
      }
      await this.panelService.disarm({ source: 'native', sourceUserId: user.id, clearedBy: user.name });
      if (duress) {
        // Disarms visibly, then quietly requests the police (Ring spec, Access: duress code).
        this.panelService.raiseDuress(`Duress code used by ${user.name} on keypad (node ${String(nodeId)})`);
      }
    } catch (err) {
      if (!this.isExpectedRefusal(err)) throw err;
      logger.info('keypad disarm request refused', { nodeId, reason: err.message });
    }
  }

  /**
   * Resolves a typed code to a user who may act right now, or undefined.
   *
   * A keypad sends only the code, not who typed it, so the user is found by matching the code.
   * That means a *wrong* code cannot be charged to anyone's failed-attempt count (there is no one
   * to charge it to), unlike the REST disarm which already knows who is calling. A matching but
   * locked or expired user is refused like a wrong code.
   */
  private authenticate(code: string | undefined): { user: User; duress: boolean } | undefined {
    if (code === undefined) {
      return undefined;
    }
    const normal = this.userRepo.findByCode(code);
    const user = normal ?? this.userRepo.findByDuressCode(code);
    if (!user) {
      logger.warn('keypad code not recognised');
      return undefined;
    }
    const duress = normal === undefined;
    if (this.lockoutService.isLocked(user)) {
      logger.warn('keypad code rejected: account locked', { userId: user.id });
      return undefined;
    }
    if (isExpired(user, this.now())) {
      logger.warn('keypad code rejected: access expired', { userId: user.id, role: user.role });
      return undefined;
    }
    if (user.role === 'guest' && this.options.guestSchedules) {
      if (!isWithinSchedules(this.options.guestSchedules.listForUser(user.id), this.now())) {
        // Rejected like a wrong code, but recorded so the owner and shared users are told (Ring spec, Access).
        logger.warn('keypad code rejected: guest is outside their schedule', { userId: user.id });
        this.eventRepo.record({
          type: 'guest_code_used',
          source: 'user',
          sourceUserId: user.id,
          relatedZoneId: user.guestZoneId,
          details: `Guest ${user.name} tried to use their code outside their schedule`,
        });
        return undefined;
      }
    }
    this.userRepo.resetFailedAttempts(user.id);
    return { user, duress };
  }

  private async reject(nodeId: number, action: 'arm' | 'disarm'): Promise<void> {
    logger.warn('keypad request rejected', { nodeId, action });
    await this.keypads.indicate(nodeId, { kind: 'code_rejected' });
  }

  /** Errors that mean "not now" (already armed, beaten by a native command), as opposed to a bug. */
  private isExpectedRefusal(err: unknown): err is PanelStateError | CommandRejectedError {
    return err instanceof PanelStateError || err instanceof CommandRejectedError;
  }

  private indicationFor(panel: AlarmPanel): KeypadIndication {
    const secondsLeft = Math.max(1, Math.ceil(((panel.pendingDelayEndsAt ?? this.now()) - this.now()) / 1000));
    switch (panel.mode) {
      case 'disarmed':
        return { kind: 'mode', mode: 'disarmed' };
      case 'armed_home':
        return { kind: 'mode', mode: 'armed_home' };
      case 'armed_away':
        return { kind: 'mode', mode: 'armed_away' };
      case 'arming':
        return { kind: 'exit_delay', seconds: secondsLeft };
      case 'alarm_pending':
        return { kind: 'entry_delay', seconds: secondsLeft };
      case 'alarm_triggered':
        // Alarm, but with the siren silenced or timed out the keypad goes back to showing the armed mode.
        return this.isSounding()
          ? { kind: 'alarm' }
          : { kind: 'mode', mode: panel.armedMode ?? 'disarmed' };
    }
  }

  /** Whether an alarm is making noise now (the panel's alarm state when alarm events are not tracked). */
  private isSounding(): boolean {
    return this.options.alarmEvents
      ? this.options.alarmEvents.hasSounding()
      : this.panelService.getState().mode === 'alarm_triggered';
  }

  /** Shows an indication on every keypad, stopping their siren first if it was on and this isn't the alarm. */
  private async show(indication: KeypadIndication): Promise<void> {
    if (indication.kind === 'alarm') {
      if (this.sirenOn) {
        return;
      }
      this.sirenOn = true;
    } else if (this.sirenOn) {
      this.sirenOn = false;
      await this.keypads.indicateAll({ kind: 'alarm_off' });
    }
    await this.keypads.indicateAll(indication);
  }

  private async chirp(sensor: SensorBreachInput, panel: AlarmPanel): Promise<void> {
    const mode = panel.mode === 'disarmed' || panel.mode === 'armed_home' || panel.mode === 'armed_away' ? panel.mode : null;
    const tone = sensor.chirpTone;
    // Not during a delay or an alarm (the delay tones and the siren already speak), and not for a muted sensor.
    if (mode === null || sensor.category !== 'intrusion' || sensor.chimeEnabled === false || !tone || tone === 'none') {
      return;
    }
    if (!this.panelService.getModes()[mode].chirpsEnabled) {
      return;
    }
    await this.keypads.chimeAll(tone, this.options.chirpVolume?.());
  }
}
