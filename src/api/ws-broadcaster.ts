import { WebSocket, type WebSocketServer } from 'ws';
import type { AlarmPanel } from '../alarm/panel-repository.js';
import type { PanelService } from '../alarm/panel-service.js';
import type { SensorMapper } from '../zwave/sensor-mapper.js';
import type { SensorDevice } from '../db/repositories/sensor-repository.js';
import type { ZoneRepository } from '../db/repositories/zone-repository.js';
import { EventRepository, type SecurityEvent } from '../events/event-repository.js';
import type { KeypadPublicEvent, KeypadService, KeypadSummary } from '../keypads/keypad-service.js';

export interface WsBroadcasterDeps {
  panelService: PanelService;
  sensorMapper: SensorMapper;
  eventRepo: EventRepository;
  zoneRepo: ZoneRepository;
  /** Optional: keypad events and the snapshot's `keypads` are only sent when supplied. */
  keypadService?: KeypadService;
}

/**
 * Builds the real `snapshot` payload (contracts/websocket-events.md) from
 * live state, for use as `src/api/ws.ts`'s `createWebSocketServer`
 * `buildSnapshot` argument.
 */
export function buildLiveSnapshot(deps: Pick<WsBroadcasterDeps, 'panelService' | 'zoneRepo' | 'keypadService'>): Record<string, unknown> {
  const panel = deps.panelService.getState();
  return {
    type: 'snapshot',
    panel: { mode: panel.mode, pendingDelayEndsAt: panel.pendingDelayEndsAt, disarmedZoneIds: panel.disarmedZoneIds },
    zones: deps.zoneRepo.list(),
    ...(deps.keypadService && { keypads: deps.keypadService.list() }),
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
 * Wires `panel.changed`, `sensor.changed`, `sensor.fault`, and
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
      pendingDelayEndsAt: panel.pendingDelayEndsAt,
      disarmedZoneIds: panel.disarmedZoneIds,
      triggeredBy: resolveTriggeredBy(deps.eventRepo, panel.triggeredBy),
    });
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
    });
  });

  deps.keypadService?.on('keypad_changed', (keypad: KeypadSummary) => {
    broadcast(wss, { type: 'keypad.changed', keypad });
  });

  // The service's public event never carries the entered code, so it is safe to fan out as-is.
  deps.keypadService?.on('keypad_event', (event: KeypadPublicEvent) => {
    broadcast(wss, { type: 'keypad.event', nodeId: event.nodeId, adapterId: event.adapterId, input: event.input });
  });

  deps.eventRepo.on('event_recorded', (event: SecurityEvent) => {
    broadcast(wss, {
      type: 'event.recorded',
      // `details` carries e.g. "Cleared by <name>"/"Cleared by Home Assistant" on `alarm_cleared`
      // events (User Story 3: recipients must be told the alarm was cleared, and by whom).
      event: { id: event.id, type: event.type, occurredAt: event.occurredAt, details: event.details },
    });
  });
}
