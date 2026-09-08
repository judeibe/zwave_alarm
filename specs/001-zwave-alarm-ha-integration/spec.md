# Feature Specification: Self-Hosted Z-Wave Alarm System with Home Assistant Integration

**Feature Branch**: `001-zwave-alarm-ha-integration`

**Created**: 2026-09-07

**Status**: Draft

**Input**: User description: "A self hosted zwave alarm system, that will intergrate with home assistant via a custom component. Zwave Usb will be conntected to this application and use zwavejs server to connect to home assitant."

## Clarifications

### Session 2026-09-07

- Q: Should life-safety sensors like smoke or CO detectors keep triggering an alarm even when the system is disarmed, unlike intrusion sensors (doors/motion) which should only alert while armed? → A: Yes — life-safety sensors (smoke, CO, glass-break-as-fire) always trigger regardless of arm state; only intrusion sensors (door/window contact, motion) are gated by armed/disarmed state.
- Q: After too many wrong disarm-code attempts in a row, should the system lock out further attempts for a cooldown period and raise a tamper/security event? → A: Yes by default (lockout + cooldown + tamper event after a small number of consecutive failures), but an administrator MUST be able to configure the system to instead treat repeated failed attempts as an active alarm trigger.
- Q: Do all household members share equal permissions, or are there distinct roles? → A: Three tiers — Administrator (full control incl. device/user management), Member (arm/disarm + view status), and Guest (a time-limited or single-zone-restricted disarm code).
- Q: Should this feature's scope explicitly exclude a dedicated mobile app, camera/video integration, and professional monitoring dispatch? → A: Yes — those are out of scope for this feature and deferred to future work.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Arm, disarm, and monitor the alarm from the native system (Priority: P1)

A homeowner uses the self-hosted alarm system directly to arm the system when leaving home, disarm it when returning, and view the live status of every connected security sensor (doors, windows, motion, etc.). The system must protect the home correctly on its own, without depending on any other application being available.

**Why this priority**: This is the core safety function of the product. Without reliable arm/disarm and sensor monitoring, there is no alarm system — everything else (including the Home Assistant integration) is secondary to this working correctly and independently.

**Independent Test**: Can be fully tested by connecting a Z-Wave USB controller and a handful of sensors, arming the system, opening a monitored door, and confirming the system detects the breach and raises an alarm — with no Home Assistant instance running at all.

**Acceptance Scenarios**:

1. **Given** the system is disarmed and all sensors are in a normal state, **When** an authorized user arms the system in "away" mode, **Then** the system transitions to armed-away and begins monitoring all configured sensors for breaches.
2. **Given** the system is armed and a monitored door sensor opens, **When** the configured entry delay expires without the system being disarmed, **Then** the system enters an alarm-triggered state and activates the configured alert (e.g., siren).
3. **Given** the system is armed, **When** an authorized user enters a valid disarm code within the entry delay window, **Then** the system returns to disarmed and no alarm is raised.
4. **Given** a sensor loses connectivity or reports a low battery, **When** the condition is detected, **Then** the system surfaces a visible fault/warning distinct from a security breach.

---

### User Story 2 - Monitor and control the alarm from Home Assistant (Priority: P2)

A Home Assistant user installs the accompanying custom component so the alarm system's arm state and sensor states appear as entities inside Home Assistant, allowing the alarm to be included in dashboards and to trigger Home Assistant automations (e.g., turning on lights when the alarm is triggered).

**Why this priority**: This is the feature's key differentiator and the reason the user is integrating with Home Assistant, but it builds on top of a working standalone alarm (Story 1) rather than replacing it.

**Independent Test**: Can be fully tested by installing the custom component in a Home Assistant instance pointed at the running alarm system and confirming that arming/disarming and sensor state changes made on the native system are reflected in Home Assistant in near real time.

**Acceptance Scenarios**:

