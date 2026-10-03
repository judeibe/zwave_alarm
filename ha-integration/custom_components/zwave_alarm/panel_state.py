"""Pure mapping from this service's AlarmPanel.mode to Home Assistant's
alarm_control_panel state strings.

Split out from alarm_control_panel.py so it can be unit tested without Home
Assistant installed: the `homeassistant` package's dependency pins are
incompatible with this repo's Python version (same constraint noted in
api.py / T035's completion note), so anything worth testing here avoids
importing it.
"""

from __future__ import annotations

# AlarmMode values (src/alarm/panel-repository.ts) mapped to the string
# values of homeassistant.components.alarm_control_panel.AlarmControlPanelState.
# 'arming' is the exit delay before an arm takes effect; 'alarm_pending' is
# the entry delay before a breach becomes a full 'alarm_triggered'.
_MODE_TO_STATE: dict[str, str] = {
    "disarmed": "disarmed",
    "arming": "arming",
    "armed_away": "armed_away",
    "armed_home": "armed_home",
    "alarm_pending": "pending",
    "alarm_triggered": "triggered",
}


def map_panel_mode(mode: str) -> str:
    """Map an AlarmPanel.mode value to a Home Assistant alarm state string."""
    try:
        return _MODE_TO_STATE[mode]
    except KeyError as err:
        raise ValueError(f"Unknown AlarmPanel mode: {mode!r}") from err
