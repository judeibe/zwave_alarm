"""Pure helpers over a `GET /api/v1/zones` Zone dict (src/db/repositories/zone-repository.ts).

Split out of binary_sensor.py for the same reason panel_state.py was split
out of alarm_control_panel.py (T036): the `homeassistant` package can't be
installed in this environment (see api.py's module docstring), so any logic
worth unit testing has to avoid importing it.
"""

from __future__ import annotations

from typing import Any


def zone_is_breached(zone: dict[str, Any]) -> bool:
    """`on` when any sensor in this zone is currently `breached` (ha-custom-component.md)."""
    return any(sensor["currentState"] == "breached" for sensor in zone["sensors"])


def zone_sensor_attributes(zone: dict[str, Any]) -> list[dict[str, Any]]:
    """Per-sensor attributes for this zone's binary_sensor: name, category, and current state.

    Exposing `category` (`intrusion`/`life-safety`) here is what the contract
    requires; `name`/`state` are included alongside it so the attribute is
    useful without cross-referencing another entity.
    """
    return [
        {"name": sensor["name"], "category": sensor["category"], "state": sensor["currentState"]}
        for sensor in zone["sensors"]
    ]
