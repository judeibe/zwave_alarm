"""Tests for the config flow's connection-validation logic (T035).

Exercises `api.async_validate_connection` directly against a mocked HTTP
endpoint (aioresponses) rather than through Home Assistant's `ConfigFlow`
machinery, since `config_flow.py`'s only real logic is delegated here.
"""

from __future__ import annotations

import sys
from pathlib import Path

import aiohttp
import pytest
from aioresponses import aioresponses

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "custom_components" / "zwave_alarm"))

from api import CannotConnect, InvalidAuth, async_validate_connection  # noqa: E402

HOST = "192.168.1.50"
PORT = 3000
TOKEN = "a-valid-token"
PANEL_URL = f"http://{HOST}:{PORT}/api/v1/panel"


@pytest.mark.asyncio
async def test_returns_panel_state_on_success() -> None:
    panel = {"mode": "disarmed", "pendingDelayEndsAt": None, "triggeredBy": None}
    with aioresponses() as mocked:
        mocked.get(PANEL_URL, status=200, payload=panel)
        async with aiohttp.ClientSession() as session:
            result = await async_validate_connection(session, HOST, PORT, TOKEN)

    assert result == panel


@pytest.mark.asyncio
async def test_raises_invalid_auth_on_401() -> None:
    with aioresponses() as mocked:
        mocked.get(PANEL_URL, status=401)
        async with aiohttp.ClientSession() as session:
            with pytest.raises(InvalidAuth):
                await async_validate_connection(session, HOST, PORT, TOKEN)


@pytest.mark.asyncio
async def test_raises_cannot_connect_on_server_error() -> None:
    with aioresponses() as mocked:
        mocked.get(PANEL_URL, status=500)
        async with aiohttp.ClientSession() as session:
            with pytest.raises(CannotConnect):
                await async_validate_connection(session, HOST, PORT, TOKEN)


@pytest.mark.asyncio
async def test_raises_cannot_connect_on_network_failure() -> None:
    with aioresponses() as mocked:
        mocked.get(PANEL_URL, exception=aiohttp.ClientConnectionError())
        async with aiohttp.ClientSession() as session:
            with pytest.raises(CannotConnect):
                await async_validate_connection(session, HOST, PORT, TOKEN)
