# Contract: Keypads

Z-Wave alarm keypads (the Ring Keypad v2 is the first). This service owns all Z-Wave behaviour; clients only see the generic surface below, and nothing device-specific appears on the wire. Same authentication as the rest of the API (session cookie or Home Assistant bearer token; `administrator`/`member` roles).

## Capabilities

`KeypadCapability` is one of `arm_disarm`, `emergency`, `indicators`, `chime`. A keypad declares only what it supports; the Ring Keypad v2 (`adapterId` `ring-keypad-v2`) declares all four.

## REST

### `GET /api/v1/keypads` → `200`

```json
{ "keypads": [ {
  "nodeId": 12,
  "adapterId": "ring-keypad-v2",
  "label": "Ring Keypad v2",
  "capabilities": ["arm_disarm", "emergency", "indicators", "chime"],
  "chimeSounds": ["double_beep", "guitar", "wind_chimes", "bing_bong", "doorbell"],
  "connectivityStatus": "online",
  "batteryLevel": 87
} ] }
```

`chimeSounds` is the keypad's own list of sound ids (empty without the `chime` capability). `batteryLevel` is `null` when unknown (mains-powered).

### `POST /api/v1/keypads/{nodeId}/chime` → `204`

Body `{ "sound": "doorbell", "volume": 60 }`; `volume` is optional, an integer 0-99, defaulting to a per-keypad value. `404 not_found` if no keypad has that node id. `400 bad_request` if the body is malformed, the sound is not in that keypad's `chimeSounds`, or the keypad has no `chime` capability.

## WebSocket (`/api/v1/stream`)

- `snapshot` carries an additional `"keypads": KeypadSummary[]`. Absent only when the server has no keypad support wired.
- `keypad.changed`: `{ "type": "keypad.changed", "keypad": KeypadSummary }` when a keypad is discovered or its connectivity or battery changes.
- `keypad.event`: a button press. It **never carries the entered code**.

```json
{ "type": "keypad.event", "nodeId": 12, "adapterId": "ring-keypad-v2", "input": { "kind": "arm_away" } }
```

`input.kind` is one of `code_entered`, `arm_away`, `arm_home`, `disarm`, `cancel`, `emergency`; `emergency` adds `"emergency": "fire" | "police" | "medical"`. Clients must ignore kinds they don't know.

## Server behaviour (clients observe the result as `panel.changed`)

- `disarm` / `code_entered` with a valid user code disarms (a zone-restricted guest disarms only their zone; a locked account or expired guest code is refused like a wrong code). A wrong code plays the keypad's "code rejected" tone. A keypad sends only the code, never who typed it, so unlike `POST /panel/disarm` a wrong code cannot count toward any user's failed-attempt lockout.
- `code_entered` while the panel is already disarmed does nothing.
- `arm_away` / `arm_home` arm with the configured exit delay and need no code by default. Set `KEYPAD_REQUIRE_CODE_TO_ARM=true` to require a valid code.
- `emergency` triggers the alarm immediately (`alarm_triggered`), recording which button was pressed.
- Panel state is mirrored on every keypad that supports `indicators`: mode, exit delay, entry delay and alarm. A keypad that appears or comes back online shows the current state at once.

## Adding support for another keypad

Add one file, `src/keypads/adapters/<name>.adapter.ts`, whose default export implements `KeypadAdapter` (`src/keypads/keypad.ts`): an `id`, `label`, `capabilities`, `chimeSounds`, `supports(identity)`, `decodeInput(notification)` and `encodeIndication(indication)`. Adapters are pure (they never touch the driver, panel or database). Start-up discovers every `*.adapter.ts`/`.js` in that directory and registers it; no existing file is edited. `tests/unit/keypad-registry.test.ts` demonstrates this with a second, made-up keypad.

## Ring Keypad v2 (adapter `ring-keypad-v2`)

Identity: manufacturer `0x0346`, product type `0x0101`, product id `0x0301` or `0x0401` (zwave-js device database, `0x0346/keypad_v2.json`). The keypad must be included with S2 security.

| Direction | Command class | Mapping |
|---|---|---|
| Input | Entry Control (111) | event type 2 Enter → `code_entered`; 3 → `disarm`; 5 → `arm_away`; 6 → `arm_home`; 16/17/19 → `emergency` fire/police/medical; 25 → `cancel`. Types 0 and 1 (caching) are ignored. |
| Output | Indicator (135), endpoint 0 | modes: indicator 2/10/11 (disarmed/armed home/armed away), property 1, value 99; alarm: 13; code rejected: 9; bypass required: 16; entry/exit delay: 17/18 with property 7 = seconds; chimes: 96-100 with property 9 = volume (`double_beep`, `guitar`, `wind_chimes`, `bing_bong`, `doorbell`). |

Source notes: <https://github.com/ImSorryButWho/HomeAssistantNotes/blob/main/RingKeypadV2.md>.
