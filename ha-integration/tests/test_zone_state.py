"""Tests for zone_state.py's pure on/attribute logic (T037)."""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "custom_components" / "zwave_alarm"))

from zone_state import zone_is_breached, zone_sensor_attributes  # noqa: E402


def _sensor(name: str, category: str, state: str) -> dict:
    return {"name": name, "category": category, "currentState": state}


def test_zone_is_breached_true_when_any_sensor_breached() -> None:
    zone = {
        "sensors": [
            _sensor("Front Door", "intrusion", "normal"),
            _sensor("Kitchen Smoke", "life-safety", "breached"),
        ]
    }
    assert zone_is_breached(zone) is True


def test_zone_is_breached_false_when_all_sensors_normal() -> None:
    zone = {
        "sensors": [
            _sensor("Front Door", "intrusion", "normal"),
            _sensor("Kitchen Smoke", "life-safety", "normal"),
        ]
    }
    assert zone_is_breached(zone) is False


def test_zone_is_breached_false_with_no_sensors() -> None:
    assert zone_is_breached({"sensors": []}) is False


def test_zone_sensor_attributes_includes_name_category_and_state() -> None:
    zone = {"sensors": [_sensor("Front Door", "intrusion", "breached")]}
    assert zone_sensor_attributes(zone) == [
        {"name": "Front Door", "category": "intrusion", "state": "breached"}
    ]


def test_zone_sensor_attributes_empty_for_empty_zone() -> None:
    assert zone_sensor_attributes({"sensors": []}) == []
