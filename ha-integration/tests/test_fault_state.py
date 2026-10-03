"""Tests for fault_state.py's pure fault-counting logic (T038)."""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "custom_components" / "zwave_alarm"))

from fault_state import count_faulted_sensors, sensor_is_faulted  # noqa: E402


def _sensor(battery_level: int | None, connectivity_status: str = "online") -> dict:
    return {"batteryLevel": battery_level, "connectivityStatus": connectivity_status}


def test_sensor_is_faulted_true_when_offline() -> None:
    assert sensor_is_faulted(_sensor(80, connectivity_status="offline")) is True


def test_sensor_is_faulted_true_when_battery_at_threshold() -> None:
    assert sensor_is_faulted(_sensor(20)) is True


def test_sensor_is_faulted_true_when_battery_below_threshold() -> None:
    assert sensor_is_faulted(_sensor(5)) is True


def test_sensor_is_faulted_false_when_battery_above_threshold() -> None:
    assert sensor_is_faulted(_sensor(21)) is False


def test_sensor_is_faulted_false_when_online_and_mains_powered() -> None:
    assert sensor_is_faulted(_sensor(None)) is False


def test_count_faulted_sensors_sums_across_zones() -> None:
    zones = [
        {
            "sensors": [
                _sensor(80),
                _sensor(10),
            ]
        },
        {
            "sensors": [
                _sensor(None, connectivity_status="offline"),
                _sensor(None),
            ]
        },
    ]
    assert count_faulted_sensors(zones) == 2


def test_count_faulted_sensors_zero_with_no_zones() -> None:
    assert count_faulted_sensors([]) == 0


def test_count_faulted_sensors_zero_with_empty_zone() -> None:
    assert count_faulted_sensors([{"sensors": []}]) == 0
