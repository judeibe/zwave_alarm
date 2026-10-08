# Contract: REST API

Base path: `/api/v1`. By default (`API_AUTH_REQUIRED` unset or `false`) no authentication is needed: a request with no credentials is accepted and treated as administrator-privileged, so Home Assistant connects with host and port only, and `POST /panel/disarm` identifies the user by the submitted `code` alone. With `API_AUTH_REQUIRED=true`, all endpoints require authentication (session cookie for the native dashboard, or `Authorization: Bearer <token>` for a Home Assistant custom-component connection) — FR-009. Either way, a malformed or unknown bearer token is rejected with `401`, and `POST /ha-links` returns `409` while auth is off. Every action is additionally checked against the caller's role (FR-010a).

## Auth

### `POST /api/v1/auth/login`

Native dashboard only. Body: `{ "code": string }`. On success, sets a session cookie and returns the caller's `User` (id, name, role). On a code that matches no account, returns `401`. A code that matches an account that is currently locked returns `423 Locked`. Failed-attempt counting per the `LockoutPolicy` (FR-016) applies to `POST /api/v1/panel/disarm`, where the caller is already identified: once the threshold is reached it returns `423 Locked` (or, in `trigger_alarm` mode, returns `200` with the panel already transitioned to `alarm_triggered`).

Independently of the per-account lockout, login is rate-limited per client IP: after 5 failed attempts within a minute further attempts return `429 Too Many Requests` (`code: "too_many_requests"`, with a `Retry-After` header) until the window passes. Successful logins do not count against the limit.

### `POST /api/v1/auth/logout`

Ends the current session.

## Panel

### `GET /api/v1/panel`

Returns current `AlarmPanel` state: `mode`, `pendingDelayEndsAt`, `triggeredBy`, `armedMode` (the armed mode the panel is in or heading to; `null` when disarmed) and `disarmedZoneIds` (zones a zone-restricted guest has disarmed while the panel stays armed — see `POST /api/v1/panel/disarm`; empty otherwise).

### `POST /api/v1/panel/arm`

Body: `{ "mode": "armed_away" | "armed_home" }`. Requires role `administrator` or `member` (FR-001). Starts the exit delay (FR-004). Conflicting concurrent requests are resolved per FR-014 (native-interface precedence); a Home Assistant-sourced request that loses the race receives `409 Conflict`.

### `POST /api/v1/panel/disarm`

Body: `{ "code": string }` (Guest codes accepted only within their configured expiry window). Clears `alarm_triggered`/`alarm_pending`/`arming` back to `disarmed` and records an `alarm_cleared` or `disarmed` `SecurityEvent`.

**Zone-restricted guests (FR-010a).** A guest created with a `guestZoneId` disarms *only that zone*, never the whole panel. The response is the resulting panel state:
- The panel `mode` is unchanged and the zone is added to `disarmedZoneIds`. Intrusion breaches in a disarmed zone are ignored (life-safety sensors still trigger immediately, FR-015); the zone is armed again whenever the panel is next fully disarmed or armed.
- If the current `alarm_pending`/`alarm_triggered` was caused by a breach *in that zone*, it is cleared back to the armed mode (`armedMode`), the rest of the panel staying armed, and an `alarm_cleared` event is recorded with the zone. An alarm caused by any other zone, or by repeated wrong codes, is left as it is.
- While the panel is disarmed it is a no-op.
Every successful guest disarm also records a `guest_code_used` `SecurityEvent`. A guest with no `guestZoneId` (expiry only) disarms the whole panel as before.

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

Body: `{ "name": string, "role": "administrator" | "member" | "guest", "code": string, "guestExpiresAt"?: string, "guestZoneId"?: string }`. A `guest` requires `guestExpiresAt` (ISO date string; an epoch-ms number is also accepted) and/or `guestZoneId`; a `guestZoneId` that does not refer to an existing zone returns `400`.

**First-run bootstrap:** while no users exist, this endpoint is the one exception to FR-009 and is accepted without credentials, but only with `"role": "administrator"` (otherwise `403`). Once any user exists it requires an administrator session like the rest of this section. This is what lets a fresh install create its first account (see `quickstart.md` §2).

### `DELETE /api/v1/users/{userId}` — administrator only

## Lockout Policy

Administrator only (FR-010a). Controls what happens after repeated wrong disarm codes (FR-016). The policy applies to the next failed attempt; failure counts already accrued and locks already in force are unchanged.

### `GET /api/v1/lockout-policy`

Returns `{ "failedAttemptThreshold": number, "cooldownSeconds": number, "onThresholdExceeded": "lockout" | "trigger_alarm" }`. Defaults: `5`, `300`, `"lockout"`.

### `PATCH /api/v1/lockout-policy`

Body: any non-empty subset of the three fields above — `failedAttemptThreshold` (integer 1-100), `cooldownSeconds` (integer 1-86400), `onThresholdExceeded`. Returns the resulting policy. An empty body, an out-of-range or wrong-typed value returns `400`. In `lockout` mode the threshold-th consecutive wrong code locks the caller's account for `cooldownSeconds` (`423`) and records a `lockout` event; in `trigger_alarm` mode it instead raises `alarm_triggered` (`200` with the panel state).

## Events

### `GET /api/v1/events?since={timestamp}&limit={n}`

Returns `SecurityEvent` records, newest first (FR-011).

## Home Assistant Links

### `POST /api/v1/ha-links` — administrator only

Issues a new long-lived API token for a Home Assistant instance to use during its custom-component config flow. Body: `{ "label": string }`. Response includes the plaintext token once; only its hash is stored.

### `DELETE /api/v1/ha-links/{linkId}` — administrator only

Revokes a previously issued token.

## Error format

All error responses: `{ "error": { "code": string, "message": string } }` with an appropriate HTTP status (`400`, `401`, `403`, `404`, `409`, `423`, `429`, `503`).

### Request validation

Every request body and query string is validated against a schema (`src/api/validation.ts`) *after* authentication and authorization, so an unauthenticated caller always sees `401`/`403` rather than details of the expected shape. A body or query that is missing, not an object, has a wrong-typed or out-of-range field (empty or over-long `name`/`code`/`label`, unknown `role`/`mode`/`category`, non-integer `zwaveNodeId`, non-numeric `since`/`limit`, a `guestExpiresAt` that is not a date), or is malformed JSON, returns `400` with `code: "bad_request"` and a `message` naming the offending field. Unknown body fields are ignored.
