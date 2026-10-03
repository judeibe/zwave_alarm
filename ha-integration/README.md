# Z-Wave Alarm — Home Assistant Custom Component

This directory contains `custom_components/zwave_alarm`, the Home Assistant custom component built in Phase 03. It exposes this service's alarm panel and sensors as native Home Assistant entities (`alarm_control_panel.zwave_alarm`, `binary_sensor.zwave_alarm_zone_<zone>`, `sensor.zwave_alarm_fault_count`), kept live via a WebSocket connection to `/api/v1/stream`.

Installation and config-flow setup are covered in `specs/001-zwave-alarm-ha-integration/quickstart.md`, section 4. This README covers the remote-notification pattern from **FR-013**.

## Remote notifications are delegated to Home Assistant (FR-013)

Per `spec.md`'s FR-013 and Clarifications, this service's own responsibility for alarm notification stops at the **local audible siren** — a configured Z-Wave siren/alert device is the authoritative, no-Home-Assistant-required notification (see `src/alarm/siren.ts`). Any additional remote notification (push, SMS, email) is intentionally *not* built into the alarm system itself. Instead, it's delivered through a Home Assistant automation built on top of `alarm_control_panel.zwave_alarm`'s exposed state, once the custom component is installed (User Story 3, Phase 03).

This keeps the native alarm fully functional with zero notification configuration, while still letting a Home Assistant user get a push notification, SMS, sirens elsewhere in the house, or anything else Home Assistant's automation/notify platforms support.

## Sample automation: mobile notification on trigger

The following automation watches `alarm_control_panel.zwave_alarm` for a transition into the `triggered` state and sends a mobile push notification via the Home Assistant Companion App's `notify.mobile_app_<your_device>` service (satisfying User Story 3's first acceptance scenario: "a notification is sent to all designated recipients").

```yaml
alias: "Z-Wave Alarm: notify on trigger"
description: >
  Sends a mobile push notification when the Z-Wave Alarm's
  alarm_control_panel entity transitions into the triggered state.
triggers:
  - trigger: state
    entity_id: alarm_control_panel.zwave_alarm
    to: "triggered"
conditions: []
actions:
  - action: notify.mobile_app_your_phone # replace with your Companion App notify service
    data:
      title: "Alarm Triggered"
      message: "The Z-Wave Alarm has been triggered."
      data:
        # Optional: makes the notification a persistent, high-priority alert
        # on Android/iOS Companion Apps rather than a silent banner.
        priority: high
        ttl: 0
mode: single
```

Replace `notify.mobile_app_your_phone` with the actual `notify.mobile_app_<device>` service created by the [Home Assistant Companion App](https://www.home-assistant.io/integrations/mobile_app/) for each recipient's phone — add one `action` entry per recipient to notify more than one person.

## Sample automation: "cleared, and by whom" follow-up

`alarm_cleared` events recorded by this service (see `src/events/event-repository.ts` and `GET /api/v1/events`) carry a human-readable `details` string such as `"Cleared by Owner"` or `"Cleared by Home Assistant"` (User Story 3's second acceptance scenario). The `alarm_control_panel.zwave_alarm` entity's state transitions from `triggered` back to `disarmed` at the same moment, so a companion automation can send a follow-up notification confirming the alarm was cleared:

```yaml
alias: "Z-Wave Alarm: notify on clear"
description: >
  Sends a mobile push notification when the Z-Wave Alarm returns to
  disarmed after having been triggered.
triggers:
  - trigger: state
    entity_id: alarm_control_panel.zwave_alarm
    from: "triggered"
    to: "disarmed"
conditions: []
actions:
  - action: notify.mobile_app_your_phone # replace with your Companion App notify service
    data:
      title: "Alarm Cleared"
      message: "The Z-Wave Alarm has been disarmed."
mode: single
```

The Home Assistant entity itself only exposes the current `alarm_control_panel` state, not the underlying `SecurityEvent`'s `details` field — for the exact "cleared, and by whom" text, query `GET /api/v1/events?limit=1` on the alarm service directly (e.g. with a `rest` sensor or `rest_command`, or from the native dashboard) rather than the automation trigger above.