1. **Given** the custom component is installed and connected to the alarm system, **When** the alarm is armed or disarmed on the native system, **Then** the corresponding entity state updates in Home Assistant within a few seconds.
2. **Given** a monitored sensor changes state (e.g., a door opens), **When** the change is detected by the alarm system, **Then** Home Assistant reflects the updated sensor state so it can be used in automations.
3. **Given** the connection between Home Assistant and the alarm system is lost, **When** connectivity is restored, **Then** Home Assistant's view of the alarm and sensor states resynchronizes to match the alarm system's actual current state.

---

### User Story 3 - Receive alerts when the alarm is triggered (Priority: P3)

A homeowner is notified promptly whenever the alarm is triggered, so they can respond to a potential intrusion regardless of whether they are watching the native interface or Home Assistant at that moment.

**Why this priority**: Detection without notification has limited real-world value; this closes the loop for the primary security use case, but the system is still functional and testable without it.

**Independent Test**: Can be fully tested by triggering an alarm condition and confirming a notification is delivered to a designated recipient without requiring the Home Assistant integration to be configured.

**Acceptance Scenarios**:

1. **Given** the alarm system is armed, **When** the alarm is triggered, **Then** a notification is sent to all designated recipients.
2. **Given** a notification has been sent for a triggered alarm, **When** the alarm is subsequently disarmed, **Then** the recipients are informed the alarm was cleared and by whom.

---

### Edge Cases

