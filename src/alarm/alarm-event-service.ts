import { EventEmitter } from 'node:events';
import { createLogger } from '../config/logger.js';
import {
  type AlarmEvent,
  type AlarmEventRepository,
  type AlarmEventType,
  type DispatchState,
  type EmergencyService,
  type SirenState,
} from './alarm-event-repository.js';

const logger = createLogger('alarm/events');

/** BURGLARY and SMOKE signals are held this long so a disarm can cancel them (Ring spec, Timers). */
export const CANCEL_WINDOW_MS = 30_000;
/** The base siren stops by itself after this long; the event stays open until a disarm (Ring spec, Sirens). */
export const SIREN_DURATION_MS = 600_000;

const CANCELLABLE: ReadonlySet<AlarmEventType> = new Set(['BURGLARY', 'SMOKE']);

export interface OpenAlarmInput {
  type: AlarmEventType;
  service?: EmergencyService | null;
  triggerDeviceId?: string | null;
  details?: string | null;
}

/** Whether an event of this type sounds the siren (Ring spec, Events and Sirens: Medical, Duress, Flood are silent). */
export function soundsSiren(type: AlarmEventType, service: EmergencyService | null): boolean {
  if (type === 'FIRE_MEDICAL') {
    return service !== 'medical';
  }
  return type !== 'DURESS' && type !== 'FLOOD_FREEZE';
}

function initialDispatch(type: AlarmEventType): DispatchState {
  if (type === 'FLOOD_FREEZE') {
    return 'none';
  }
  return CANCELLABLE.has(type) ? 'held' : 'queued';
}

/**
 * Owns the alarm event lifecycle (Ring spec, Events): create with the type's siren and dispatch policy,
 * hold a BURGLARY / SMOKE signal for the 30 s cancel window, silence and time out the siren, and close the
 * events on disarm. Emits `'alarm_event'` (the AlarmEvent) on every change so the siren and the WebSocket
 * stream follow without polling.
 */
export class AlarmEventService extends EventEmitter {
  private readonly releaseTimers = new Map<string, NodeJS.Timeout>();

  constructor(private readonly repo: AlarmEventRepository) {
    super();
  }

  open(input: OpenAlarmInput): AlarmEvent {
    const service = input.service ?? null;
    const dispatchState = initialDispatch(input.type);
    const event = this.repo.create({
      type: input.type,
      service,
      triggerDeviceId: input.triggerDeviceId ?? null,
      sirenState: soundsSiren(input.type, service) ? 'sounding' : 'none',
      dispatchState,
      dispatchReleaseAt: dispatchState === 'held' ? Date.now() + CANCEL_WINDOW_MS : null,
      details: input.details ?? null,
    });
    logger.info('alarm event opened', { id: event.id, type: event.type, service, dispatchState });
    if (dispatchState === 'held') {
      this.scheduleRelease(event.id, CANCEL_WINDOW_MS);
    }
    this.emit('alarm_event', event);
    return event;
  }

  /** Events no disarm has closed yet, newest first. */
  listActive(): AlarmEvent[] {
    return this.repo.list({ activeOnly: true });
  }

  list(options: { activeOnly?: boolean; limit?: number } = {}): AlarmEvent[] {
    return this.repo.list(options);
  }

  /** True while any open event wants the siren on. */
  hasSounding(): boolean {
    return this.listActive().some((event) => event.sirenState === 'sounding');
  }

  /** When the oldest sounding event began, for the siren's auto-stop timer; null when nothing is sounding. */
  oldestSoundingStartedAt(): number | null {
    const sounding = this.listActive().filter((event) => event.sirenState === 'sounding');
    return sounding.length === 0 ? null : Math.min(...sounding.map((event) => event.startedAt));
  }

  /** Mutes the siren of every sounding event; the alarm stays open and monitoring continues. */
  silence(): AlarmEvent[] {
    return this.moveSounding('silenced');
  }

  /** The siren ran its full duration; the events stay open until a disarm. */
  timeOutSiren(): AlarmEvent[] {
    return this.moveSounding('timed_out');
  }

  /**
   * A disarm closes every open event and stops its siren. BURGLARY and SMOKE signals still inside the cancel
   * window are cancelled; CO, DURESS and SOS keep their dispatch (Ring spec, Modes: they cannot be cancelled).
   */
  endAll(): AlarmEvent[] {
    const now = Date.now();
    const ended: AlarmEvent[] = [];
    for (const event of this.listActive()) {
      this.clearRelease(event.id);
      const cancelled = event.dispatchState === 'held' && CANCELLABLE.has(event.type);
      const updated = this.repo.update(event.id, {
        endedAt: now,
        sirenState: event.sirenState === 'sounding' || event.sirenState === 'silenced' ? 'stopped' : event.sirenState,
        dispatchState: cancelled ? 'cancelled' : event.dispatchState === 'held' ? 'queued' : event.dispatchState,
        cancelledAt: cancelled ? now : null,
      });
      ended.push(updated);
      this.emit('alarm_event', updated);
    }
    return ended;
  }

  /** Closes the open BURGLARY events (a zone-restricted guest standing down their own zone's alarm). */
  endBurglary(): AlarmEvent[] {
    const burglary = this.listActive().filter((event) => event.type === 'BURGLARY');
    if (burglary.length === 0) {
      return [];
    }
    const now = Date.now();
    return burglary.map((event) => {
      this.clearRelease(event.id);
      const cancelled = event.dispatchState === 'held';
      const updated = this.repo.update(event.id, {
        endedAt: now,
        sirenState: event.sirenState === 'sounding' || event.sirenState === 'silenced' ? 'stopped' : event.sirenState,
        dispatchState: cancelled ? 'cancelled' : event.dispatchState,
        cancelledAt: cancelled ? now : null,
      });
      this.emit('alarm_event', updated);
      return updated;
    });
  }

  /**
   * Call once at start-up: re-arms the cancel-window timers that were running when the service stopped, and
   * times out a siren that had already run its full duration while it was down.
   */
  resume(): void {
    const now = Date.now();
    for (const { event, releaseAt } of this.repo.listHeld()) {
      this.scheduleRelease(event.id, Math.max(0, releaseAt - now));
    }
    for (const event of this.listActive()) {
      if (event.sirenState === 'sounding' && now - event.startedAt >= SIREN_DURATION_MS) {
        this.emit('alarm_event', this.repo.update(event.id, { sirenState: 'timed_out' }));
      }
    }
  }

  stop(): void {
    this.releaseTimers.forEach((timer) => clearTimeout(timer));
    this.releaseTimers.clear();
  }

  private moveSounding(next: SirenState): AlarmEvent[] {
    const moved = this.listActive()
      .filter((event) => event.sirenState === 'sounding')
      .map((event) => this.repo.update(event.id, { sirenState: next }));
    moved.forEach((event) => this.emit('alarm_event', event));
    return moved;
  }

  private scheduleRelease(id: string, delayMs: number): void {
    this.clearRelease(id);
    const timer = setTimeout(() => {
      this.releaseTimers.delete(id);
      const event = this.repo.findById(id);
      if (event?.dispatchState !== 'held') {
        return; // Cancelled by a disarm in the meantime.
      }
      this.emit('alarm_event', this.repo.update(id, { dispatchState: 'queued' }));
    }, delayMs);
    timer.unref();
    this.releaseTimers.set(id, timer);
  }

  private clearRelease(id: string): void {
    const timer = this.releaseTimers.get(id);
    if (timer) {
      clearTimeout(timer);
      this.releaseTimers.delete(id);
    }
  }
}
