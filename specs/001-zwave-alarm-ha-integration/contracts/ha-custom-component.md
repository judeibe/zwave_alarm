# Contract: Home Assistant Custom Component

Package: `custom_components/zwave_alarm` in the separate [ha-zwave-alarm](https://github.com/judeibe/ha-zwave-alarm) repository, which talks to this service through the [zwave-alarm-client](https://github.com/judeibe/zwave-alarm-client) package. Consumes the REST API (`contracts/rest-api.md`) and WebSocket channel (`contracts/websocket-events.md`) exposed by this service — not the raw `zwave-js-server` protocol, which Home Assistant's own built-in "Z-Wave JS" integration consumes separately (see `research.md` §6).

## Config flow

Prompts for: host/port of this service, the API token issued via `POST /api/v1/ha-links`, and an optional "use HTTPS/WSS" toggle (the stream is served over `wss://` behind TLS). Validates by calling `GET /api/v1/panel`; on `401`, surfaces an invalid-token error.

**Re-authentication:** if the service later refuses the stored token (`401` on the stream upgrade, e.g. the link was revoked), the entry starts Home Assistant's reauth flow asking for a replacement token, and its entities stay `unavailable` until one validates.

## Entities exposed to Home Assistant

- `alarm_control_panel.zwave_alarm` — mapped from `AlarmPanel.mode` (`disarmed`/`arming`/`armed_away`/`armed_home`/`pending`/`triggered`), using Home Assistant's standard `alarm_control_panel` states; `arm_away`/`arm_home`/`disarm` services call the corresponding REST endpoints (disarm requires a code). Attributes: `armed_mode`, `pending_delay_ends_at`, `disarmed_zones` (zones a zone-restricted guest has disarmed while the panel stays armed, FR-010a), `triggered_by_zone`, `triggered_by_sensor_id`.
- `binary_sensor.zwave_alarm_zone_<zone>` — one per Zone, `on` when any sensor in that zone is `breached`; attributes include the zone's sensors and each one's `category`, and `disarmed` (true while a zone-restricted guest has disarmed this zone, FR-010a). A zone created after setup gets its entity as soon as the integration learns of it (a stream event for a sensor it doesn't know triggers a zone re-fetch).
- `sensor.zwave_alarm_fault_count` — count of sensors currently reporting a fault (offline/low battery), for automations that alert on system health separately from security breaches. Attribute `sensors` lists each faulted sensor with its zone and reasons (`offline`, `low_battery`).
- `event.zwave_alarm_security_events` — fires once per `event.recorded` message, with the `SecurityEvent.type` as the event type (`armed`, `disarmed`, `breach`, `alarm_triggered`, `alarm_cleared`, `device_fault`, `lockout`, `guest_code_used`) and `details`, `event_id`, `occurred_at` as attributes. This is how an automation tells recipients an alarm was cleared and by whom (User Story 3, FR-013).

## Live updates

The component maintains one persistent connection to the WebSocket channel; incoming `panel.changed` (including `disarmedZoneIds` and `triggeredBy`)/`sensor.changed`/`sensor.fault` events update the corresponding entity state immediately (FR-008). The connection sends the channel's liveness `ping`. On disconnect, it retries with backoff and re-requests a `snapshot` on reconnect (Edge Cases: HA reconnect resync).

## Failure handling

If the service is unreachable, entities go to Home Assistant's standard `unavailable` state; this MUST NOT be interpreted by any automation as `disarmed` (Edge Cases, FR-006 — the alarm system's own state is authoritative and independent of Home Assistant's reachability).
