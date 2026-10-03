"""The `sensor.zwave_alarm_fault_count` entity (T038).

Count of sensors currently reporting a fault (offline or low battery),
across all zones, per contracts/ha-custom-component.md's "Entities exposed
to Home Assistant" section -- lets automations alert on system health
separately from security breaches (arm/disarm, zone breach).

As of T039, this reads live state from the WebSocket-driven
`ZwaveAlarmCoordinator` (coordinator.py) rather than polling `GET
/api/v1/zones` directly. The counting logic itself lives in fault_state.py
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
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity import DeviceInfo, async_generate_entity_id
from homeassistant.helpers.entity_platform import AddEntitiesCallback
from homeassistant.helpers.update_coordinator import CoordinatorEntity

from .const import DOMAIN
from .coordinator import ZwaveAlarmCoordinator
from .fault_state import count_faulted_sensors

_LOGGER = logging.getLogger(__name__)


async def async_setup_entry(
    hass: HomeAssistant, entry: ConfigEntry, async_add_entities: AddEntitiesCallback
) -> None:
    """Create the single fault-count sensor for this config entry."""
    coordinator: ZwaveAlarmCoordinator = hass.data[DOMAIN][entry.entry_id]
    async_add_entities([ZwaveAlarmFaultCountSensor(coordinator, entry)])


class ZwaveAlarmFaultCountSensor(CoordinatorEntity[ZwaveAlarmCoordinator], SensorEntity):
    """`sensor.zwave_alarm_fault_count` -- count of sensors currently reporting a fault."""

    _attr_native_unit_of_measurement = "sensors"
    _attr_state_class = SensorStateClass.MEASUREMENT
    _attr_icon = "mdi:alert-circle-outline"

    def __init__(self, coordinator: ZwaveAlarmCoordinator, entry: ConfigEntry) -> None:
        super().__init__(coordinator)
        self._attr_name = "Fault Count"
        self._attr_unique_id = f"{entry.entry_id}_fault_count"
        # Explicit entity_id (matching binary_sensor.py's per-zone entities)
        # so the id matches the contract's literal
        # `sensor.zwave_alarm_fault_count` name rather than whatever slug
        # HA's default device+name naming would produce.
        self.entity_id = async_generate_entity_id(
            ENTITY_ID_FORMAT, "zwave_alarm_fault_count", hass=coordinator.hass
        )
        self._attr_device_info = DeviceInfo(
            identifiers={(DOMAIN, entry.entry_id)},
            name="Z-Wave Alarm",
            manufacturer="Z-Wave Alarm",
        )

    @property
    def native_value(self) -> int | None:
        """Current fault count from the coordinator's cached data, or `None` before any snapshot arrives."""
        if self.coordinator.data is None:
            return None
        return count_faulted_sensors(self.coordinator.data.zones)
