"""Minimal REST client for the Z-Wave Alarm service.

Factored out of config_flow.py (and, as of T036, alarm_control_panel.py) so
the request/response handling -- the part worth testing -- doesn't require a
running Home Assistant instance to exercise; the entity/config-flow modules
that call into this one are left as thin HA glue around it.
"""

from __future__ import annotations

from typing import Any

import aiohttp

REQUEST_TIMEOUT = aiohttp.ClientTimeout(total=10)


class CannotConnect(Exception):
    """Raised when the Z-Wave Alarm service cannot be reached."""


class InvalidAuth(Exception):
    """Raised when the service rejects the provided API token or code (401)."""


class AccountLocked(Exception):
    """Raised when the caller's account is locked out from repeated bad codes (423)."""


class CommandRejected(Exception):
    """Raised when a conflicting concurrent command wins the race (409, FR-014)."""


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


async def async_get_panel_state(
    session: aiohttp.ClientSession, host: str, port: int, token: str
) -> dict[str, Any]:
    """Fetch the current AlarmPanel state via `GET /api/v1/panel`.

    Same request as `async_validate_connection` (config flow's one-time
    check); this is the name the polling entity (T036) reaches for.
    """
    return await async_validate_connection(session, host, port, token)


async def async_arm(
    session: aiohttp.ClientSession, host: str, port: int, token: str, mode: str
) -> dict[str, Any]:
    """Call `POST /api/v1/panel/arm` with `{"mode": mode}` and return the new AlarmPanel state.

    `mode` must be `"armed_away"` or `"armed_home"` per contracts/rest-api.md.
    A `409` means a conflicting native-interface command won the race
    (FR-014) and is surfaced as `CommandRejected`.
    """
    url = f"http://{host}:{port}/api/v1/panel/arm"
    headers = {"Authorization": f"Bearer {token}"}
    try:
        async with session.post(
            url, headers=headers, json={"mode": mode}, timeout=REQUEST_TIMEOUT
        ) as response:
            if response.status == 401:
                raise InvalidAuth
            if response.status == 409:
                raise CommandRejected
            response.raise_for_status()
            return await response.json()
    except aiohttp.ClientError as err:
        raise CannotConnect from err


async def async_disarm(
    session: aiohttp.ClientSession, host: str, port: int, token: str, code: str
) -> dict[str, Any]:
    """Call `POST /api/v1/panel/disarm` with `{"code": code}` and return the new AlarmPanel state.

    A `401` here means the code (not the bearer token, which was already
    proven valid during the config flow) was rejected. A `423` means the
    caller's account is locked from repeated bad codes.
    """
    url = f"http://{host}:{port}/api/v1/panel/disarm"
    headers = {"Authorization": f"Bearer {token}"}
    try:
        async with session.post(
            url, headers=headers, json={"code": code}, timeout=REQUEST_TIMEOUT
        ) as response:
            if response.status == 401:
                raise InvalidAuth
            if response.status == 423:
                raise AccountLocked
            if response.status == 409:
                raise CommandRejected
            response.raise_for_status()
            return await response.json()
    except aiohttp.ClientError as err:
        raise CannotConnect from err
