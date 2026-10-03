"""Pure helpers for the `sensor.zwave_alarm_fault_count` entity (T038).

Split out of sensor.py for the same reason zone_state.py/panel_state.py were
split out of binary_sensor.py/alarm_control_panel.py: the `homeassistant`
package can't be installed in this environment (see api.py's module
docstring), so any logic worth unit testing has to avoid importing it.
"""

from __future__ import annotations

from typing import Any

# Mirrors src/zwave/sensor-mapper.ts's DEFAULT_LOW_BATTERY_THRESHOLD_PERCENT
# (and src/web/app.js's own client-side copy of the same constant, per its
# comment). This entity polls `GET /api/v1/zones` rather than listening for
# the `sensor.fault` WebSocket event (which only fires on a state *edge*),
# so fault status is recomputed from `batteryLevel`/`connectivityStatus`
# here rather than tracked from that event.
LOW_BATTERY_THRESHOLD_PERCENT = 20


def sensor_is_faulted(sensor: dict[str, Any]) -> bool:
    """A sensor is at fault when offline or its battery is at/below the low-battery threshold (FR-012)."""
    if sensor["connectivityStatus"] == "offline":
        return True
    battery_level = sensor["batteryLevel"]
    return battery_level is not None and battery_level <= LOW_BATTERY_THRESHOLD_PERCENT


def count_faulted_sensors(zones: list[dict[str, Any]]) -> int:
    """Count of sensors currently reporting a fault, across all zones (ha-custom-component.md)."""
    return sum(1 for zone in zones for sensor in zone["sensors"] if sensor_is_faulted(sensor))
