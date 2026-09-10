"""Minimal REST client for validating a connection to the Z-Wave Alarm service.

Factored out of config_flow.py so the request/response handling (the part
worth testing) doesn't require a running Home Assistant instance to exercise
-- config_flow.py itself is left as thin glue around this module.
"""

from __future__ import annotations

from typing import Any

import aiohttp

REQUEST_TIMEOUT = aiohttp.ClientTimeout(total=10)


class CannotConnect(Exception):
    """Raised when the Z-Wave Alarm service cannot be reached."""


class InvalidAuth(Exception):
    """Raised when the service rejects the provided API token (401)."""


async def async_validate_connection(
    session: aiohttp.ClientSession, host: str, port: int, token: str
) -> dict[str, Any]:
    """Call `GET /api/v1/panel` and return the decoded AlarmPanel state.

    Per contracts/ha-custom-component.md's "Config flow" section: a `401`
    response is a distinct, user-correctable error (bad token) from any other
    failure (unreachable host, bad port, timeout), which is surfaced as
    `CannotConnect`.
    """
    url = f"http://{host}:{port}/api/v1/panel"
    headers = {"Authorization": f"Bearer {token}"}
    try:
        async with session.get(url, headers=headers, timeout=REQUEST_TIMEOUT) as response:
            if response.status == 401:
                raise InvalidAuth
            response.raise_for_status()
            return await response.json()
    except aiohttp.ClientError as err:
        raise CannotConnect from err
