"""Tests for coordinator_state.py's pure event-application/backoff logic (T039)."""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "custom_components" / "zwave_alarm"))

from coordinator_state import (  # noqa: E402
    RECONNECT_BASE_DELAY,
    RECONNECT_MAX_DELAY,
    StreamState,
    apply_event,
    merge_panel,
    next_backoff,
)


def _sensor(sensor_id: str, category: str = "intrusion", state: str = "normal", **overrides) -> dict:
    sensor = {
        "id": sensor_id,
        "category": category,
        "currentState": state,
        "connectivityStatus": "online",
        "batteryLevel": 100,
    }
    sensor.update(overrides)
    return sensor


def _zone(zone_id: str, sensors: list[dict]) -> dict:
    return {"id": zone_id, "name": zone_id, "sensors": sensors}


def test_snapshot_replaces_entire_state() -> None:
    state = StreamState(panel={"mode": "disarmed", "pendingDelayEndsAt": None}, zones=[])
    event = {
        "type": "snapshot",
        "panel": {"mode": "armed_away", "pendingDelayEndsAt": None},
        "zones": [_zone("z1", [_sensor("s1")])],
    }

    new_state = apply_event(state, event)

    assert new_state.panel == {"mode": "armed_away", "pendingDelayEndsAt": None}
    assert new_state.zones == [_zone("z1", [_sensor("s1")])]


def test_panel_changed_updates_mode_and_pending_delay() -> None:
    state = StreamState(panel={"mode": "arming", "pendingDelayEndsAt": 123}, zones=[])
    event = {"type": "panel.changed", "mode": "armed_away", "pendingDelayEndsAt": None, "triggeredBy": None}

    new_state = apply_event(state, event)

    assert new_state.panel == {"mode": "armed_away", "pendingDelayEndsAt": None}


def test_panel_changed_is_noop_before_any_snapshot() -> None:
    state = StreamState(panel=None, zones=[])
    event = {"type": "panel.changed", "mode": "armed_away", "pendingDelayEndsAt": None, "triggeredBy": None}

    new_state = apply_event(state, event)

    assert new_state.panel is None


def test_sensor_changed_updates_matching_sensor_only() -> None:
    state = StreamState(
        panel=None,
        zones=[_zone("z1", [_sensor("s1"), _sensor("s2")])],
    )
    event = {"type": "sensor.changed", "sensorId": "s1", "zoneId": "z1", "currentState": "breached", "category": "intrusion"}

    new_state = apply_event(state, event)

    sensors = {s["id"]: s for s in new_state.zones[0]["sensors"]}
    assert sensors["s1"]["currentState"] == "breached"
    assert sensors["s2"]["currentState"] == "normal"


def test_sensor_changed_unknown_sensor_id_is_noop() -> None:
    state = StreamState(panel=None, zones=[_zone("z1", [_sensor("s1")])])
    event = {"type": "sensor.changed", "sensorId": "unknown", "zoneId": "z1", "currentState": "breached", "category": "intrusion"}

    new_state = apply_event(state, event)

    assert new_state.zones[0]["sensors"][0]["currentState"] == "normal"


def test_sensor_fault_updates_connectivity_and_battery() -> None:
    state = StreamState(panel=None, zones=[_zone("z1", [_sensor("s1")])])
    event = {"type": "sensor.fault", "sensorId": "s1", "connectivityStatus": "offline", "batteryLevel": 8}

    new_state = apply_event(state, event)

    sensor = new_state.zones[0]["sensors"][0]
    assert sensor["connectivityStatus"] == "offline"
    assert sensor["batteryLevel"] == 8


def test_event_recorded_and_unknown_types_are_noop() -> None:
    state = StreamState(panel={"mode": "disarmed", "pendingDelayEndsAt": None}, zones=[_zone("z1", [_sensor("s1")])])

    for event in (
        {"type": "event.recorded", "event": {"id": "e1", "type": "lockout", "occurredAt": "2026-01-01T00:00:00Z"}},
        {"type": "something.unrecognized"},
    ):
        new_state = apply_event(state, event)
        assert new_state.panel == state.panel
        assert new_state.zones == state.zones


def test_merge_panel_overwrites_mode_and_pending_delay() -> None:
    state = StreamState(panel={"mode": "arming", "pendingDelayEndsAt": 123}, zones=[])

    new_state = merge_panel(state, {"mode": "armed_away", "pendingDelayEndsAt": None})

    assert new_state.panel == {"mode": "armed_away", "pendingDelayEndsAt": None}


def test_merge_panel_works_when_no_prior_panel_exists() -> None:
    state = StreamState(panel=None, zones=[])

    new_state = merge_panel(state, {"mode": "disarmed", "pendingDelayEndsAt": None})

    assert new_state.panel == {"mode": "disarmed", "pendingDelayEndsAt": None}


def test_next_backoff_doubles_from_base_up_to_cap() -> None:
    assert next_backoff(0) == RECONNECT_BASE_DELAY
    assert next_backoff(1) == RECONNECT_BASE_DELAY * 2
    assert next_backoff(2) == RECONNECT_BASE_DELAY * 4
    assert next_backoff(3) == RECONNECT_BASE_DELAY * 8


def test_next_backoff_caps_at_max_delay() -> None:
    assert next_backoff(10) == RECONNECT_MAX_DELAY
    assert next_backoff(100) == RECONNECT_MAX_DELAY
