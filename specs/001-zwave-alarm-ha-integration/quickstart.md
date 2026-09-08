# Quickstart: Validating the Self-Hosted Z-Wave Alarm System

## Prerequisites

- Node.js 20 LTS, a Z-Wave USB controller (or `zwave-js`'s mock driver for hardware-free testing), and a Home Assistant dev instance on the same network.
- Docker (for the containerized run) with the controller's device path available (e.g., `/dev/serial/by-id/...`).

## 1. Run the service

```bash
npm install
cp .env.example .env   # set SERIAL_PORT, DB_PATH, WS/REST ports
npm run dev
```

Or via the container, with device passthrough:

```bash
docker build -t zwave-alarm .
docker run --device=/dev/serial/by-id/<your-controller> -p 3000:3000 -p 3001:3001 --env-file .env zwave-alarm
```

## 2. Bootstrap the first administrator and a zone

```bash
curl -X POST localhost:3000/api/v1/users -H 'Content-Type: application/json' \
  -d '{"name":"Owner","role":"administrator","code":"123456"}'
curl -X POST localhost:3000/api/v1/zones -H 'Content-Type: application/json' \
  -d '{"name":"Front Door"}'
```

## 3. Validate User Story 1 — standalone arm/disarm/monitor (no Home Assistant running)

1. Assign a paired Z-Wave contact sensor to the "Front Door" zone with `category: intrusion` via `POST /api/v1/zones/{zoneId}/sensors` (see `contracts/rest-api.md`).
2. Arm the system: `POST /api/v1/panel/arm { "mode": "armed_away" }`. Confirm `GET /api/v1/panel` shows `arming` then `armed_away` after the exit delay.
3. Open the door. Confirm the panel moves to `alarm_pending`, then `alarm_triggered` after the entry delay, and the configured siren activates (SC-001, SC-002, User Story 1 acceptance scenarios 1–2).
4. Disarm with the administrator's code and confirm the panel returns to `disarmed` (acceptance scenario 3).
5. Unplug or disable a sensor and confirm it is reported as a `device_fault`, distinct from a breach (acceptance scenario 4, FR-012).

## 4. Validate User Story 2 — Home Assistant integration

1. In Home Assistant, add the built-in "Z-Wave JS" integration pointed at this service's `zwave-js-server` port — confirm the raw sensor entities appear automatically.
2. Issue a token: `POST /api/v1/ha-links {"label": "dev-ha"}`.
3. Install `ha-integration/custom_components/zwave_alarm` into the Home Assistant dev instance and complete its config flow with the service host and token.
4. Confirm `alarm_control_panel.zwave_alarm` appears and reflects the panel's current mode.
5. Arm/disarm from the native REST API and confirm the Home Assistant entity updates within a couple of seconds (SC-002); then arm/disarm from Home Assistant and confirm it is reflected back via `GET /api/v1/panel`.
6. Stop the service, confirm the Home Assistant entity goes `unavailable` (not `disarmed`), then restart it and confirm the custom component resyncs to the correct current state (FR-006, Edge Cases).

## 5. Validate User Story 3 — alerts on trigger

1. Trigger a breach as in step 3 above and confirm the local siren activates immediately (FR-013).
2. Build a simple Home Assistant automation on `alarm_control_panel.zwave_alarm` changing to `triggered` that sends a mobile notification, confirming the "remote notification via Home Assistant automation" design (FR-013).

## 6. Validate life-safety gating and lockout (Clarifications, FR-015/FR-016)

1. While `disarmed`, simulate a smoke sensor triggering (`category: life-safety`) and confirm the panel enters `alarm_triggered` immediately, with no entry delay.
2. Attempt to disarm with an incorrect code repeatedly and confirm the account locks out after the configured threshold and a `lockout` `SecurityEvent` is recorded; then flip `LockoutPolicy.onThresholdExceeded` to `trigger_alarm` and confirm repeated failures instead raise `alarm_triggered`.
