"""The `alarm_control_panel.zwave_alarm` entity (T036).

Maps `AlarmPanel.mode` (src/alarm/panel-repository.ts) to Home Assistant's
standard `alarm_control_panel` states and implements `arm_away`/`arm_home`/
`disarm` services against Phase 02's REST endpoints, per
contracts/ha-custom-component.md's "Entities exposed to Home Assistant"
section.

This entity polls (`should_poll` defaults to `True`) until T039 adds the
WebSocket coordinator for push updates (FR-008) and takes over the
`unavailable`-on-disconnect handling required by the contract's "Failure
handling" section -- this entity still honors that requirement for now via
`async_update`, just on a polling cadence rather than pushed events.
"""

from __future__ import annotations

import logging
from typing import Any, Awaitable, Callable

from homeassistant.components.alarm_control_panel import (
    AlarmControlPanelEntity,
    AlarmControlPanelEntityFeature,
    AlarmControlPanelState,
    CodeFormat,
)
from homeassistant.config_entries import ConfigEntry
from homeassistant.const import CONF_ACCESS_TOKEN, CONF_HOST, CONF_PORT
from homeassistant.core import HomeAssistant
from homeassistant.exceptions import HomeAssistantError, ServiceValidationError
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from homeassistant.helpers.entity import DeviceInfo
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from . import api
from .const import DOMAIN
from .panel_state import map_panel_mode

_LOGGER = logging.getLogger(__name__)


async def async_setup_entry(
    hass: HomeAssistant, entry: ConfigEntry, async_add_entities: AddEntitiesCallback
) -> None:
    """Set up the alarm_control_panel entity for a config entry."""
    async_add_entities([ZwaveAlarmControlPanel(hass, entry)])


class ZwaveAlarmControlPanel(AlarmControlPanelEntity):
    """Represents this service's AlarmPanel singleton as an HA alarm_control_panel."""

    _attr_has_entity_name = True
    _attr_name = None
    _attr_supported_features = (
        AlarmControlPanelEntityFeature.ARM_HOME | AlarmControlPanelEntityFeature.ARM_AWAY
    )
    # POST /api/v1/panel/arm takes no code (contracts/rest-api.md); disarm
    # always requires the caller's own code.
    _attr_code_arm_required = False
    _attr_code_format = CodeFormat.TEXT

    def __init__(self, hass: HomeAssistant, entry: ConfigEntry) -> None:
        self._hass = hass
        self._host: str = entry.data[CONF_HOST]
        self._port: int = entry.data[CONF_PORT]
        self._token: str = entry.data[CONF_ACCESS_TOKEN]
        self._attr_unique_id = f"{entry.entry_id}_panel"
        self._attr_device_info = DeviceInfo(
            identifiers={(DOMAIN, entry.entry_id)},
            name="Z-Wave Alarm",
            manufacturer="Z-Wave Alarm",
        )

    async def async_update(self) -> None:
        """Poll `GET /api/v1/panel` and update state."""
        session = async_get_clientsession(self._hass)
        try:
            panel = await api.async_get_panel_state(session, self._host, self._port, self._token)
        except (api.CannotConnect, api.InvalidAuth):
            # Per contracts/ha-custom-component.md's "Failure handling": an
            # unreachable/unauthorized service must go `unavailable`, never
            # `disarmed` -- the alarm's own state is authoritative and must
            # not be inferred from HA's ability to reach it (FR-006).
            self._attr_available = False
            return

        self._attr_available = True
        self._attr_alarm_state = AlarmControlPanelState(map_panel_mode(panel["mode"]))

    async def async_alarm_arm_away(self, code: str | None = None) -> None:
        """Arm away via `POST /api/v1/panel/arm`."""
        await self._async_call(api.async_arm, mode="armed_away")

    async def async_alarm_arm_home(self, code: str | None = None) -> None:
        """Arm home via `POST /api/v1/panel/arm`."""
        await self._async_call(api.async_arm, mode="armed_home")

    async def async_alarm_disarm(self, code: str | None = None) -> None:
        """Disarm via `POST /api/v1/panel/disarm`; a code is always required."""
        if not code:
            raise ServiceValidationError("A code is required to disarm this alarm.")
        await self._async_call(api.async_disarm, code=code)

    async def _async_call(
        self, func: Callable[..., Awaitable[dict[str, Any]]], **kwargs: Any
    ) -> None:
        """Invoke an api.py arm/disarm call and apply the returned AlarmPanel state."""
        session = async_get_clientsession(self._hass)
        try:
            panel = await func(session, self._host, self._port, self._token, **kwargs)
        except api.InvalidAuth as err:
            raise ServiceValidationError(
                "The Z-Wave Alarm service rejected the Home Assistant token or code."
            ) from err
        except api.AccountLocked as err:
            raise HomeAssistantError(
                "This account is locked from repeated invalid codes. Try again later."
            ) from err
        except api.CommandRejected as err:
            raise HomeAssistantError(
                "The Z-Wave Alarm service rejected this command in favor of a conflicting request."
            ) from err
        except api.CannotConnect as err:
            raise HomeAssistantError("Could not reach the Z-Wave Alarm service.") from err

        self._attr_available = True
        self._attr_alarm_state = AlarmControlPanelState(map_panel_mode(panel["mode"]))
        self.async_write_ha_state()
