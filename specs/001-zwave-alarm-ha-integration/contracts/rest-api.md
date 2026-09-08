# Contract: REST API

Base path: `/api/v1`. All endpoints require authentication (session cookie for the native dashboard, or `Authorization: Bearer <token>` for a Home Assistant custom-component connection) — FR-009. Every action is additionally checked against the caller's role (FR-010a).

## Auth

### `POST /api/v1/auth/login`

Native dashboard only. Body: `{ "code": string }`. On success, sets a session cookie and returns the caller's `User` (id, name, role). On failure, increments the caller's failed-attempt counter per the `LockoutPolicy` (FR-016) and returns `401`; once the threshold is exceeded, returns `423 Locked` (or, in `trigger_alarm` mode, returns `200` with the panel already transitioned to `alarm_triggered`).

### `POST /api/v1/auth/logout`

Ends the current session.

## Panel

### `GET /api/v1/panel`

Returns current `AlarmPanel` state: `mode`, `pendingDelayEndsAt`, `triggeredBy`.

### `POST /api/v1/panel/arm`

Body: `{ "mode": "armed_away" | "armed_home" }`. Requires role `administrator` or `member` (FR-001). Starts the exit delay (FR-004). Conflicting concurrent requests are resolved per FR-014 (native-interface precedence); a Home Assistant-sourced request that loses the race receives `409 Conflict`.

### `POST /api/v1/panel/disarm`

Body: `{ "code": string }` (Guest codes accepted only within their configured window/zone restriction). Clears `alarm_triggered`/`alarm_pending`/`arming` back to `disarmed` and records an `alarm_cleared` or `disarmed` `SecurityEvent`.

## Zones & Sensors

### `GET /api/v1/zones`

Lists zones with their sensor devices' current state, category (`intrusion`/`life-safety`), battery, and connectivity (FR-002, FR-012).

### `POST /api/v1/zones` — administrator only

Create a zone. Body: `{ "name": string }`.

### `POST /api/v1/zones/{zoneId}/sensors` — administrator only

Assign an existing `zwave-js` node to this zone. Body: `{ "zwaveNodeId": number, "name": string, "category": "intrusion" | "life-safety" }` (FR-010).

## Users

### `GET /api/v1/users` — administrator only

### `POST /api/v1/users` — administrator only

Body: `{ "name": string, "role": "administrator" | "member" | "guest", "code": string, "guestExpiresAt"?: string, "guestZoneId"?: string }`.

### `DELETE /api/v1/users/{userId}` — administrator only

## Events

### `GET /api/v1/events?since={timestamp}&limit={n}`

Returns `SecurityEvent` records, newest first (FR-011).

## Home Assistant Links

### `POST /api/v1/ha-links` — administrator only

Issues a new long-lived API token for a Home Assistant instance to use during its custom-component config flow. Body: `{ "label": string }`. Response includes the plaintext token once; only its hash is stored.

### `DELETE /api/v1/ha-links/{linkId}` — administrator only

Revokes a previously issued token.

## Error format

All error responses: `{ "error": { "code": string, "message": string } }` with an appropriate HTTP status (`400`, `401`, `403`, `409`, `423`).
