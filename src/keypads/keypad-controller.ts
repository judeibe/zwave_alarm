import { createLogger } from '../config/logger.js';
import type { AlarmPanel } from '../alarm/panel-repository.js';
import { PanelStateError, type PanelService } from '../alarm/panel-service.js';
import { CommandRejectedError } from '../alarm/dispatcher.js';
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
}

/**
 * The use case that joins keypads to the alarm panel, expressed only in generic keypad terms:
 * keypad input drives the panel, and panel state is shown back on every keypad. It has no idea
 * which device a keypad is, so supporting a new one never touches this file.
 */
export class KeypadController {
  private readonly now: () => number;

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
      void this.keypads.indicateAll(this.indicationFor(panel));
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
      // The keypad's confirm-bypass prompt (the Gen1 check key) is not built yet, so until then a keypad arm
      // bypasses faulted sensors rather than leaving the keypad unable to arm with a door open.
      await this.panelService.arm(mode, {
        source: 'native',
        sourceUserId: user?.id ?? null,
        armSource: 'keypad',
        autoBypass: true,
      });
    } catch (err) {
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
        return { kind: 'alarm' };
    }
  }
}
