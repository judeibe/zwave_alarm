import type { Driver } from 'zwave-js';
import { setValueFailed } from 'zwave-js';
import { CommandClasses } from '@zwave-js/core';
import { createLogger } from '../config/logger.js';
import type { PanelService } from './panel-service.js';
import { FIXED_SIREN_DURATION_SEC, type SirenDevice, type SirenRepository } from './siren-repository.js';
import type { AlarmEventService } from './alarm-event-service.js';

const logger = createLogger('alarm/siren');

export interface SirenOptions {
  /**
   * Z-Wave node id of a single base siren, used only when no `sirenRepo` is supplied (the siren table
   * supersedes it; src/index.ts seeds the table from `config.sirenNodeId`).
   */
  nodeId: number | null;
  /** When supplied, every enrolled siren is driven, each stopping after its own duration. */
  sirenRepo?: SirenRepository;
  /**
   * When supplied, the sirens follow the alarm events: on while any open event is `sounding`, off when it is
   * silenced, timed out (a siren's own duration) or closed by a disarm. Without it they follow `alarm_triggered`.
   */
  alarmEvents?: AlarmEventService;
}

/**
 * Activates the local sirens the moment an alarm sounds (FR-013: "the local audible siren is the
 * authoritative notification") and turns them off once it clears. Control is via the device's Binary Switch
 * CC target value, the standard on/off surface Z-Wave siren accessories expose.
 *
 * Each siren is switched on once per alarm and stops by itself after its own duration (600 s for a base or
 * dome siren, 60-600 s for an outdoor one); when the last one stops, the sounding events are marked
 * `timed_out` but stay open until a disarm. `driver.controller` throws until the Z-Wave driver finishes
 * starting, which can be after the alarm began (a persisted alarm is restored at boot), so anything that
 * can't be sent yet is applied by `sync()` once the driver is ready.
 */
export class Siren {
  private readonly legacyNodeId: number | null;
  private readonly sirenRepo: SirenRepository | undefined;
  private readonly alarmEvents: AlarmEventService | undefined;
  /** Sirens currently switched on, with the timer that will stop each. */
  private readonly on = new Map<number, NodeJS.Timeout | null>();
  /** Sirens that already ran their full duration in this alarm; they stay off until the alarm clears. */
  private readonly expired = new Set<number>();
  private warnedNoSiren = false;

  constructor(
    private readonly driver: Driver,
    private readonly panelService: PanelService,
    options: SirenOptions,
  ) {
    this.legacyNodeId = options.nodeId;
    this.sirenRepo = options.sirenRepo;
    this.alarmEvents = options.alarmEvents;
    if (this.sirens().length === 0) {
      // FR-013 requires the local siren to be the authoritative notification, so a fresh install
      // with no siren enrolled is a real gap the installer needs to notice, not a silent no-op.
      logger.warn('no siren enrolled — the local siren will not sound when the alarm triggers');
    }
    if (this.alarmEvents) {
      this.alarmEvents.on('alarm_event', () => this.reevaluate());
    } else {
      panelService.on('panel_changed', () => this.reevaluate());
    }
    this.sirenRepo?.on('siren_changed', () => this.reevaluate());
    this.sirenRepo?.on('siren_removed', (nodeId: number) => this.release(nodeId));
  }

  /** Re-evaluates the alarm and sends whatever the sirens still need. Call once when the driver is ready. */
  sync(): void {
    this.reevaluate();
  }

  private sirens(): Pick<SirenDevice, 'nodeId' | 'durationSec'>[] {
    if (this.sirenRepo) {
      return this.sirenRepo.list();
    }
    return this.legacyNodeId === null ? [] : [{ nodeId: this.legacyNodeId, durationSec: FIXED_SIREN_DURATION_SEC }];
  }

  private reevaluate(): void {
    const desired = this.alarmEvents
      ? this.alarmEvents.hasSounding()
      : this.panelService.getState().mode === 'alarm_triggered';

    if (!desired) {
      this.warnedNoSiren = false;
      this.expired.clear();
      for (const nodeId of [...this.on.keys()]) {
        this.release(nodeId);
      }
      return;
    }
    if (this.sirens().length === 0 && !this.warnedNoSiren) {
      this.warnedNoSiren = true;
      logger.warn('alarm sounding but no siren is enrolled');
    }
    const sirens = this.sirens().filter((siren) => !this.on.has(siren.nodeId) && !this.expired.has(siren.nodeId));
    if (sirens.length === 0) {
      return;
    }
    if (!this.driverIsReady()) {
      logger.info('zwave-js driver not ready yet; siren state will be applied once it is', { on: true });
      return;
    }
    for (const siren of sirens) {
      this.on.set(siren.nodeId, this.alarmEvents ? this.startAutoStop(siren) : null);
      void this.setSirenState(siren.nodeId, true);
    }
  }

  /** Switches one siren off and forgets it (alarm cleared, silenced, or the siren was un-enrolled). */
  private release(nodeId: number): void {
    const timer = this.on.get(nodeId);
    if (timer === undefined) {
      return;
    }
    if (timer) {
      clearTimeout(timer);
    }
    this.on.delete(nodeId);
    if (this.driverIsReady()) {
      void this.setSirenState(nodeId, false);
    }
  }

  /** A siren stops by itself after its duration (Ring spec, Sirens); the event stays open until a disarm. */
  private startAutoStop(siren: Pick<SirenDevice, 'nodeId' | 'durationSec'>): NodeJS.Timeout {
    const startedAt = this.alarmEvents?.oldestSoundingStartedAt() ?? Date.now();
    const remainingMs = Math.max(0, startedAt + siren.durationSec * 1000 - Date.now());
    const timer = setTimeout(() => {
      logger.info('siren reached its maximum duration; stopping it', { nodeId: siren.nodeId });
      this.on.delete(siren.nodeId);
      this.expired.add(siren.nodeId);
      void this.setSirenState(siren.nodeId, false);
      if (this.on.size === 0) {
        this.alarmEvents?.timeOutSiren();
      }
    }, remainingMs);
    timer.unref();
    return timer;
  }

  /** `driver.controller` throws until the driver has started (zwave-js's own "not yet ready" guard). */
  private driverIsReady(): boolean {
    try {
      return this.driver.controller !== undefined;
    } catch {
      return false;
    }
  }

  private async setSirenState(nodeId: number, on: boolean): Promise<void> {
    const node = this.driver.controller.nodes.get(nodeId);
    if (!node) {
      logger.error('configured siren node not found on the Z-Wave network', { nodeId });
      return;
    }

    try {
      const result = await node.setValue(
        { commandClass: CommandClasses['Binary Switch'], property: 'targetValue' },
        on,
      );
      if (setValueFailed(result)) {
        logger.error('siren device rejected the activation command', { nodeId, on, status: result.status });
      }
    } catch (err) {
      logger.error('failed to send siren command', {
        nodeId,
        on,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
