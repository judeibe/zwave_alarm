import type { Driver } from 'zwave-js';
import { setValueFailed } from 'zwave-js';
import { CommandClasses } from '@zwave-js/core';
import { createLogger } from '../config/logger.js';
import type { AlarmPanel } from './panel-repository.js';
import type { PanelService } from './panel-service.js';

const logger = createLogger('alarm/siren');

export interface SirenOptions {
  /** Z-Wave node id of the configured siren/alert device, from `config.sirenNodeId`. Null if none is paired yet. */
  nodeId: number | null;
}

/**
 * Activates the local audible siren the moment the panel service (T023)
 * transitions to `alarm_triggered` (FR-013: "the local audible siren is the
 * authoritative notification"), and turns it back off once the alarm clears
 * (any other mode) — subscribing to `PanelService`'s `'panel_changed'` event
 * rather than polling.
 *
 * Control is via the device's Binary Switch CC target value, the standard
 * on/off surface Z-Wave siren/strobe accessories expose. Edge-triggered on
 * `this.applied` so a burst of unrelated panel_changed events (e.g. an
 * unrelated disarm while already disarmed) never re-sends a redundant
 * command to the device.
 *
 * `driver.controller` throws until the Z-Wave driver finishes starting, which
 * can be after the panel already changed: a persisted `alarm_triggered` is
 * restored at boot, and an entry delay that elapsed while the service was down
 * escalates immediately. So the desired state is tracked separately from what
 * has been sent, and anything that can't be sent yet is applied by `sync()`
 * once the driver is ready.
 */
export class Siren {
  private readonly nodeId: number | null;
  /** What the panel currently calls for (siren on while `alarm_triggered`). */
  private desired = false;
  /** What has actually been sent to the device. */
  private applied = false;

  constructor(
    private readonly driver: Driver,
    private readonly panelService: PanelService,
    options: SirenOptions,
  ) {
    this.nodeId = options.nodeId;
    if (this.nodeId === null) {
      // FR-013 requires the local siren to be the authoritative notification, so a fresh install
      // with no SIREN_NODE_ID set is a real gap the installer needs to notice, not a silent no-op.
      logger.warn(
        'no siren device configured (SIREN_NODE_ID unset) — the local siren will not sound when the alarm triggers',
      );
    }
    panelService.on('panel_changed', (panel: AlarmPanel) => this.handlePanelChanged(panel));
  }

  /**
   * Re-evaluates the panel's current state and sends the siren command if it differs from what was
   * last sent. Call once when the Z-Wave driver becomes ready (src/index.ts) so a siren state that
   * had to wait for it — notably an `alarm_triggered` restored after a restart — takes effect.
   */
  sync(): void {
    this.desired = this.panelService.getState().mode === 'alarm_triggered';
    this.apply();
  }

  private handlePanelChanged(panel: AlarmPanel): void {
    this.desired = panel.mode === 'alarm_triggered';
    this.apply();
  }

  private apply(): void {
    if (this.desired === this.applied) {
      return;
    }
    if (!this.driverIsReady()) {
      logger.info('zwave-js driver not ready yet; siren state will be applied once it is', { on: this.desired });
      return;
    }
    this.applied = this.desired;
    void this.setSirenState(this.desired);
  }

  /** `driver.controller` throws until the driver has started (zwave-js's own "not yet ready" guard). */
  private driverIsReady(): boolean {
    try {
      return this.driver.controller !== undefined;
    } catch {
      return false;
    }
  }

  private async setSirenState(on: boolean): Promise<void> {
    if (this.nodeId === null) {
      if (on) {
        logger.warn('alarm triggered but no siren device is configured (SIREN_NODE_ID unset)');
      }
      return;
    }

    const node = this.driver.controller.nodes.get(this.nodeId);
    if (!node) {
      logger.error('configured siren node not found on the Z-Wave network', { nodeId: this.nodeId });
      return;
    }

    try {
      const result = await node.setValue(
        { commandClass: CommandClasses['Binary Switch'], property: 'targetValue' },
        on,
      );
      if (setValueFailed(result)) {
        logger.error('siren device rejected the activation command', {
          nodeId: this.nodeId,
          on,
          status: result.status,
        });
      }
    } catch (err) {
      logger.error('failed to send siren command', {
        nodeId: this.nodeId,
        on,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
