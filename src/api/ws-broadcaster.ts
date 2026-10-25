import { WebSocket, type WebSocketServer } from 'ws';
import type { AlarmPanel } from '../alarm/panel-repository.js';
import type { PanelService } from '../alarm/panel-service.js';
import type { SensorMapper } from '../zwave/sensor-mapper.js';
import type { SensorDevice } from '../db/repositories/sensor-repository.js';
import type { ZoneRepository } from '../db/repositories/zone-repository.js';
import { EventRepository, type SecurityEvent } from '../events/event-repository.js';
import type { DriverState } from '../zwave/driver.js';
import type { AlarmEvent } from '../alarm/alarm-event-repository.js';
import type { AlarmEventService } from '../alarm/alarm-event-service.js';
import type { ModeSchedule, ModeScheduleRepository } from '../alarm/mode-schedule.js';
import type { SirenDevice, SirenRepository } from '../alarm/siren-repository.js';
import type { LockService, LockSummary } from '../locks/lock-service.js';
import type { KeypadSettings, KeypadSettingsService } from '../keypads/keypad-settings.js';
import type { KeypadPublicEvent, KeypadService, KeypadSummary } from '../keypads/keypad-service.js';

export interface WsBroadcasterDeps {
  panelService: PanelService;
  sensorMapper: SensorMapper;
  eventRepo: EventRepository;
  zoneRepo: ZoneRepository;
  /** Optional: keypad events and the snapshot's `keypads` are only sent when supplied. */
  keypadService?: KeypadService;
  /** Optional: `keypad.settings` events and the snapshot's `keypadSettings` are only sent when supplied. */
  keypadSettings?: KeypadSettingsService;
  /** Optional: `alarm.event` messages and the snapshot's `alarmEvents` are only sent when supplied. */
  alarmEvents?: AlarmEventService;
  /** Optional: `mode-schedule.changed` / `.removed` messages and the snapshot's `modeSchedules` are only sent when supplied. */
  modeSchedules?: ModeScheduleRepository;
  /** Optional: `siren.changed` / `siren.removed` messages and the snapshot's `sirens` are only sent when supplied. */
  sirenRepo?: SirenRepository;
  /** Optional: `lock.changed` events and the snapshot's `locks` are only sent when supplied. */
  lockService?: LockService;
  /** Optional: `driver.state` events are only sent when supplied (src/index.ts passes the real driver's). */
  driverStatus?: DriverStatusSource;
}

/** The Z-Wave driver's state and a way to follow its changes, as exported by src/zwave/driver.ts. */
export interface DriverStatusSource {
  get: () => DriverState;
  subscribe: (listener: (state: DriverState) => void) => unknown;
}

/**
 * Builds the real `snapshot` payload (contracts/websocket-events.md) from
 * live state, for use as `src/api/ws.ts`'s `createWebSocketServer`
 * `buildSnapshot` argument.
 */
export function buildLiveSnapshot(deps: Pick<WsBroadcasterDeps, 'panelService' | 'zoneRepo' | 'keypadService' | 'keypadSettings' | 'lockService' | 'driverStatus' | 'alarmEvents' | 'sirenRepo' | 'modeSchedules'>): Record<string, unknown> {
  const panel = deps.panelService.getState();
  return {
    type: 'snapshot',
    panel: {
      mode: panel.mode,
      armedMode: panel.armedMode,
      pendingDelayEndsAt: panel.pendingDelayEndsAt,
      exitEndsAt: panel.exitEndsAt,
      entryEndsAt: panel.entryEndsAt,
      disarmedZoneIds: panel.disarmedZoneIds,
      bypassedDeviceIds: panel.bypassedDeviceIds,
    },
    modes: deps.panelService.getModes(),
    zones: deps.zoneRepo.list(),
    ...(deps.alarmEvents && { alarmEvents: deps.alarmEvents.listActive() }),
    ...(deps.sirenRepo && { sirens: deps.sirenRepo.list() }),
    ...(deps.modeSchedules && { modeSchedules: deps.modeSchedules.list() }),
    ...(deps.keypadService && { keypads: deps.keypadService.list() }),
    ...(deps.keypadSettings && { keypadSettings: deps.keypadSettings.get() }),
    ...(deps.lockService && { locks: deps.lockService.list() }),
    ...(deps.driverStatus && { driver: deps.driverStatus.get() }),
  };
}

/** Resolves an AlarmPanel.triggeredBy SecurityEvent id into the `{ sensorId, zoneId }` shape the contract documents. */
function resolveTriggeredBy(
  eventRepo: EventRepository,
  triggeredBy: AlarmPanel['triggeredBy'],
): { sensorId: string | null; zoneId: string | null } | null {
  if (!triggeredBy) {
    return null;
  }
  const event = eventRepo.findById(triggeredBy);
  if (!event) {
    return null;
  }
  return { sensorId: event.relatedSensorId, zoneId: event.relatedZoneId };
}

