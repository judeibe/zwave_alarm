"""The Z-Wave Alarm integration (T035).

Consumes this repo's REST/WebSocket API (contracts/ha-custom-component.md) to
expose alarm-domain entities (panel, zones, fault count) to Home Assistant.
This is separate from the raw Z-Wave device entities, which Home Assistant's
own built-in "Z-Wave JS" integration gets directly from `zwave-js-server`
(T010/T033) -- no custom code needed for those (research.md section 6).
"""

from __future__ import annotations

from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant

from .const import DOMAIN

PLATFORMS: list[str] = ["alarm_control_panel", "binary_sensor", "sensor"]


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Set up Z-Wave Alarm from a config entry."""
    hass.data.setdefault(DOMAIN, {})[entry.entry_id] = entry.data

    if PLATFORMS:
        await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)

    return True


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Unload a config entry."""
    unload_ok = True
    if PLATFORMS:
        unload_ok = await hass.config_entries.async_unload_platforms(entry, PLATFORMS)

    if unload_ok:
        hass.data[DOMAIN].pop(entry.entry_id, None)

    return unload_ok
