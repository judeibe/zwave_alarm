import { WebSocket, type WebSocketServer } from 'ws';
import type { AlarmPanel } from '../alarm/panel-repository.js';
import type { PanelService } from '../alarm/panel-service.js';
import type { SensorMapper } from '../zwave/sensor-mapper.js';
import type { SensorDevice } from '../db/repositories/sensor-repository.js';
import type { ZoneRepository } from '../db/repositories/zone-repository.js';
import { EventRepository, type SecurityEvent } from '../events/event-repository.js';

export interface WsBroadcasterDeps {
  panelService: PanelService;
  sensorMapper: SensorMapper;
  eventRepo: EventRepository;
  zoneRepo: ZoneRepository;
}

/**
 * Builds the real `snapshot` payload (contracts/websocket-events.md) from
 * live state, for use as `src/api/ws.ts`'s `createWebSocketServer`
 * `buildSnapshot` argument.
 */
export function buildLiveSnapshot(deps: Pick<WsBroadcasterDeps, 'panelService' | 'zoneRepo'>): Record<string, unknown> {
  const panel = deps.panelService.getState();
  return {
    type: 'snapshot',
    panel: { mode: panel.mode, pendingDelayEndsAt: panel.pendingDelayEndsAt },
    zones: deps.zoneRepo.list(),
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

  deps.eventRepo.on('event_recorded', (event: SecurityEvent) => {
    broadcast(wss, {
      type: 'event.recorded',
      event: { id: event.id, type: event.type, occurredAt: event.occurredAt },
    });
  });
}
