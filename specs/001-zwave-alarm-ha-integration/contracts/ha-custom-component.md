# Contract: Home Assistant Custom Component

Package: `ha-integration/custom_components/zwave_alarm`. Consumes the REST API (`contracts/rest-api.md`) and WebSocket channel (`contracts/websocket-events.md`) exposed by this service — not the raw `zwave-js-server` protocol, which Home Assistant's own built-in "Z-Wave JS" integration consumes separately (see `research.md` §6).

## Config flow

Prompts for: host/port of this service, and the API token issued via `POST /api/v1/ha-links`. Validates by calling `GET /api/v1/panel`; on `401`, surfaces an invalid-token error.

## Entities exposed to Home Assistant

- `alarm_control_panel.zwave_alarm` — mapped from `AlarmPanel.mode` (`disarmed`/`armed_away`/`armed_home`/`pending`/`triggered`), using Home Assistant's standard `alarm_control_panel` states; `arm_away`/`arm_home`/`disarm` services call the corresponding REST endpoints.
- `binary_sensor.zwave_alarm_zone_<zone>` — one per Zone, `on` when any sensor in that zone is `breached`; attributes include the zone's sensors and each one's `category`.
- `sensor.zwave_alarm_fault_count` — count of sensors currently reporting a fault (offline/low battery), for automations that alert on system health separately from security breaches.

## Live updates

The component maintains one persistent connection to the WebSocket channel; incoming `panel.changed`/`sensor.changed`/`sensor.fault` events update the corresponding entity state immediately (FR-008). On disconnect, it retries with backoff and re-requests a `snapshot` on reconnect (Edge Cases: HA reconnect resync).

## Failure handling

If the service is unreachable, entities go to Home Assistant's standard `unavailable` state; this MUST NOT be interpreted by any automation as `disarmed` (Edge Cases, FR-006 — the alarm system's own state is authoritative and independent of Home Assistant's reachability).
