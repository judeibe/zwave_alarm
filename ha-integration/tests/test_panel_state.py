"""Tests for panel_state.map_panel_mode (T036)."""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "custom_components" / "zwave_alarm"))

from panel_state import map_panel_mode  # noqa: E402


@pytest.mark.parametrize(
    ("mode", "expected"),
    [
        ("disarmed", "disarmed"),
        ("arming", "arming"),
        ("armed_away", "armed_away"),
        ("armed_home", "armed_home"),
        ("alarm_pending", "pending"),
        ("alarm_triggered", "triggered"),
    ],
)
def test_maps_every_alarm_mode(mode: str, expected: str) -> None:
    assert map_panel_mode(mode) == expected


def test_raises_on_unknown_mode() -> None:
    with pytest.raises(ValueError, match="unknown_mode"):
        map_panel_mode("unknown_mode")
