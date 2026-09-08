# Implementation Plan: Self-Hosted Z-Wave Alarm System with Home Assistant Integration

**Branch**: `001-zwave-alarm-ha-integration` | **Date**: 2026-09-07 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/001-zwave-alarm-ha-integration/spec.md`

**Note**: This template is filled in by the `/speckit-plan` command; its definition describes the execution workflow.

## Summary

A self-hosted TypeScript/Express service owns a Z-Wave USB controller via `zwave-js`, runs the alarm domain logic (arm/disarm, zones, entry/exit delays, life-safety vs. intrusion sensor gating, lockout policy, event history, role-based users), and exposes state over a push-based REST/WebSocket API consumed by a bundled minimal web dashboard (the "native interface") and by a companion Home Assistant custom component. Raw Z-Wave device entities are additionally made available to Home Assistant through the standard `zwave-js-server` protocol, which Home Assistant's built-in Z-Wave JS integration already knows how to consume — so only the alarm-domain concepts (panel state, zones, life-safety/intrusion categorization) need the bespoke custom component.

## Technical Context

**Language/Version**: TypeScript 5.x on Node.js 20 LTS

**Primary Dependencies**: Express 4.x (HTTP API), `zwave-js` (Z-Wave controller/driver), `zwave-js-server` (standard Z-Wave JS WebSocket protocol, consumed directly by Home Assistant's built-in Z-Wave JS integration), `ws` (WebSocket push channel for the alarm-domain API), `better-sqlite3` (embedded persistence)

**Storage**: SQLite via `better-sqlite3` — a single embedded, file-based store for zones, sensor devices, users/roles, and the security event history, matching the single-instance self-hosted deployment target

**Testing**: Vitest for unit and integration tests; contract tests against the REST/WebSocket API and against the Home Assistant custom component's expected payloads

**Target Platform**: Linux server, distributed as a Docker container (linux/amd64 and linux/arm64) with the Z-Wave USB adapter passed through as a host device

**Project Type**: Single backend web-service (Express) bundling a minimal static web dashboard as the native interface, plus a companion Home Assistant custom component (Python) shipped from the same repository

**Performance Goals**: Arm/disarm round-trip under 5s (SC-001); sensor state changes propagate to the native UI and Home Assistant within 2s (SC-002); no measurable latency increase up to 50 sensors / 10 zones (SC-005)

**Constraints**: Exactly one process may own the Z-Wave serial adapter at a time (FR-005) — this service is that process; core alarm functionality (arm/disarm, sensor monitoring, breach/life-safety detection, local siren) MUST work with zero internet/cloud dependency (SC-003, Assumptions); all state changes are pushed to clients, never polled (FR-008); native interface takes precedence on conflicting arm/disarm requests (FR-014)

**Scale/Scope**: Single household deployment; ≤50 Z-Wave devices across ≤10 zones (SC-005); a small number of concurrent household users across three roles (Administrator/Member/Guest, FR-010a)

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

`.specify/memory/constitution.md` is still the unfilled bootstrap template (placeholder principle names/descriptions, no ratified version). No enforceable principles exist yet, so there are no gates to evaluate against and no violations are possible at this time. **Recommendation**: run `/speckit.constitution` before or alongside implementation to ratify real engineering principles (e.g., test-first, dependency minimalism, observability) so future features have a real gate to check against.

**Post-Phase-1 re-check**: Unchanged — the constitution is still unratified, so the Phase 1 design (research.md, data-model.md, contracts/, quickstart.md) introduces no new gate violations by definition. Re-run this check once a real constitution exists.

## Project Structure

### Documentation (this feature)

```text
specs/001-zwave-alarm-ha-integration/
├── plan.md              # This file (/speckit-plan command output)
├── research.md          # Phase 0 output (/speckit-plan command)
├── data-model.md        # Phase 1 output (/speckit-plan command)
├── quickstart.md        # Phase 1 output (/speckit-plan command)
├── contracts/           # Phase 1 output (/speckit-plan command)
└── tasks.md             # Phase 2 output (/speckit-tasks command - NOT created by /speckit-plan)
```

### Source Code (repository root)

```text
src/
├── alarm/            # Panel state machine: arm/disarm, exit/entry delay, life-safety vs. intrusion gating
├── zwave/            # zwave-js driver bootstrap, node/value mapping, zwave-js-server bootstrap
├── auth/             # Users/roles (Administrator/Member/Guest), credential codes, failed-attempt lockout policy
├── events/           # Security event log persistence and query
├── api/              # Express REST routes + `ws` WebSocket push channel (native UI + custom component)
├── web/              # Minimal bundled static dashboard (native interface)
├── db/               # better-sqlite3 schema/migrations and repositories
└── config/           # 12-factor environment-variable configuration loading

tests/
├── contract/         # REST/WebSocket + Home Assistant custom-component payload contracts
├── integration/      # Alarm state machine + zwave-js device simulation flows
└── unit/

ha-integration/
└── custom_components/zwave_alarm/   # Home Assistant custom component (Python), consumes src/api's REST/WS contract
```

**Structure Decision**: Single repository, single deployable Node/TypeScript service (Option 1: single project), plus a `ha-integration/` top-level directory holding the Home Assistant custom component. The custom component is a separate language/runtime (Python, per Home Assistant's `custom_components` convention) and is versioned alongside the service it talks to, but is not part of the Node build or `src/` tree.

## Complexity Tracking

*No constitution gates are defined yet (see Constitution Check above), so no violations require justification. Table intentionally omitted.*
