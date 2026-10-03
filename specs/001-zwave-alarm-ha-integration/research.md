# Phase 0 Research: Self-Hosted Z-Wave Alarm System with Home Assistant Integration

## 1. Runtime and language version

**Decision**: TypeScript 5.x compiled for Node.js 20 LTS.

**Rationale**: `zwave-js` and `zwave-js-server` are both actively maintained Node/TypeScript libraries that track current Node LTS releases; targeting 20 LTS gets long support and native fetch/test-runner improvements without depending on bleeding-edge Node features.

**Alternatives considered**: Node 18 LTS (older, shorter remaining support window); Deno/Bun (would require re-validating `zwave-js`'s native serial-port bindings, unnecessary risk for a serial-hardware-dependent app).

## 2. Persistence layer

**Decision**: SQLite via `better-sqlite3`, a single file-based database for zones, sensor devices, users/roles, and the security event history.

**Rationale**: The deployment target is a single self-hosted instance per household (Assumptions), not a multi-node cluster — SQLite avoids requiring a separate database service, keeps the container self-contained, and `better-sqlite3`'s synchronous API composes cleanly with `zwave-js`'s event-driven single-process model. This also matches the 12-factor principle of treating the database as an attached, swappable backing resource: a Postgres adapter could be added later behind the same repository interface without touching domain logic.

**Alternatives considered**: PostgreSQL (unnecessary operational overhead for a single-household deployment); Prisma+SQLite (adds a heavier ORM/build step than this domain's fairly small, stable schema needs).

## 3. Testing framework

**Decision**: Vitest for unit, integration, and contract tests.

**Rationale**: Native TypeScript/ESM support without a `ts-jest` transform step, fast watch-mode iteration, and a Jest-compatible API that keeps the ecosystem of matchers/mocking familiar.

**Alternatives considered**: Jest (ubiquitous, but slower TS transform pipeline and heavier config for ESM).

## 4. Deployment target

**Decision**: Docker container (linux/amd64 and linux/arm64) with the Z-Wave USB adapter passed through as a host device (e.g., `--device=/dev/serial/by-id/...`).

**Rationale**: Matches the deployment convention already established by the wider Z-Wave JS ecosystem (e.g., Z-Wave JS UI), which the target users (self-hosters, Home Assistant users) are already familiar with; arm64 support covers common home-server hardware (Raspberry Pi, small ARM SBCs) alongside x86 NAS/mini-PCs.

**Alternatives considered**: Bare-metal/systemd service only (loses the reproducible-build benefit of 12-factor "build, release, run" separation); Home Assistant Supervisor add-on packaging (a plausible future distribution channel, but adds Supervisor-specific constraints not required for v1).

## 5. Native interface approach

**Decision**: The Express service bundles and serves a minimal static web dashboard (arm/disarm controls, zone/sensor status, event history) directly, rather than shipping a separate frontend project.

**Rationale**: The feature description specifies only a TypeScript/Express backend plus the Z-Wave libraries — no separate frontend framework was requested. A single deployable artifact keeps the 12-factor "one codebase, one build" property intact and avoids introducing a second toolchain for a dashboard whose interaction surface (arm, disarm, view status) is small.

**Alternatives considered**: Separate SPA project (React/Vue) — more scalable for a richer UI later, but out of proportion to the current scope and not requested.

## 6. Home Assistant integration architecture

**Decision**: Two complementary integration surfaces:

1. **Raw device passthrough** — `zwave-js-server` runs inside this service and exposes the standard Z-Wave JS WebSocket protocol. Home Assistant's own built-in "Z-Wave JS" integration (no custom code) connects to it directly, so every physical sensor already appears in Home Assistant as a native entity.
2. **Alarm-domain surface** — the Home Assistant custom component (`ha-integration/custom_components/zwave_alarm`) talks to this service's own REST/WebSocket API (see `contracts/`) to expose concepts the raw protocol doesn't know about: panel arm state, zone membership, and life-safety-vs-intrusion categorization (FR-007).

**Rationale**: Satisfies FR-007 (custom component exposes alarm/sensor state) without re-implementing device-level entity exposure that Home Assistant's existing, well-tested Z-Wave JS integration already provides — reducing custom-component surface area to only the genuinely new domain concepts.

**Alternatives considered**: Route everything (including raw device state) through the custom component only — duplicates functionality Home Assistant already ships and increases the custom component's maintenance burden for no added value.

## 7. Real-time push transport

**Decision**: `ws` for the alarm-domain WebSocket channel consumed by the native dashboard and the custom component.

**Rationale**: `zwave-js-server` already depends on `ws` transitively, so reusing it for the alarm-domain channel avoids adding a second WebSocket library; it is low-level enough to keep message framing under this project's control for the custom component's contract.

**Alternatives considered**: Socket.IO (adds reconnection/room abstractions not needed here, and is a heavier dependency for a single-consumer-type push channel).

## 8. Authentication and authorization

**Decision**: Session-cookie authentication for the native web dashboard; a long-lived per-installation API token for the Home Assistant custom component (entered during HA config flow, matching common HA custom-component patterns). Both paths resolve to a `User` with an Administrator/Member/Guest role (FR-010a) that gates each API action server-side.

**Rationale**: Matches how the two client types actually operate — a browser session for a human at the dashboard, a machine-to-machine token for the custom component — without introducing a full OAuth flow that neither client needs.

**Alternatives considered**: JWT for the dashboard too (adds revocation complexity for little benefit in a single-instance, same-origin deployment); shared static API key for all HA access (fails to support per-role restriction, e.g., Guest codes).

## 9. Failed-attempt lockout policy

**Decision**: A configurable per-user failed-attempt counter; after a small default threshold (e.g., 5) of consecutive failures, the account/code is locked for a cooldown period and a tamper/security event is recorded (FR-016 default). An administrator-configurable mode switch changes the same trigger condition to instead raise `alarm-triggered` immediately.

**Rationale**: Implements FR-016 as a single policy object (threshold, cooldown, mode) evaluated by the auth module on every failed disarm attempt, keeping the behavior swap (lockout vs. immediate-alarm) a configuration change rather than two divergent code paths.

**Alternatives considered**: Hard-coded lockout only (would not satisfy FR-016's requirement that administrators can switch to immediate-alarm mode).

## 10. Arm/disarm conflict resolution

**Decision**: A single in-process command dispatcher is the sole writer of `AlarmPanel` state; it timestamps and serializes incoming commands (native and Home Assistant-sourced) and applies a native-precedence rule (FR-014) when two commands race within the same short window.

**Rationale**: Centralizing all state mutation in one dispatcher makes the precedence rule a single, testable comparison rather than a distributed race condition across API handlers.

**Alternatives considered**: Optimistic concurrency at the database layer only (handles storage-level races but not the business rule of *which* source wins).
