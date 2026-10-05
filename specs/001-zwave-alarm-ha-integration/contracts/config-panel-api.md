# Contract (PROPOSED): Configuration Panel API

Status: draft for confirmation by `zwave-alarm-client` and `ha-zwave-alarm`. Extends [rest-api.md](./rest-api.md); same base path (`/api/v1`), auth, error format and validation rules. All endpoints below are **administrator only**.

## Data model changes

- **Zone**: add `description` (string, nullable). `name` stays unique (case-insensitive).
- **SensorDevice**: unchanged fields; adds update and unassign operations. One zone per sensor (FR-010).
- **User**: add `haPersonId` (string, nullable, unique) — the HA `person` entity id (e.g. `person.alex`), and `haUserId` (string, nullable) — the HA user id. Stored for display and linking only; the alarm service never trusts them for authentication.
- **Code** is not a separate table. A code is the `User.credentialHash`. Raw codes are write-only: accepted on create/set, never returned, never logged. Responses expose only `hasCode: boolean`.
- Relations: Zone 1—* Sensor; Person(User) 0..1—1 code; guest User 0..1—1 Zone via `guestZoneId`.

## Sensors

### `GET /api/v1/sensors/discoverable`
Lists `zwave-js` nodes not yet assigned to a zone: `[{ "zwaveNodeId": number, "name": string|null, "manufacturer": string|null, "product": string|null, "suggestedCategory": "intrusion"|"life-safety"|null, "status": "alive"|"dead"|"asleep" }]`. Suggestion derived from notification/binary-sensor command classes.

### `PATCH /api/v1/sensors/{sensorId}`
Body: any non-empty subset of `name`, `category`, `zoneId`. Moves the sensor between zones. `404` unknown sensor/zone.

### `DELETE /api/v1/sensors/{sensorId}`
Unassigns the sensor (does not remove the zwave-js node). `204`.

## Zones

### `PATCH /api/v1/zones/{zoneId}`
Body: any non-empty subset of `name`, `description`. Returns the zone with sensors.

### `DELETE /api/v1/zones/{zoneId}`
`409` (`zone_not_empty`) if it has sensors or is any guest's `guestZoneId`, unless `?force=true`, which unassigns the sensors and rejects if a guest still references it. `204`.

## People and codes

### `GET /api/v1/users`  (extended)
Each user: `{ id, name, role, hasCode, haPersonId, haUserId, guestExpiresAt, guestZoneId, lockedUntil, createdAt }`. Never any hash.

### `POST /api/v1/users`  (extended)
Adds optional `haPersonId`, `haUserId`. `code` stays required (4-12 digits).

### `PATCH /api/v1/users/{userId}`
Body: any non-empty subset of `name`, `role`, `haPersonId`, `haUserId`, `guestExpiresAt`, `guestZoneId`. Same guest validation as create. `409` if it would demote the last administrator.

### `PUT /api/v1/users/{userId}/code`
Body: `{ "code": string }`. Sets or replaces the code; resets failed attempts and lockout. `204`, empty body. `409` (`code_in_use`) if another user's code collides (login identifies by code, so codes must be unique).

### `DELETE /api/v1/users/{userId}/code`
Clears the code (user can no longer disarm or log in). `204`. `409` for the last administrator.

## Events
Config changes record events (`config_changed`, with `details` naming the entity, never code values).

## Open questions
1. HA side: does the panel need a reverse lookup `GET /users?haPersonId=`? Proposed: filter param on `GET /users`.
2. Should HA person entities with no code appear as "pending" users? Proposed: HA creates the User on first code assignment; no placeholder rows server-side.
3. Client: pagination is not planned (household scale).
