# Contract: Schlage locks

Schlage Z-Wave locks: the **BE469** (touchscreen deadbolt with alarm) and the **BE468** (connected touchscreen deadbolt), including the ZP variants. A lock is recognised by its Z-Wave manufacturer (`0x003B`) and product ids, so there is nothing to configure. Same authentication as the rest of the API (session cookie or Home Assistant bearer token; `administrator`/`member` roles). No endpoint ever returns a stored user code.

Errors use the standard `{ "error": { "code", "message" } }` shape: `400 bad_request` (invalid value, or a BE469-only setting on a BE468), `404 not_found` (unknown lock or schedule kind), `502 lock_unavailable` (the lock did not answer or rejected a write).

## `LockSummary`

```json
{
  "nodeId": 5,
  "model": "BE469",
  "label": "Schlage BE469 Touchscreen Deadbolt with Alarm",
  "connectivityStatus": "online",
  "batteryLevel": 90,
  "supportedSettings": ["beeper", "vacationMode", "lockAndLeave", "autoLock", "pinLength", "alarmMode", "alertSensitivity", "tamperSensitivity", "kickSensitivity", "localControls"],
  "settings": {
    "beeper": true, "vacationMode": false, "lockAndLeave": false, "autoLock": true, "pinLength": 4,
    "alarmMode": "alert", "alertSensitivity": 3, "tamperSensitivity": 3, "kickSensitivity": 5, "localControls": true
  },
  "diagnostics": {
    "electronicTransitionCount": 1200, "mechanicalTransitionCount": 40, "electronicFailedCount": 2,
    "electronicHighPreloadTransitionCount": 7, "bootloaderVersion": 4,
    "userSlotBitField": [1, 0, 0, 0], "occupiedUserSlots": [1]
  },
  "scheduleSlots": { "weekDay": 7, "yearDay": 7, "dailyRepeating": 7 },
  "userSlotCount": 30
}
```

Any value is `null` until the lock has reported it, and the BE469-only settings (`alarmMode`, `alertSensitivity`, `tamperSensitivity`, `kickSensitivity`, `localControls`) are always `null` on a BE468 and absent from its `supportedSettings`. Clients should create entities from `supportedSettings`.

## Parameter map

| Setting / diagnostic | Parameter | Access | API value |
| --- | --- | --- | --- |
| `beeper` | 0x03 | read-write | boolean (wire `0x00` off, `0xFF` on) |
| `vacationMode` | 0x04 | read-write | boolean |
| `lockAndLeave` | 0x05 | read-write | boolean |
| `userSlotBitField` / `occupiedUserSlots` | 0x06 | read-only | 4 bytes: bytes 1-3 are slots 1-24, byte 4 is slots 25-30, LSB lowest; `occupiedUserSlots` lists slot numbers 1-30 |
| `alarmMode` (BE469) | 0x07 | read-write | `off`, `alert`, `tamper`, `forced_entry` |
| `alertSensitivity`, `tamperSensitivity`, `kickSensitivity` (BE469) | 0x08, 0x09, 0x0A | read-write | integer 0-5: 0 not supported, 1 most sensitive, 3 medium, 5 least; 2 and 4 are undocumented intermediates |
| `localControls` (BE469) | 0x0B | read-write | boolean, `true` = local control enabled (wire `0xFF`), `false` = disabled (wire `0x00`) |
| `electronicTransitionCount` | 0x0C | read-only | integer |
| `mechanicalTransitionCount` | 0x0D | read-only | integer |
| `electronicFailedCount` | 0x0E | read-only | integer |
| `autoLock` | 0x0F | read-write | boolean |
| `pinLength` | 0x10 | read-write | integer 4-8 (default 4) |
| `electronicHighPreloadTransitionCount` | 0x11 | read-only | integer |
| `bootloaderVersion` | 0x12 | read-only | integer |

## REST

| Method and path | Result |
| --- | --- |
| `GET /api/v1/locks` | `200 { "locks": LockSummary[] }` |
| `GET /api/v1/locks/{nodeId}` | `200 LockSummary` |
| `POST /api/v1/locks/{nodeId}/refresh` | Re-reads every parameter and the schedule slot counts from the lock. `200 LockSummary` |
| `PATCH /api/v1/locks/{nodeId}/settings` | Body: any non-empty subset of the writable `settings`. Validated as a whole before anything is written. `200 LockSummary` |
| `GET /api/v1/locks/{nodeId}/users` | `200 { "users": [ { "userId": 1, "status": "enabled" \| "disabled" \| "available" } ] }` for slots 1-30 |
| `PUT /api/v1/locks/{nodeId}/users/{userId}/code` | Body `{ "code": "1234", "status"?: "enabled" \| "disabled" }`. The code must be digits only, 4-8 long, and equal to the lock's `pinLength` once known. `200 { "userId", "status" }` |
| `DELETE /api/v1/locks/{nodeId}/users/{userId}/code` | `204` |
| `GET /api/v1/locks/{nodeId}/schedules` | `200 { "slots": { "weekDay", "yearDay", "dailyRepeating" } }`, the slots available per user |
| `PUT /api/v1/locks/{nodeId}/users/{userId}/schedules/enabled` | Body `{ "enabled": boolean }`: turns schedule enforcement on or off for that user. `204` |
| `GET /api/v1/locks/{nodeId}/users/{userId}/schedules/{kind}/{slotId}` | `200 { "kind", "userId", "slotId", "schedule": object \| null }` |
| `PUT /api/v1/locks/{nodeId}/users/{userId}/schedules/{kind}/{slotId}` | Body is the schedule for `kind`. `204` |
| `DELETE /api/v1/locks/{nodeId}/users/{userId}/schedules/{kind}/{slotId}` | `204` |

`userId` is 1-30. `slotId` is 1 to the count in `scheduleSlots` for that `kind`. Changing `pinLength` does not rewrite existing codes; set the codes again at the new length.

### Schedule kinds

`kind` is `weekDay`, `yearDay` or `dailyRepeating`, matching the Schedule Entry Lock CC. Weekdays are numbered 0 (Sunday) to 6 (Saturday); hours are 0-23 and minutes 0-59.

```json
// weekDay: one weekday, stop after start
{ "weekday": 1, "startHour": 8, "startMinute": 0, "stopHour": 17, "stopMinute": 30 }

// yearDay: a date range; years are two digits (26 = 2026), stop after start
{ "startYear": 26, "startMonth": 1, "startDay": 2, "startHour": 0, "startMinute": 0,
  "stopYear": 26, "stopMonth": 1, "stopDay": 9, "stopHour": 12, "stopMinute": 0 }

// dailyRepeating: several weekdays, a start time and a duration
{ "weekdays": [1, 2, 3], "startHour": 8, "startMinute": 30, "durationHour": 9, "durationMinute": 0 }
```

## WebSocket

`snapshot` gains `"locks": LockSummary[]` and a `lock.changed` event is sent whenever a lock appears or any of its state changes (a setting, a counter, the occupied slots, connectivity, battery), including values the lock reports on its own:

```json
{ "type": "lock.changed", "lock": { /* LockSummary */ } }
```
