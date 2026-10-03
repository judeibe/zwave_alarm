"""Persistent WebSocket coordinator driving push updates for the T036-T038 entities (T039).

Subclasses Home Assistant's `DataUpdateCoordinator` but never polls
(`update_interval` is left unset, so `_schedule_refresh` is always a no-op):
`async_set_updated_data`/`async_set_update_error` are instead driven directly
by messages read off a persistent connection to
`wss://<host>/api/v1/stream` (contracts/websocket-events.md). This gets
`CoordinatorEntity`'s standard `should_poll = False` / `available`
(`last_update_success`) wiring for free on every T036-T038 entity built
against it, instead of each one polling independently.

The event-application and backoff-delay logic lives in coordinator_state.py
so it's unit-testable without Home Assistant installed; this module itself
is only verifiable here via `py_compile`/wheel-source inspection (see
api.py's module docstring for why `homeassistant` can't be imported in this
environment).
"""

from __future__ import annotations

import asyncio
import json
import logging

import aiohttp
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.update_coordinator import DataUpdateCoordinator

from .coordinator_state import RECONNECT_BASE_DELAY, RECONNECT_MAX_DELAY, StreamState, apply_event, next_backoff

_LOGGER = logging.getLogger(__name__)


class ZwaveAlarmCoordinator(DataUpdateCoordinator[StreamState]):
    """Owns the WebSocket connection and the latest snapshot+incremental state pushed over it."""

    def __init__(
        self,
        hass: HomeAssistant,
        entry: ConfigEntry,
        session: aiohttp.ClientSession,
        host: str,
        port: int,
        token: str,
    ) -> None:
        super().__init__(hass, _LOGGER, config_entry=entry, name="Z-Wave Alarm stream")
        # DataUpdateCoordinator otherwise starts `last_update_success = True`
        # (it assumes the first poll just hasn't run yet); for a push
        # connection that means every entity would report `available` before
        # a single `snapshot` has ever arrived -- exactly the stale/assumed
        # state contracts/ha-custom-component.md's "Failure handling"
        # section forbids (FR-006).
        self.last_update_success = False
        self._session = session
        self._host = host
        self._port = port
        self._token = token

    def async_start(self, entry: ConfigEntry) -> None:
        """Start the persistent connect/read loop as a config-entry-scoped background task.

        `ConfigEntry.async_create_background_task` cancels this task
        automatically on unload, so `_run`'s `asyncio.CancelledError`
        propagation is all the shutdown coordination this needs.
        """
        entry.async_create_background_task(self.hass, self._run(), "zwave_alarm_stream")

    async def _run(self) -> None:
        """Connect, stream events, and reconnect with backoff until cancelled.

        A reconnect is, from this client's point of view, indistinguishable
        from a first connect: it always opens a brand-new WebSocket, and the
        server always sends a fresh `snapshot` as the first message on any
        new connection (T034's resync guarantee), so no separate "request a
        snapshot" step is needed here beyond simply reconnecting.
        """
        url = f"ws://{self._host}:{self._port}/api/v1/stream"
        headers = {"Authorization": f"Bearer {self._token}"}
        attempt = 0
        while True:
            try:
                async with self._session.ws_connect(url, headers=headers) as ws:
                    attempt = 0
                    async for message in ws:
                        if message.type == aiohttp.WSMsgType.TEXT:
                            self._handle_message(message.data)
            except asyncio.CancelledError:
                raise
            except aiohttp.ClientError as err:
                _LOGGER.debug("Z-Wave Alarm stream connection error: %s", err)

            # The connection just ended (error, or the server/network closed
            # it cleanly) -- per the contract's "Failure handling" section,
            # entities must sit at `unavailable` for the entire outage, not
            # just once backoff eventually gives up.
            self.async_set_update_error(ConnectionError("Z-Wave Alarm stream disconnected"))
            delay = next_backoff(attempt, RECONNECT_BASE_DELAY, RECONNECT_MAX_DELAY)
            attempt += 1
            await asyncio.sleep(delay)

    def _handle_message(self, raw: str) -> None:
        """Parse one server->client event and fold it into `self.data`."""
        try:
            event = json.loads(raw)
        except ValueError:
            _LOGGER.debug("Ignoring malformed Z-Wave Alarm stream message")
            return
        current = self.data if self.data is not None else StreamState(panel=None, zones=[])
        self.async_set_updated_data(apply_event(current, event))