- What happens when the Z-Wave USB controller is unplugged or fails while the system is armed?
- How does the system handle a sensor that goes offline (battery dead, out of range) while armed — is that itself treated as a fault, a breach, or both?
- What happens when Home Assistant attempts to arm/disarm the system at the same moment a user does so from the native interface?
- How does the system behave if Home Assistant is offline for an extended period and then reconnects — does it need to catch up on missed events, or only reflect current state?
- What happens if a user attempts to add a Z-Wave device that is already paired to a different controller (e.g., Home Assistant's own Z-Wave integration)?
- How does the system handle rapid, repeated sensor triggers (e.g., a door left ajar) without generating excessive alarm events or notifications?
- What happens during a power outage or restart — does the system resume its prior armed/disarmed state automatically?

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: System MUST allow authorized users to arm the system (in at least an "away" and a "home/stay" mode) and disarm it.
- **FR-002**: System MUST maintain and display the real-time state of every connected Z-Wave security sensor (e.g., contact, motion, smoke/glass-break).
- **FR-003**: System MUST raise an alarm-triggered state and activate the configured alert output when a monitored intrusion sensor (e.g., door/window contact, motion) is breached while the system is armed, subject to configurable entry delay.
- **FR-004**: System MUST support configurable exit and entry delay periods before arming takes effect and before a breach triggers an alarm, respectively.
- **FR-005**: System MUST function as the sole controller of the connected Z-Wave USB adapter and the Z-Wave network of sensors, independent of any other application.
- **FR-006**: System MUST continue arming, disarming, monitoring sensors, and raising alarms with full functionality when Home Assistant is offline, unreachable, or not configured.
- **FR-007**: System MUST provide a Home Assistant custom component that exposes the alarm's current arm state and each sensor's current state as Home Assistant entities.
- **FR-008**: System MUST push state changes (arm state and sensor state) to connected Home Assistant instances as they occur, rather than requiring Home Assistant to repeatedly poll for updates.
- **FR-009**: System MUST authenticate users before allowing arm/disarm actions or access to sensor/security data, whether accessed natively or through Home Assistant.
- **FR-010**: System MUST allow administrators to add, remove, and organize Z-Wave sensor devices into zones for monitoring purposes.
- **FR-010a**: System MUST support three user roles — Administrator (full control, including device/zone/user management), Member (arm/disarm and status viewing), and Guest (a time-limited or single-zone-restricted disarm code) — and MUST restrict each action to the roles authorized to perform it.
- **FR-011**: System MUST record a persistent, reviewable history of security-relevant events (arm, disarm, breach, alarm triggered/cleared, and device fault events), including who or what initiated each event.
- **FR-012**: System MUST detect and surface loss of connectivity or low battery for any registered sensor as a distinct fault condition, separate from a security breach.
- **FR-013**: System MUST notify occupants when an alarm is triggered via a local audible siren (a configured Z-Wave siren/alert device); any additional remote notification (push, SMS, email) is delivered through Home Assistant automations built on top of the exposed alarm-triggered state, not by the alarm system itself.
- **FR-014**: System MUST resolve conflicting simultaneous arm/disarm requests by giving the native interface precedence — a request issued through Home Assistant that races a native-interface request within the same window MUST be rejected or superseded in favor of the native request.
- **FR-015**: System MUST raise an alarm-triggered state and activate the configured alert output immediately when a monitored life-safety sensor (e.g., smoke, CO, glass-break-as-fire) is triggered, regardless of whether the system is armed or disarmed.
- **FR-016**: System MUST lock out further disarm-code attempts for a cooldown period and raise a tamper/security event after a small number of consecutive failed attempts; administrators MUST be able to configure the system to instead treat repeated failed attempts as an active alarm trigger.

### Key Entities

- **Alarm Panel**: The central security state of the home — current mode (disarmed, armed-away, armed-home, alarm-triggered), and the active entry/exit delay countdown.
- **Zone**: A named logical grouping of one or more sensors (e.g., "Front Door", "Garage") used to organize monitoring and reporting.
- **Sensor Device**: A physical Z-Wave device (contact, motion, smoke/glass-break, etc.) with a current state, battery level, connectivity status, and a category — **intrusion** (armed-state-gated) or **life-safety** (always active) — assigned to a zone.
- **Security Event**: A timestamped record of a state change relevant to security or system health — arm, disarm, breach, alarm triggered/cleared, or device fault — including its source (user, schedule, or Home Assistant).
- **User / Household Member**: A person authorized to interact with the system, identified by credentials or a code, holding one of three roles: **Administrator** (full control, including managing devices, zones, and other users), **Member** (arm/disarm and view status), or **Guest** (a time-limited or single-zone-restricted disarm code).
- **Home Assistant Link**: The active connection between the alarm system and a specific Home Assistant instance through which state is exchanged.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Users can arm or disarm the system in under 5 seconds from either the native interface or Home Assistant.
- **SC-002**: A sensor state change (e.g., a door opening) is reflected in both the native interface and Home Assistant within 2 seconds under normal network conditions.
- **SC-003**: The system detects breaches and raises alarms with 100% of its normal functionality when Home Assistant is completely offline or never configured.
- **SC-004**: At least 95% of alarm-triggered events result in a notification delivered to designated recipients within 10 seconds of the trigger.
- **SC-005**: The system supports at least 50 Z-Wave sensor devices across at least 10 zones without any measurable increase in arm/disarm or state-update response time.
- **SC-006**: After a system restart, the alarm panel and all sensor states are restored to their pre-restart values with no manual reconfiguration required.

## Assumptions

- A single Z-Wave USB controller is dedicated to this application; Home Assistant is not simultaneously running its own independent Z-Wave controller on the same set of devices, since a Z-Wave network can only have one primary controller.
- The deployment target is a single household/property with a self-hosted server (e.g., a home server, NAS, or always-on mini PC) reachable on the local network by Home Assistant.
- All alarm-critical functionality (arming, sensor monitoring, breach detection, local alerting) operates entirely on the local network and does not require internet/cloud connectivity; the Home Assistant integration and any remote notifications are additive, not required for core protection.
- Entry and exit delays default to a standard 30 seconds per zone and are adjustable by an administrator.
- Home Assistant, when connected, is treated as a read/write client of the alarm system's state rather than as the system of record — the alarm system itself is the authority on current arm and sensor state.
- Out of scope for this feature: a dedicated mobile app, camera/video integration, and professional (third-party) monitoring service dispatch — these are deferred to future features.
