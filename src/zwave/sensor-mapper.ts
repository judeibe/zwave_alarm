import { EventEmitter } from 'node:events';
import type {
  Driver,
  ZWaveNode,
  ZWaveNotificationCallback,
  ZWaveNotificationCallbackArgs_NotificationCC,
  ZWaveNodeValueUpdatedArgs,
} from 'zwave-js';
import { CommandClasses } from '@zwave-js/core';
import { createLogger } from '../config/logger.js';
import { SensorRepository, type SensorDevice, type ConnectivityStatus, type SensorState } from '../db/repositories/sensor-repository.js';
import { EventRepository } from '../events/event-repository.js';
import { PanelService } from '../alarm/panel-service.js';

const logger = createLogger('zwave/sensor-mapper');

type NotificationCcId = Parameters<ZWaveNotificationCallback>[1];
type NotificationArgs = Parameters<ZWaveNotificationCallback>[2];

const DEFAULT_LOW_BATTERY_THRESHOLD_PERCENT = 20;

export interface SensorMapperOptions {
  /** Battery percentage at/below which a sensor is reported as a low-battery fault (FR-012). Defaults to 20. */
  lowBatteryThresholdPercent?: number;
}

/**
 * Subscribes to zwave-js node value/notification events (FR-002) and
 * translates them into SensorDevice state updates and connectivity/battery
 * fault detection (FR-012), edge-triggering the panel service (T023) only
 * when a sensor's breach state actually transitions into `breached` — per
 * this task's "call into the panel service when a sensor changes state",
 * repeated notifications of an already-breached sensor don't keep resetting
 * the panel's entry-delay timer.
 *
 * Only nodes with a matching `sensor_devices` row (by zwaveNodeId) are acted
 * on. Assigning a node to a zone/category is T027's route, not this
 * module's concern — an unmapped node's events are ignored.
 *
 * Emits `'sensor_changed'` (the updated SensorDevice) on every breach/normal
 * transition and `'sensor_fault'` (the updated SensorDevice) on every
 * connectivity or battery-level change, so `src/api/ws-broadcaster.ts` (T029)
 * can push `sensor.changed`/`sensor.fault` to WebSocket clients. Fault events
 * fire on both the ok->fault and fault->ok edges (unlike the device_fault
 * SecurityEvent recorded by recordFault(), which only fires on the
 * ok->fault edge) so the dashboard's live fault indicators (T030) clear
 * again once a sensor recovers.
 */
export class SensorMapper extends EventEmitter {
  private readonly lowBatteryThresholdPercent: number;
  private readonly attachedNodeIds = new Set<number>();

  constructor(
    private readonly driver: Driver,
    private readonly sensorRepo: SensorRepository,
    private readonly panelService: PanelService,
    private readonly eventRepo: EventRepository,
    options: SensorMapperOptions = {},
  ) {
    super();
    this.lowBatteryThresholdPercent = options.lowBatteryThresholdPercent ?? DEFAULT_LOW_BATTERY_THRESHOLD_PERCENT;
  }

  /**
   * Attaches listeners to every currently-known controller node plus any
   * included later. Safe to call before the network scan finishes — nodes
   * discovered afterwards arrive via the controller's "node added" event.
   */
  start(): void {
    this.driver.controller.nodes.forEach((node) => this.attachNode(node));
    this.driver.controller.on('node added', (node) => this.attachNode(node));
  }

  private attachNode(node: ZWaveNode): void {
    if (this.attachedNodeIds.has(node.id)) {
      return; // Already listening (e.g. "node added" re-fires after a re-interview).
    }
    this.attachedNodeIds.add(node.id);

    node.on('notification', (_endpoint, ccId, args) => this.handleNotification(node.id, ccId, args));
    node.on('value updated', (n, args) => this.handleValueUpdated(n.id, args));
    node.on('dead', (n) => this.handleConnectivityChange(n.id, 'offline'));
    node.on('alive', (n) => this.handleConnectivityChange(n.id, 'online'));
  }

