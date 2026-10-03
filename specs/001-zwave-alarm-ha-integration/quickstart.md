# Quickstart: Validating the Self-Hosted Z-Wave Alarm System

## Prerequisites

- Node.js 22 LTS or newer (`better-sqlite3` requires it), a Z-Wave USB controller (or `zwave-js`'s mock driver for hardware-free testing), and a Home Assistant dev instance on the same network.
- Docker (for the containerized run) with the controller's device path available (e.g., `/dev/serial/by-id/...`).
- `curl` and `jq` for the commands below.

> **No controller attached?** The service still starts: the `zwave-js` driver logs a `zwave-js driver failed to start` error and the REST/WebSocket surface stays up. Everything that does not need a real Z-Wave node can then be validated (sections 2, 3 steps 2 and 4, 4's service-side steps, and the lockout half of 6). Assigning a sensor (`POST /zones/{id}/sensors`) answers `503` until the driver is ready, and the steps that need a physical sensor, siren, or Home Assistant instance are marked **(hardware)** below.

## 1. Run the service

```bash
npm install
cp .env.example .env   # set SERIAL_PORT, and SESSION_SECRET to a real value (openssl rand -hex 32); the service refuses to start with the placeholder
npm run dev            # builds, then starts the service (reads .env)
```

Or via the container, with device passthrough. `SERIAL_PORT` must be the **in-container** path the device is mapped to, and the database needs a volume to survive restarts:

```bash
docker build -t zwave-alarm .
docker run -d --name zwave-alarm \
  --device=/dev/serial/by-id/<your-controller>:/dev/zwave \
  -p 3000:3000 -p 3001:3001 \
  -v zwave-alarm-data:/app/data \
  --env-file .env -e SERIAL_PORT=/dev/zwave -e DB_PATH=/app/data/alarm.db \
  zwave-alarm
```

(`docker compose up -d` does the same using `docker-compose.yml`.) Confirm it is up: `curl localhost:3000/healthz` → `{"status":"ok"}`. Every log line is a single JSON object (`docker logs zwave-alarm`); set `LOG_LEVEL=debug` to also see per-node value changes.

## 2. Bootstrap the first administrator and a zone

Every endpoint needs an authenticated caller, so a fresh install has one exception: while **no users exist**, `POST /api/v1/users` is accepted without credentials, but only to create an `administrator`. Once any user exists it requires an administrator session like everything else.

```bash
API=localhost:3000/api/v1
curl -X POST $API/users -H 'Content-Type: application/json' \
  -d '{"name":"Owner","role":"administrator","code":"123456"}'

# Log in (stores the session cookie), then use it for administrator-only calls.
curl -c jar -X POST $API/auth/login -H 'Content-Type: application/json' -d '{"code":"123456"}'
curl -b jar -X POST $API/zones -H 'Content-Type: application/json' -d '{"name":"Front Door"}'
```

Confirm the bootstrap window has closed: repeating the first `POST /users` now returns `401`.

## 3. Validate User Story 1 — standalone arm/disarm/monitor (no Home Assistant running)

1. **(hardware)** Assign a paired Z-Wave contact sensor to the "Front Door" zone with `category: intrusion`: `curl -b jar -X POST $API/zones/<zoneId>/sensors -H 'Content-Type: application/json' -d '{"zwaveNodeId":2,"name":"Front door contact","category":"intrusion"}'` (see `contracts/rest-api.md`).
2. Arm the system: `curl -b jar -X POST $API/panel/arm -H 'Content-Type: application/json' -d '{"mode":"armed_away"}'` returns immediately with `arming`. `GET $API/panel` shows `arming` with a `pendingDelayEndsAt`, then `armed_away` once the exit delay has elapsed (30 s unless `EXIT_DELAY_SECONDS` is set). Arming again while armed returns `409`.
3. **(hardware)** Open the door. Confirm the panel moves to `alarm_pending`, then `alarm_triggered` after the entry delay, and the configured siren activates (SC-001, SC-002, User Story 1 acceptance scenarios 1–2).
4. Disarm with the administrator's code (`curl -b jar -X POST $API/panel/disarm -H 'Content-Type: application/json' -d '{"code":"123456"}'`) and confirm the panel returns to `disarmed` (acceptance scenario 3). `GET $API/events` lists the `armed`/`disarmed` events, newest first.
5. **(hardware)** Unplug or disable a sensor and confirm it is reported as a `device_fault`, distinct from a breach (acceptance scenario 4, FR-012).

## 4. Validate User Story 2 — Home Assistant integration

1. **(hardware)** In Home Assistant, add the built-in "Z-Wave JS" integration pointed at this service's `zwave-js-server` port (3001) — confirm the raw sensor entities appear automatically.
2. Issue a token: `curl -b jar -X POST $API/ha-links -H 'Content-Type: application/json' -d '{"label":"dev-ha"}'`. The plaintext `token` is returned **once**; only its hash is stored.
3. Check the token the way the config flow does: `curl -H "Authorization: Bearer <token>" $API/panel` → `200` (a wrong token → `401`).
4. **(hardware)** Install `ha-integration/custom_components/zwave_alarm` into the Home Assistant dev instance and complete its config flow with the service host and token.
5. **(hardware)** Confirm `alarm_control_panel.zwave_alarm` appears and reflects the panel's current mode.
6. Confirm the push channel is authenticated and live. A client with no credentials is refused (`401`) during the WebSocket handshake; with the token (header `Authorization: Bearer <token>`) or a dashboard session cookie it receives a `snapshot`, then `panel.changed` as soon as you arm/disarm (SC-002). Disarming with the token (`curl -H "Authorization: Bearer <token>" -X POST $API/panel/disarm …`) is recorded with `source: home_assistant`; **(hardware)** confirm the Home Assistant entity updates within a couple of seconds in both directions.
7. Restart the service (`docker restart zwave-alarm`; it stops cleanly in well under a second, logging `shutting down` and `shutdown complete`). The token and users persist, and an exit or entry delay in flight resumes with the time that was left; browser sessions do not (log in again). A reconnecting client receives a fresh `snapshot` first. **(hardware)** Confirm the Home Assistant entity goes `unavailable` (not `disarmed`) while the service is down, then resyncs to the correct current state on restart (FR-006, Edge Cases).
8. Revoke the token (`DELETE $API/ha-links/<linkId>`) and confirm both `GET /panel` and a WebSocket connection with it now return `401`.

## 5. Validate User Story 3 — alerts on trigger

1. **(hardware)** Trigger a breach as in step 3 above and confirm the local siren activates immediately (FR-013). Without `SIREN_NODE_ID` set, the service logs a `no siren device configured` warning at start-up and again when an alarm triggers.
2. **(hardware)** Build a simple Home Assistant automation on `alarm_control_panel.zwave_alarm` changing to `triggered` that sends a mobile notification, confirming the "remote notification via Home Assistant automation" design (FR-013). See `ha-integration/README.md` for a sample.

## 6. Validate life-safety gating and lockout (Clarifications, FR-015/FR-016)

1. **(hardware)** While `disarmed`, simulate a smoke sensor triggering (`category: life-safety`) and confirm the panel enters `alarm_triggered` immediately, with no entry delay.
2. Check the policy as an administrator: `curl -b jar $API/lockout-policy` returns `{"failedAttemptThreshold":5,"cooldownSeconds":300,"onThresholdExceeded":"lockout"}`. Create two members so the administrator is never the one locked out, and log in as the first:

   ```bash
   for n in 1 2; do curl -b jar -X POST $API/users -H 'Content-Type: application/json' -d "{\"name\":\"Tester $n\",\"role\":\"member\",\"code\":\"tester$n\"}"; done
   curl -c t1 -X POST $API/auth/login -H 'Content-Type: application/json' -d '{"code":"tester1"}'
   ```

   Attempt to disarm with an incorrect code repeatedly: `curl -b t1 -X POST $API/panel/disarm -H 'Content-Type: application/json' -d '{"code":"000000"}'`. The first four attempts return `401`; the fifth (the default threshold) returns `423` and the account stays locked, so even the correct code is refused, and a `lockout` `SecurityEvent` is recorded.
3. Switch the policy to treat repeated failures as an alarm: `curl -b jar -X PATCH $API/lockout-policy -H 'Content-Type: application/json' -d '{"onThresholdExceeded":"trigger_alarm"}'` (any of `failedAttemptThreshold` 1-100, `cooldownSeconds` 1-86400 and `onThresholdExceeded` may be sent). Log in as the second member (`curl -c t2 …` with `tester2`) and repeat step 2 with `-b t2`: the fifth failure instead returns `200` with the panel in `alarm_triggered`. Clear it with the administrator's code, and set the policy back to `lockout` if you want the default.

## 6b. Validate zone-restricted guests (FR-010a)

1. Create a second zone ("Upstairs") and a guest restricted to "Front Door": `curl -b jar -X POST $API/users -H 'Content-Type: application/json' -d '{"name":"Sitter","role":"guest","code":"guest1","guestZoneId":"<Front Door zoneId>"}'`. An unknown `guestZoneId` returns `400`.
2. Put the panel into an armed state (§3 step 2), log in as the guest (`curl -c g -X POST $API/auth/login … '{"code":"guest1"}'`) and disarm: `curl -b g -X POST $API/panel/disarm -H 'Content-Type: application/json' -d '{"code":"guest1"}'`. The response keeps `mode` armed and lists the zone in `disarmedZoneIds`; `GET $API/panel` as an administrator agrees, and `GET $API/events` shows a `disarmed` event for that zone plus a `guest_code_used` event.
3. **(hardware)** Breach a sensor in the Front Door zone: the panel ignores it. Breach one in Upstairs: it goes `alarm_pending` as normal. A smoke sensor in either zone still triggers immediately.
4. Fully disarm with the administrator's code, then arm again: Front Door is protected again (`disarmedZoneIds` is empty).

## 7. Input validation and rate limiting (Phase 5 hardening)

1. Malformed input is rejected with `400` in the standard error format on every endpoint, e.g. `curl -b jar -X POST $API/panel/arm -H 'Content-Type: application/json' -d '{"mode":"nonsense"}'` → `{"error":{"code":"bad_request","message":"Invalid request body: …"}}`; likewise `GET $API/events?limit=abc`.
2. More than 5 failed `POST /auth/login` attempts from one IP within a minute return `429` (`too_many_requests`) with a `Retry-After` header. Successful logins do not count against the limit.
