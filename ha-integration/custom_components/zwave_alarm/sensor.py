"""The `sensor.zwave_alarm_fault_count` entity (T038).

Count of sensors currently reporting a fault (offline or low battery),
across all zones, from `GET /api/v1/zones`, per
contracts/ha-custom-component.md's "Entities exposed to Home Assistant"
section -- lets automations alert on system health separately from security
breaches (arm/disarm, zone breach).

Like alarm_control_panel.py (T036) and binary_sensor.py (T037), this polls
(`should_poll` defaults to `True`) until T039 adds the WebSocket coordinator
for push updates (FR-008). The counting logic itself lives in fault_state.py
so it can be unit tested without Home Assistant installed.
"""

from __future__ import annotations

import logging

from homeassistant.components.sensor import (
    ENTITY_ID_FORMAT,
    SensorEntity,
    SensorStateClass,
)
from homeassistant.config_entries import ConfigEntry
from homeassistant.const import CONF_ACCESS_TOKEN, CONF_HOST, CONF_PORT
from homeassistant.core import HomeAssistant
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from homeassistant.helpers.entity import DeviceInfo, async_generate_entity_id
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from . import api
from .const import DOMAIN
from .fault_state import count_faulted_sensors

_LOGGER = logging.getLogger(__name__)


async def async_setup_entry(
    hass: HomeAssistant, entry: ConfigEntry, async_add_entities: AddEntitiesCallback
) -> None:
    """Create the single fault-count sensor for this config entry."""
    async_add_entities([ZwaveAlarmFaultCountSensor(hass, entry)])


class ZwaveAlarmFaultCountSensor(SensorEntity):
    """`sensor.zwave_alarm_fault_count` -- count of sensors currently reporting a fault."""

    _attr_native_unit_of_measurement = "sensors"
    _attr_state_class = SensorStateClass.MEASUREMENT
    _attr_icon = "mdi:alert-circle-outline"

    def __init__(self, hass: HomeAssistant, entry: ConfigEntry) -> None:
        self._hass = hass
        self._host: str = entry.data[CONF_HOST]
        self._port: int = entry.data[CONF_PORT]
        self._token: str = entry.data[CONF_ACCESS_TOKEN]
        self._attr_name = "Fault Count"
        self._attr_unique_id = f"{entry.entry_id}_fault_count"
        # Explicit entity_id (matching binary_sensor.py's per-zone entities)
        # so the id matches the contract's literal
        # `sensor.zwave_alarm_fault_count` name rather than whatever slug
        # HA's default device+name naming would produce.
        self.entity_id = async_generate_entity_id(
            ENTITY_ID_FORMAT, "zwave_alarm_fault_count", hass=hass
        )
        self._attr_device_info = DeviceInfo(
            identifiers={(DOMAIN, entry.entry_id)},
            name="Z-Wave Alarm",
            manufacturer="Z-Wave Alarm",
        )

    async def async_update(self) -> None:
        """Poll `GET /api/v1/zones` and count sensors currently at fault."""
        session = async_get_clientsession(self._hass)
        try:
            zones = await api.async_get_zones(session, self._host, self._port, self._token)
        except (api.CannotConnect, api.InvalidAuth):
            # Same "never assume a state when unreachable" rule as
            # alarm_control_panel.py/binary_sensor.py's async_update
            # (contract's "Failure handling" section, FR-006).
            self._attr_available = False
            return

        self._attr_available = True
        self._attr_native_value = count_faulted_sensors(zones)
