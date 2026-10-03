# Z-Wave Alarm

A self-hosted home alarm system that runs on your own hardware. A Z-Wave USB controller plugged into the machine running this service is the only thing it needs: it owns the controller through `zwave-js`, monitors your door, window, motion and smoke/CO sensors, and arms, disarms and raises the alarm entirely on its own, with no cloud and no dependency on any other app. If you use Home Assistant, the same service exposes its raw devices through the standard `zwave-js-server` protocol and ships a custom component that surfaces the alarm panel and zones as native entities for dashboards and automations. The full requirements are in [specs/001-zwave-alarm-ha-integration/spec.md](specs/001-zwave-alarm-ha-integration/spec.md).

Scope: a dedicated mobile app, camera/video, and professional monitoring dispatch are out of scope. The local siren is the authoritative alert; remote notifications are delegated to Home Assistant automations (see [ha-integration/README.md](ha-integration/README.md)).

## How it fits together

```
Z-Wave USB controller ── zwave-js driver ──┬── alarm engine (arm/disarm, delays, lockout) ── SQLite
                                           ├── REST API + WebSocket push  (HTTP_PORT, default 3000)
                                           │       └── bundled web dashboard, Home Assistant custom component
                                           └── zwave-js-server            (ZWAVE_SERVER_PORT, default 3001)
                                                   └── Home Assistant's built-in "Z-Wave JS" integration
```

- **Alarm panel:** `disarmed` → `arming` (30 s exit delay) → `armed_away` / `armed_home`; a breach on an intrusion sensor goes `alarm_pending` (30 s entry delay) → `alarm_triggered`. Life-safety sensors (smoke, CO) trigger immediately in any state.
- **Roles:** administrator (full control), member (arm/disarm and view), guest (a time-limited or zone-restricted code).
- **Lockout:** repeated wrong disarm codes lock the account, or, if configured, trigger the alarm.

## Requirements

- Node.js **22 or newer** (needed by `better-sqlite3`), or Docker.
- A Z-Wave USB controller. Without one the service still starts and serves the API, but no sensors can be assigned; this is useful for trying it out.

## Setup

```bash
npm install
cp .env.example .env     # then edit it: SERIAL_PORT, and a real SESSION_SECRET (openssl rand -hex 32)
npm run dev              # builds, then starts the service (loads .env)
```

Then create the first administrator and log in. While no users exist, `POST /api/v1/users` is accepted without credentials, but only to create an administrator:

```bash
curl -X POST localhost:3000/api/v1/users -H 'Content-Type: application/json' \
  -d '{"name":"Owner","role":"administrator","code":"123456"}'
```

Open `http://localhost:3000/` for the dashboard, or follow [the quickstart](specs/001-zwave-alarm-ha-integration/quickstart.md) for a complete walkthrough with `curl`.

## Configuration

All configuration is through environment variables (a `.env` file is read by `npm start`/`npm run dev`; Docker uses `--env-file` or `docker-compose.yml`). The service refuses to start if a required variable is missing or invalid.

| Variable | Required | Default | Description |
|---|---|---|---|
| `SERIAL_PORT` | yes | none | Serial device of the Z-Wave controller, e.g. `/dev/serial/by-id/usb-...` on bare metal. In Docker, the in-container path the device is mapped to (`/dev/zwave` with the provided compose file). |
| `DB_PATH` | yes | none | SQLite database file. The parent directory is created if needed. In Docker, put it on a volume (`/app/data/alarm.db`). |
| `HTTP_PORT` | yes | none | Port for the REST API, WebSocket push channel (`/api/v1/stream`) and dashboard. |
| `ZWAVE_SERVER_PORT` | yes | none | Port `zwave-js-server` listens on, which Home Assistant's "Z-Wave JS" integration connects to. Must differ from `HTTP_PORT`. |
| `SESSION_SECRET` | yes | none | Secret used to sign dashboard session cookies: at least 32 characters, and not the `.env.example` placeholder (the service refuses to start otherwise). Generate one with `openssl rand -hex 32`. |
| `ZWAVE_SERVER_HOST` | no | `0.0.0.0` | Interface `zwave-js-server` binds to. It needs to be reachable from Home Assistant but should not be exposed to the internet. |
| `SIREN_NODE_ID` | no | unset | Z-Wave node id of the paired siren/alert device. Without it the alarm works but nothing sounds locally, and a warning is logged. |
| `LOG_LEVEL` | no | `info` | `debug`, `info`, `warn` or `error`. `debug` adds per-node Z-Wave value changes. |

## Deployment with Docker

The `Dockerfile` is a multi-stage build (Node 22, dependencies cached ahead of the source, dev dependencies pruned from the runtime image) and builds for both `linux/amd64` and `linux/arm64`.

```bash
cp .env.example .env     # set SESSION_SECRET (SERIAL_PORT and DB_PATH are overridden by the compose file)
# edit docker-compose.yml: replace /dev/serial/by-id/your-controller with your controller's path
docker compose up -d
docker compose logs -f
```

The compose file maps the controller into the container as `/dev/zwave`, publishes `3000` (API/dashboard) and `3001` (`zwave-js-server`), and stores the database in the `zwave-alarm-data` volume. This process must be the only one using the serial port. To build for both architectures: `docker buildx build --platform linux/amd64,linux/arm64 .`

Put the API behind a reverse proxy with TLS if you expose it beyond your LAN. The login rate limit is per client IP, so configure the proxy to forward the real client address.

## Home Assistant

1. Add the built-in **Z-Wave JS** integration pointed at this host and `ZWAVE_SERVER_PORT` for the raw sensor entities.
2. Issue a token as an administrator: `POST /api/v1/ha-links` with `{"label":"home-assistant"}`. The token is shown once.
3. Copy `ha-integration/custom_components/zwave_alarm` into Home Assistant's `custom_components` and add the integration with this host, `HTTP_PORT`, and the token.

Details and a sample notification automation are in [ha-integration/README.md](ha-integration/README.md).

## API

REST endpoints, the WebSocket event stream and the Home Assistant entity contract are documented in [specs/001-zwave-alarm-ha-integration/contracts/](specs/001-zwave-alarm-ha-integration/contracts/). Every request body is validated and rejected with `400` in a consistent `{ "error": { "code", "message" } }` format.

## Security notes

- Disarm codes are stored as salted `scrypt` hashes. Home Assistant tokens are 256-bit random values stored as SHA-256 hashes (they are high-entropy and looked up by hash, so a slow salted hash would not apply).
- `POST /api/v1/auth/login` is limited to 5 failed attempts per IP per minute (`429` after that), on top of the per-account lockout.
- The WebSocket push channel requires the same credentials as the REST API at connect time.
- Dashboard sessions are held in memory and expire after 12 hours; they are lost when the service restarts, so you log in again. Home Assistant tokens are persistent.

## Logging

Every log line is one JSON object (`timestamp`, `level`, `module`, `message`, plus fields) on stdout/stderr: each REST request (method, path, status, duration), WebSocket connects and disconnects, every alarm state transition with its old and new mode and cause, and Z-Wave driver and device events. Output from the underlying `zwave-js` library, if it logs anything itself, is not controlled by this service.

## Development

```bash
npm run build     # compile TypeScript to dist/ and copy the dashboard assets
npm run lint
npm test          # Vitest
cd ha-integration && python3 -m venv .venv && .venv/bin/pip install -r requirements-test.txt && .venv/bin/python -m pytest
```
