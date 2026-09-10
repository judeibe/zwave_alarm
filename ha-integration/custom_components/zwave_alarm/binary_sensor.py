"""Per-zone `binary_sensor.zwave_alarm_zone_<zone>` entities (T037).

One entity per Zone (from `GET /api/v1/zones`), `on` when any sensor in that
zone is `breached`, with each sensor's `category` exposed as an entity
attribute, per contracts/ha-custom-component.md's "Entities exposed to Home
Assistant" section.

Like alarm_control_panel.py (T036), this polls (`should_poll` defaults to
`True`) until T039 adds the WebSocket coordinator for push updates (FR-008).
The on/off and attribute logic itself lives in zone_state.py so it can be
unit tested without Home Assistant installed.
"""

from __future__ import annotations

import logging
from typing import Any

from homeassistant.components.binary_sensor import (
    ENTITY_ID_FORMAT,
    BinarySensorDeviceClass,
    BinarySensorEntity,
)
from homeassistant.config_entries import ConfigEntry
from homeassistant.const import CONF_ACCESS_TOKEN, CONF_HOST, CONF_PORT
from homeassistant.core import HomeAssistant
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from homeassistant.helpers.entity import DeviceInfo, async_generate_entity_id
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from . import api
from .const import DOMAIN
from .zone_state import zone_is_breached, zone_sensor_attributes

_LOGGER = logging.getLogger(__name__)


async def async_setup_entry(
    hass: HomeAssistant, entry: ConfigEntry, async_add_entities: AddEntitiesCallback
) -> None:
    """Create one binary_sensor per zone found via `GET /api/v1/zones`."""
    session = async_get_clientsession(hass)
    host, port, token = entry.data[CONF_HOST], entry.data[CONF_PORT], entry.data[CONF_ACCESS_TOKEN]
    try:
        zones = await api.async_get_zones(session, host, port, token)
    except (api.CannotConnect, api.InvalidAuth):
        # No coordinator (T039) exists yet to retry a failed setup fetch;
        # the alarm_control_panel entity (T036) will still reflect the
        # outage on its own polling cadence. Nothing to create entities for
        # if the very first zones list can't be fetched.
        _LOGGER.warning("Could not fetch zones from the Z-Wave Alarm service; no zone sensors created")
        return

    async_add_entities(
        ZwaveAlarmZoneBinarySensor(hass, entry, zone["id"], zone["name"]) for zone in zones
    )


class ZwaveAlarmZoneBinarySensor(BinarySensorEntity):
    """`binary_sensor.zwave_alarm_zone_<zone>` -- on when any sensor in this zone is breached."""

    _attr_device_class = BinarySensorDeviceClass.SAFETY

    def __init__(self, hass: HomeAssistant, entry: ConfigEntry, zone_id: str, zone_name: str) -> None:
        self._hass = hass
        self._host: str = entry.data[CONF_HOST]
        self._port: int = entry.data[CONF_PORT]
        self._token: str = entry.data[CONF_ACCESS_TOKEN]
        self._zone_id = zone_id
        self._attr_name = zone_name
        self._attr_unique_id = f"{entry.entry_id}_zone_{zone_id}"
        # Explicit entity_id (rather than has_entity_name's device+name slug,
        # which alarm_control_panel.py relies on) so the id matches the
        # contract's literal `zwave_alarm_zone_<zone>` pattern.
        self.entity_id = async_generate_entity_id(
            ENTITY_ID_FORMAT, f"zwave_alarm_zone_{zone_name}", hass=hass
        )
        self._attr_device_info = DeviceInfo(
            identifiers={(DOMAIN, entry.entry_id)},
            name="Z-Wave Alarm",
            manufacturer="Z-Wave Alarm",
        )

    async def async_update(self) -> None:
        """Poll `GET /api/v1/zones`, locate this zone, and update state/attributes."""
        session = async_get_clientsession(self._hass)
        try:
            zones = await api.async_get_zones(session, self._host, self._port, self._token)
        except (api.CannotConnect, api.InvalidAuth):
            # Same "never assume a state when unreachable" rule as
            # alarm_control_panel.py's async_update (contract's "Failure
            # handling" section, FR-006).
            self._attr_available = False
            return

        zone = next((z for z in zones if z["id"] == self._zone_id), None)
        if zone is None:
            # The zone was deleted upstream since this entity was created;
            # there's no live "zone removed" signal without a coordinator
            # (T039), so surface it as unavailable rather than stale.
            self._attr_available = False
            return

        self._attr_available = True
        self._attr_is_on = zone_is_breached(zone)
        self._attr_extra_state_attributes: dict[str, Any] = {
            "sensors": zone_sensor_attributes(zone)
        }
