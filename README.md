
## Related repositories

- [ha-zwave-alarm](https://github.com/judeibe/ha-zwave-alarm): Home Assistant integration (HACS).
- [zwave-alarm-client](https://github.com/judeibe/zwave-alarm-client): Python REST client for this service's API, published to PyPI.

## Authentication

The API needs no token by default, so the Home Assistant integration connects with host and port only. To require sessions and Home Assistant bearer tokens again, set `API_AUTH_REQUIRED=true` in the environment. Anyone who can reach the HTTP port has full administrator access while it is off, so keep the service on a trusted network.
