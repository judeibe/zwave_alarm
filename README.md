
## Related repositories

- [ha-zwave-alarm](https://github.com/judeibe/ha-zwave-alarm): Home Assistant integration (HACS).
- [zwave-alarm-client](https://github.com/judeibe/zwave-alarm-client): Python REST client for this service's API, published to PyPI.

## Authentication

The API needs no token by default, so the Home Assistant integration connects with host and port only. To require sessions and Home Assistant bearer tokens again, set `API_AUTH_REQUIRED=true` in the environment. Anyone who can reach the HTTP port has full administrator access while it is off, so keep the service on a trusted network.

## API behaviour to know about

Full routes and shapes are in `specs/001-zwave-alarm-ha-integration/contracts/`. Two behaviours trip people up:

- **User code routes return a body.** `PUT` and `DELETE /api/v1/users/{id}/code` answer `200` with `{ "lockSync": [...] }`
  (one `{ nodeId, slot, status: "synced" | "failed", message? }` per enrolled lock; `[]` when none) because a code is
  pushed to, or cleared from, the locks. They answer `204` with no body only where lock code sync is not configured, and
  every server older than v3.7.0 does. Treat both as success. `POST /users` returns the user plus `lockSync` the same way.
- **Failed attempts are throttled per IP and answer `429`.** `POST /auth/login` allows 5 failed attempts a minute,
  `POST /panel/disarm` allows 10, and `POST /users` allows 30 requests a minute. A throttled call returns
  `{ "error": { "code": "too_many_requests", "message": ... } }` with a `Retry-After` header (seconds); wait that long
  before trying again rather than retrying in a loop. Home Assistant shares one IP, so failures from it count together.

## Z-Wave controller soft-reset

zwave-js soft-resets the stick while starting. Some sticks stop answering afterwards, typically under USB passthrough (Proxmox, `devices:`), and the driver fails with `The Serial API did not respond after soft-reset (ZW0100)`. Set `ZWAVE_SOFT_RESET=false` in the environment to skip the soft-reset (default `true`). zwave-js's own `ZWAVEJS_DISABLE_SOFT_RESET=1` is honoured when `ZWAVE_SOFT_RESET` is unset.

A failed start, including ZW0100, is retried on a fresh driver with a backoff of 2 s doubling to 60 s. While it retries, `GET /api/v1/panel` reports `driver.status` as `failed` with `lastError` and `nextRetryAt`.