function broadcast(wss: WebSocketServer, message: Record<string, unknown>): void {
  const payload = JSON.stringify(message);
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  }
}

/**
 * Wires `panel.changed`, `sensor.changed`, `sensor.fault`, `driver.state` and
 * `event.recorded` (contracts/websocket-events.md) from the live
 * PanelService/SensorMapper/EventRepository onto every connected client of
 * `wss`. This is a pure fan-out: it never sends a per-client differentiated
 * message, since the channel is read-only broadcast state (all commands go
 * through the REST API, per the contract).
 */
export function attachWsBroadcaster(wss: WebSocketServer, deps: WsBroadcasterDeps): void {
  deps.panelService.on('panel_changed', (panel: AlarmPanel) => {
    broadcast(wss, {
      type: 'panel.changed',
      mode: panel.mode,
      armedMode: panel.armedMode,
      pendingDelayEndsAt: panel.pendingDelayEndsAt,
      exitEndsAt: panel.exitEndsAt,
      entryEndsAt: panel.entryEndsAt,
      disarmedZoneIds: panel.disarmedZoneIds,
      bypassedDeviceIds: panel.bypassedDeviceIds,
      modes: deps.panelService.getModes(),
      triggeredBy: resolveTriggeredBy(deps.eventRepo, panel.triggeredBy),
    });
  });

  deps.modeSchedules?.on('mode_schedule_changed', (schedule: ModeSchedule) => {
    broadcast(wss, { type: 'mode-schedule.changed', schedule });
  });
  deps.modeSchedules?.on('mode_schedule_removed', (id: string) => {
    broadcast(wss, { type: 'mode-schedule.removed', id });
  });

  deps.sirenRepo?.on('siren_changed', (siren: SirenDevice) => {
    broadcast(wss, { type: 'siren.changed', siren });
  });
  deps.sirenRepo?.on('siren_removed', (nodeId: number) => {
    broadcast(wss, { type: 'siren.removed', nodeId });
  });

  deps.alarmEvents?.on('alarm_event', (event: AlarmEvent) => {
    broadcast(wss, { type: 'alarm.event', event });
  });

  deps.sensorMapper.on('sensor_changed', (sensor: SensorDevice) => {
    broadcast(wss, {
      type: 'sensor.changed',
      sensorId: sensor.id,
      zoneId: sensor.zoneId,
      currentState: sensor.currentState,
      category: sensor.category,
    });
  });

  deps.sensorMapper.on('sensor_fault', (sensor: SensorDevice) => {
    broadcast(wss, {
      type: 'sensor.fault',
      sensorId: sensor.id,
      connectivityStatus: sensor.connectivityStatus,
      batteryLevel: sensor.batteryLevel,
      tampered: sensor.tampered,
    });
  });

  // Every change, so a client sees "failed" with its retry time and then "ready" without polling.
  deps.driverStatus?.subscribe((driver) => {
    broadcast(wss, { type: 'driver.state', ...driver });
  });

  deps.keypadService?.on('keypad_changed', (keypad: KeypadSummary) => {
    broadcast(wss, { type: 'keypad.changed', keypad });
  });

  // The service's public event never carries the entered code, so it is safe to fan out as-is.
  deps.keypadService?.on('keypad_event', (event: KeypadPublicEvent) => {
    broadcast(wss, { type: 'keypad.event', nodeId: event.nodeId, adapterId: event.adapterId, input: event.input });
  });

  deps.keypadSettings?.on('settings_changed', (settings: KeypadSettings) => {
    broadcast(wss, { type: 'keypad.settings', settings });
  });

  deps.lockService?.on('lock_changed', (lock: LockSummary) => {
    broadcast(wss, { type: 'lock.changed', lock });
  });

  deps.lockService?.on('lock_removed', (nodeId: number) => {
    broadcast(wss, { type: 'lock.removed', nodeId });
  });

  deps.eventRepo.on('event_recorded', (event: SecurityEvent) => {
    broadcast(wss, {
      type: 'event.recorded',
      // `details` carries e.g. "Cleared by <name>"/"Cleared by Home Assistant" on `alarm_cleared`
      // events (User Story 3: recipients must be told the alarm was cleared, and by whom).
      event: {
        id: event.id,
        type: event.type,
        occurredAt: event.occurredAt,
        details: event.details,
        actor: event.actor,
        deviceId: event.deviceId,
        deviceName: event.deviceName,
      },
    });
  });
}
