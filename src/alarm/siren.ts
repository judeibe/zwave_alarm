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
 * `this.active` so a burst of unrelated panel_changed events (e.g. an
 * unrelated disarm while already disarmed) never re-sends a redundant
 * command to the device.
 */
export class Siren {
  private readonly nodeId: number | null;
  private active = false;

  constructor(
    private readonly driver: Driver,
    panelService: PanelService,
    options: SirenOptions,
  ) {
    this.nodeId = options.nodeId;
    panelService.on('panel_changed', (panel: AlarmPanel) => this.handlePanelChanged(panel));
  }

  private handlePanelChanged(panel: AlarmPanel): void {
    const shouldBeActive = panel.mode === 'alarm_triggered';
    if (shouldBeActive === this.active) {
      return;
    }
    this.active = shouldBeActive;
    void this.setSirenState(shouldBeActive);
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
