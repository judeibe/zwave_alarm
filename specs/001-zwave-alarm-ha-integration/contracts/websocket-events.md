# Contract: WebSocket Push Channel

Endpoint: `wss://<host>/api/v1/stream`. Authenticated the same way as the REST API (session cookie or bearer token) at connect time: the WebSocket upgrade is refused with HTTP `401` — and no `snapshot` is ever sent — unless the request carries a valid `Authorization: Bearer <token>` header for a Home Assistant link, or a native-dashboard session cookie for an `administrator` or `member` (the roles that may read `GET /api/v1/panel`; a `guest` session is refused). A revoked token is refused like an unknown one. This channel implements FR-008 (state pushed as it happens, not polled) and is what both the native dashboard and the Home Assistant custom component subscribe to for the alarm-domain surface (see `research.md` §6 — raw device entities are instead delivered to Home Assistant via the standard `zwave-js-server` protocol, not this channel).

On connect, the server sends one `snapshot` event with the full current state, then streams incremental events. On reconnect after a drop, the client MUST request/receive a fresh `snapshot` before trusting further incremental events (Edge Cases: Home Assistant resync after reconnect).

## Server → client events

### `snapshot`

```json
{ "type": "snapshot", "panel": { "mode": "armed_away", "pendingDelayEndsAt": null, "disarmedZoneIds": [] }, "zones": [ /* Zone + SensorDevice[] */ ], "driver": { "status": "ready", "lastError": null, "attempts": 1, "nextRetryAt": null }, "locks": [ /* LockSummary, only with Schlage support */ ] }
```

`driver` is the state of the service's Z-Wave driver, the same object as `driver` on `GET /api/v1/panel`.

### `panel.changed`

```json
{ "type": "panel.changed", "mode": "alarm_triggered", "pendingDelayEndsAt": null, "disarmedZoneIds": [], "triggeredBy": { "sensorId": "...", "zoneId": "..." } }
```

### `sensor.changed`

```json
{ "type": "sensor.changed", "sensorId": "...", "zoneId": "...", "currentState": "breached", "category": "intrusion" }
```

### `sensor.fault`

```json
{ "type": "sensor.fault", "sensorId": "...", "connectivityStatus": "offline", "batteryLevel": 8 }
```

### `driver.state`

```json
{ "type": "driver.state", "status": "failed", "lastError": "Failed to initialize the driver: The Serial API did not respond after soft-reset (ZW0100)", "attempts": 1, "nextRetryAt": 1792295627000 }
```

Sent on every change of the Z-Wave driver's state, with the fields of `driver` on `GET /api/v1/panel` (`contracts/rest-api.md`): `status` is `starting`, `ready` or `failed`; `lastError` is the latest failure text, cleared on `ready`; `attempts` counts start attempts; `nextRetryAt` is the epoch ms of the next retry while `failed`, otherwise `null`. A driver that fails after it was ready goes `failed`, then `starting`, then `ready` again. A client that reconnects gets the current value in `snapshot` instead.

### `event.recorded`

```json
{ "type": "event.recorded", "event": { "id": "...", "type": "lockout", "occurredAt": "...", "details": null } }
```

`details` is a free-text field, non-null for e.g. an `alarm_cleared` event, where it holds "Cleared by \<name\>" or "Cleared by Home Assistant" (User Story 3's second acceptance scenario — recipients must be told the alarm was cleared, and by whom).

## Client → server messages

Read-only channel for state; all commands (arm/disarm/config changes) go through the REST API (`contracts/rest-api.md`) so that FR-014's conflict-resolution rule has a single command path to arbitrate. The only client → server message on this channel is a periodic `ping` (server replies `pong`) for connection liveness.

### `lock.changed`

```json
{ "type": "lock.changed", "lock": { /* LockSummary */ } }
```

Sent when an **enrolled** Schlage lock appears or any of its state changes. That includes the bolt moving (`locked` in the `LockSummary`). See `contracts/locks.md`.

### `lock.removed`

```json
{ "type": "lock.removed", "nodeId": 5 }
```

Sent when a lock is unenrolled or leaves the Z-Wave network; the client removes its device.
