# Contract: WebSocket Push Channel

Endpoint: `wss://<host>/api/v1/stream`. Authenticated the same way as the REST API (session cookie or bearer token) at connect time. This channel implements FR-008 (state pushed as it happens, not polled) and is what both the native dashboard and the Home Assistant custom component subscribe to for the alarm-domain surface (see `research.md` §6 — raw device entities are instead delivered to Home Assistant via the standard `zwave-js-server` protocol, not this channel).

On connect, the server sends one `snapshot` event with the full current state, then streams incremental events. On reconnect after a drop, the client MUST request/receive a fresh `snapshot` before trusting further incremental events (Edge Cases: Home Assistant resync after reconnect).

## Server → client events

### `snapshot`

```json
{ "type": "snapshot", "panel": { "mode": "armed_away", "pendingDelayEndsAt": null }, "zones": [ /* Zone + SensorDevice[] */ ] }
```

### `panel.changed`

```json
{ "type": "panel.changed", "mode": "alarm_triggered", "pendingDelayEndsAt": null, "triggeredBy": { "sensorId": "...", "zoneId": "..." } }
```

### `sensor.changed`

```json
{ "type": "sensor.changed", "sensorId": "...", "zoneId": "...", "currentState": "breached", "category": "intrusion" }
```

### `sensor.fault`

```json
{ "type": "sensor.fault", "sensorId": "...", "connectivityStatus": "offline", "batteryLevel": 8 }
```

### `event.recorded`

```json
{ "type": "event.recorded", "event": { "id": "...", "type": "lockout", "occurredAt": "..." } }
```

## Client → server messages

Read-only channel for state; all commands (arm/disarm/config changes) go through the REST API (`contracts/rest-api.md`) so that FR-014's conflict-resolution rule has a single command path to arbitrate. The only client → server message on this channel is a periodic `ping` (server replies `pong`) for connection liveness.