  private handleNotification(nodeId: number, ccId: NotificationCcId, args: NotificationArgs): void {
    const sensor = this.sensorRepo.findByNodeId(nodeId);
    if (!sensor) {
      return;
    }

    if (ccId === CommandClasses.Notification) {
      // TS can't correlate `args`'s type to the `ccId` check above (both are derived from the same
      // Parameters<ZWaveNotificationCallback> union, but the two are checked independently), so narrow explicitly.
      const notificationArgs = args as ZWaveNotificationCallbackArgs_NotificationCC;
      // Notification CC's "idle"/clear event is always code 0; any other event code is an active alarm state.
      this.applyBreachState(sensor, notificationArgs.event !== 0);
    } else if (ccId === CommandClasses.Battery) {
      // A qualitative "battery low" push with no numeric reading — clamp to the threshold itself so the
      // derived low-battery check reflects it until the next numeric "value updated" reading arrives.
      this.applyBatteryLevel(sensor, this.lowBatteryThresholdPercent);
    }
  }

  private handleValueUpdated(nodeId: number, args: ZWaveNodeValueUpdatedArgs): void {
    const sensor = this.sensorRepo.findByNodeId(nodeId);
    if (!sensor) {
      return;
    }

    if (args.commandClass === CommandClasses['Binary Sensor']) {
      this.applyBreachState(sensor, Boolean(args.newValue));
    } else if (args.commandClass === CommandClasses.Battery && args.property === 'level') {
      // zwave-js reports either a 0-100 percentage or the sentinel string "low" when a device can't report an exact level.
      const raw = args.newValue;
      const level = typeof raw === 'number' ? raw : raw === 'low' ? this.lowBatteryThresholdPercent : null;
      this.applyBatteryLevel(sensor, level);
    }
  }

  private handleConnectivityChange(nodeId: number, status: ConnectivityStatus): void {
    const sensor = this.sensorRepo.findByNodeId(nodeId);
    if (!sensor || sensor.connectivityStatus === status) {
      return;
    }

    const updated = this.sensorRepo.updateState(sensor.id, { connectivityStatus: status });
    this.emit('sensor_fault', updated);
    if (status === 'offline') {
      this.recordFault(updated, 'connectivity lost');
    }
  }

  /** Persists a breach/normal transition and, only on the normal->breached edge, notifies the panel service. */
  private applyBreachState(sensor: SensorDevice, breached: boolean): void {
    const nextState: SensorState = breached ? 'breached' : 'normal';
    if (sensor.currentState === nextState) {
      return;
    }

    const updated = this.sensorRepo.updateState(sensor.id, { currentState: nextState });
    this.emit('sensor_changed', updated);
    if (nextState === 'breached') {
      this.panelService.reportSensorBreach({ id: updated.id, zoneId: updated.zoneId, category: updated.category });
    }
  }

  /** Persists a battery reading and, only on the ok->low edge, records a device_fault SecurityEvent (FR-011, FR-012). */
  private applyBatteryLevel(sensor: SensorDevice, level: number | null): void {
    if (sensor.batteryLevel === level) {
      return;
    }

    const wasLow = sensor.batteryLevel !== null && sensor.batteryLevel <= this.lowBatteryThresholdPercent;
    const isLow = level !== null && level <= this.lowBatteryThresholdPercent;

    const updated = this.sensorRepo.updateState(sensor.id, { batteryLevel: level });
    this.emit('sensor_fault', updated);
    if (isLow && !wasLow) {
      this.recordFault(updated, `battery at ${String(level)}%`);
    }
  }

  private recordFault(sensor: SensorDevice, details: string): void {
    logger.warn('sensor fault detected', { sensorId: sensor.id, zoneId: sensor.zoneId, details });
    this.eventRepo.record({
      type: 'device_fault',
      source: 'system',
      relatedZoneId: sensor.zoneId,
      relatedSensorId: sensor.id,
      details,
    });
  }
}
