# Phase 1 Data Model: Self-Hosted Z-Wave Alarm System with Home Assistant Integration

Derived from the Key Entities and Functional Requirements in [spec.md](./spec.md).

## AlarmPanel

Singleton — one row represents the whole system's current security state.

| Field | Type | Notes |
|---|---|---|
| `id` | fixed singleton id | Always the single row (`"panel"`) |
| `mode` | enum | `disarmed`, `arming` (exit delay running), `armed_away`, `armed_home`, `alarm_pending` (entry delay running), `alarm_triggered` |
| `pendingDelayEndsAt` | timestamp, nullable | Set while `mode` is `arming` or `alarm_pending`; drives countdown |
| `triggeredBy` | reference to `SecurityEvent`, nullable | The event that caused the current `alarm_triggered` state, if any |
| `updatedAt` | timestamp | Last state transition |

**State transitions** (FR-001, FR-003, FR-004, FR-014, FR-015):

- `disarmed` → `arming` (an authorized arm command; exit delay starts) → `armed_away` / `armed_home` (delay elapses)
- `armed_away`/`armed_home` → `alarm_pending` (an intrusion sensor breaches; entry delay starts) → `alarm_triggered` (delay elapses without disarm) or → `disarmed` (valid disarm during entry delay)
- Any mode → `alarm_triggered` immediately when a life-safety sensor triggers (FR-015), bypassing delays
- `alarm_triggered` → `disarmed` (valid disarm command)
- A conflicting command received while another is being applied is resolved by native-interface precedence (FR-014) before the transition is committed

## Zone

| Field | Type | Notes |
|---|---|---|
| `id` | id | |
| `name` | string | e.g., "Front Door", "Garage" |
| `createdAt` | timestamp | |

Relationship: one Zone has many SensorDevices.

## SensorDevice

| Field | Type | Notes |
|---|---|---|
| `id` | id | |
| `zwaveNodeId` | integer | Foreign reference into the `zwave-js` driver's node table |
| `zoneId` | reference to Zone | |
| `name` | string | |
| `category` | enum | `intrusion` (armed-state-gated) or `life-safety` (always active) — per Clarifications session 2026-09-07 |
| `currentState` | enum | `normal`, `breached` |
| `batteryLevel` | integer percent, nullable | Null if the device is mains-powered |
| `connectivityStatus` | enum | `online`, `offline` |
| `updatedAt` | timestamp | |

**Validation**: `zwaveNodeId` must reference a node already known to the `zwave-js` driver; a device cannot be assigned to more than one Zone at a time (FR-010).

**Fault vs. breach** (FR-012, Edge Cases): `connectivityStatus: offline` or a low `batteryLevel` is recorded as a fault condition distinct from `currentState: breached`; both can be true simultaneously and are reported separately.

## SecurityEvent

Append-only log (FR-011).

| Field | Type | Notes |
|---|---|---|
| `id` | id | |
| `type` | enum | `armed`, `disarmed`, `breach`, `alarm_triggered`, `alarm_cleared`, `device_fault`, `lockout`, `guest_code_used` |
| `source` | enum | `user`, `home_assistant`, `system` |
| `sourceUserId` | reference to User, nullable | Set when `source` is `user` or a Home Assistant action was performed on behalf of a user |
| `relatedZoneId` / `relatedSensorId` | references, nullable | Set for breach/fault events |
| `details` | text, nullable | Free-form context (e.g., which role, which mode requested) |
| `occurredAt` | timestamp | |

## User (Household Member)

| Field | Type | Notes |
|---|---|---|
| `id` | id | |
| `name` | string | |
| `role` | enum | `administrator`, `member`, `guest` (FR-010a) |
| `credentialHash` | string | Hashed disarm code / password |
| `guestExpiresAt` | timestamp, nullable | Set only for `guest` role; code stops working after this time |
| `guestZoneId` | reference to Zone, nullable | Set only for a zone-restricted `guest` role |
| `failedAttemptCount` | integer | Reset on success; drives FR-016 lockout policy |
| `lockedUntil` | timestamp, nullable | Set while locked out |
| `createdAt` | timestamp | |

**Validation**: `guestExpiresAt` or `guestZoneId` (at least one) must be set when `role = guest`, per the Guest definition in Key Entities. `administrator` and `member` roles ignore both fields.

## LockoutPolicy

Singleton configuration object (FR-016).

| Field | Type | Notes |
|---|---|---|
| `failedAttemptThreshold` | integer | Default 5 |
| `cooldownSeconds` | integer | Default 300 |
| `onThresholdExceeded` | enum | `lockout` (default) or `trigger_alarm` |

## HomeAssistantLink

| Field | Type | Notes |
|---|---|---|
| `id` | id | |
| `apiTokenHash` | string | Hashed long-lived token issued to a specific Home Assistant instance |
| `label` | string | User-assigned name for the connection |
| `connectionStatus` | enum | `connected`, `disconnected` |
| `lastSeenAt` | timestamp, nullable | |
| `createdAt` | timestamp | |

Relationship: a HomeAssistantLink acts on behalf of one User (the administrator who issued its token) for audit purposes in `SecurityEvent.sourceUserId`.
