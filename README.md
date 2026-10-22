
## Related repositories

- [ha-zwave-alarm](https://github.com/judeibe/ha-zwave-alarm): Home Assistant integration (HACS).
- [zwave-alarm-client](https://github.com/judeibe/zwave-alarm-client): Python REST client for this service's API, published to PyPI.

## Authentication

The API needs no token by default, so the Home Assistant integration connects with host and port only. To require sessions and Home Assistant bearer tokens again, set `API_AUTH_REQUIRED=true` in the environment. Anyone who can reach the HTTP port has full administrator access while it is off, so keep the service on a trusted network.

## Z-Wave controller soft-reset

zwave-js soft-resets the stick while starting. Some sticks stop answering afterwards, typically under USB passthrough (Proxmox, `devices:`), and the driver fails with `The Serial API did not respond after soft-reset (ZW0100)`. Set `ZWAVE_SOFT_RESET=false` in the environment to skip the soft-reset (default `true`). zwave-js's own `ZWAVEJS_DISABLE_SOFT_RESET=1` is honoured when `ZWAVE_SOFT_RESET` is unset.

A failed start, including ZW0100, is retried on a fresh driver with a backoff of 2 s doubling to 60 s. While it retries, `GET /api/v1/panel` reports `driver.status` as `failed` with `lastError` and `nextRetryAt`.
