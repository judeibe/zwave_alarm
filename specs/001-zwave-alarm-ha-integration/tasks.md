---

description: "Task list template for feature implementation"
---

# Tasks: Self-Hosted Z-Wave Alarm System with Home Assistant Integration

**Input**: Design documents from `/specs/001-zwave-alarm-ha-integration/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/, quickstart.md

**Tests**: Not explicitly requested in the feature specification, so no dedicated test tasks are included below. Add them ahead of implementation for any story if a test-first approach is later required.

**Organization**: Tasks are grouped by user story to enable independent implementation and testing of each story.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (e.g., US1, US2, US3)
- Include exact file paths in descriptions

## Path Conventions

Single project (per `plan.md`): `src/`, `tests/` at repository root, plus `ha-integration/custom_components/zwave_alarm/` for the Home Assistant custom component.

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Project initialization and basic structure

- [ ] T001 Create project structure per plan.md (`src/{alarm,zwave,auth,events,api,web,db,config}/`, `tests/{contract,integration,unit}/`, `ha-integration/custom_components/zwave_alarm/`)
- [ ] T002 Initialize the Node/TypeScript project: `package.json`, `tsconfig.json`, and dependencies (`express`, `zwave-js`, `zwave-js-server`, `ws`, `better-sqlite3`)
- [ ] T003 [P] Configure ESLint + Prettier for the TypeScript project (`.eslintrc`, `.prettierrc`)
- [ ] T004 [P] Configure Vitest in `vitest.config.ts` and add `test`/`test:watch` npm scripts
- [ ] T005 [P] Write `Dockerfile` and `docker-compose.yml` with Z-Wave USB device passthrough for local/self-hosted runs
- [ ] T006 [P] Implement 12-factor environment configuration loader in `src/config/index.ts` (`SERIAL_PORT`, `DB_PATH`, REST/WS ports, `.env.example`)

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Core infrastructure that MUST be complete before ANY user story can be implemented

**⚠️ CRITICAL**: No user story work can begin until this phase is complete

- [ ] T007 Create SQLite schema and migration runner in `src/db/schema.ts` (`better-sqlite3`) covering all tables from `data-model.md`
- [ ] T008 [P] Implement a generic repository base (query/transaction helpers) in `src/db/repository.ts`
- [ ] T009 Bootstrap the `zwave-js` driver connection (owns the serial port, FR-005) in `src/zwave/driver.ts`
- [ ] T010 Bootstrap `zwave-js-server` on top of the driver in `src/zwave/server.ts`, exposing the standard protocol Home Assistant's built-in Z-Wave JS integration will consume
- [ ] T011 [P] Implement the Express app skeleton, error-handling middleware, and error-response format in `src/api/app.ts` (`contracts/rest-api.md` error format)
- [ ] T012 [P] Implement the `ws` push-channel skeleton (connect, `snapshot` handshake, `ping`/`pong`) in `src/api/ws.ts` per `contracts/websocket-events.md`
- [ ] T013 Implement session-cookie authentication middleware for the native dashboard in `src/auth/session.ts`
- [ ] T014 Implement bearer-token authentication middleware for Home Assistant links in `src/auth/token.ts`
- [ ] T015 [P] Implement the single-writer AlarmPanel command dispatcher enforcing native-interface precedence (FR-014) in `src/alarm/dispatcher.ts`
- [ ] T016 [P] Implement structured logging setup in `src/config/logger.ts`

**Checkpoint**: Foundation ready - user story implementation can now begin

---

## Phase 3: User Story 1 - Arm, disarm, and monitor the alarm from the native system (Priority: P1) 🎯 MVP

**Goal**: A homeowner can arm/disarm the system and monitor every sensor's state and faults using only the native interface, with the alarm fully protecting the home independent of Home Assistant.

**Independent Test**: Connect a Z-Wave USB controller and a few sensors, arm the system, open a monitored door, and confirm the system detects the breach and raises an alarm — with no Home Assistant instance running at all.

### Implementation for User Story 1

- [ ] T017 [P] [US1] Create AlarmPanel model + repository (singleton, mode/pendingDelayEndsAt/triggeredBy) in `src/alarm/panel-repository.ts`
- [ ] T018 [P] [US1] Create Zone model + repository in `src/db/repositories/zone-repository.ts`
- [ ] T019 [P] [US1] Create SensorDevice model + repository, including the `intrusion`/`life-safety` category field, in `src/db/repositories/sensor-repository.ts`
- [ ] T020 [P] [US1] Create SecurityEvent model + repository (append-only log) in `src/events/event-repository.ts`
- [ ] T021 [P] [US1] Create User model + repository with Administrator/Member/Guest roles (FR-010a) in `src/auth/user-repository.ts`
- [ ] T022 [P] [US1] Create LockoutPolicy model + repository (threshold/cooldown/mode) in `src/auth/lockout-policy-repository.ts`
- [ ] T023 [US1] Implement the AlarmPanel state-machine service — arm/disarm, exit/entry delay, life-safety sensors bypass delay (FR-001, FR-003, FR-004, FR-015) — in `src/alarm/panel-service.ts` (depends on T017-T020, T015)
- [ ] T024 [US1] Implement `zwave-js` node-to-sensor mapping, breach detection, and connectivity/battery fault detection (FR-002, FR-012) in `src/zwave/sensor-mapper.ts` (depends on T009, T019)
- [ ] T025 [US1] Implement failed disarm-attempt lockout enforcement, including the `trigger_alarm` mode switch (FR-016) in `src/auth/lockout-service.ts` (depends on T021, T022, T023)
- [ ] T026 [US1] Implement local siren activation on `alarm_triggered` via a configured Z-Wave alert device (FR-013) in `src/alarm/siren.ts` (depends on T023)
- [ ] T027 [US1] Implement REST endpoints `POST /api/v1/auth/login`, `POST /api/v1/auth/logout`, `GET/POST /api/v1/panel*`, `GET/POST /api/v1/zones`, `POST /api/v1/zones/{zoneId}/sensors`, `GET/POST/DELETE /api/v1/users` in `src/api/routes/` (depends on T023-T025)
- [ ] T028 [US1] Implement `GET /api/v1/events` in `src/api/routes/event-routes.ts` (depends on T020)
- [ ] T029 [US1] Wire panel/sensor/event changes to the WebSocket channel (`panel.changed`, `sensor.changed`, `sensor.fault`, `event.recorded`) in `src/api/ws-broadcaster.ts` (depends on T012, T023, T024)
- [ ] T030 [US1] Build the minimal bundled static dashboard (arm/disarm controls, zone/sensor status, fault indicators) in `src/web/index.html` and `src/web/app.js`, served by Express (depends on T027, T029)

**Checkpoint**: At this point, User Story 1 should be fully functional and testable independently of Home Assistant

---

## Phase 4: User Story 2 - Monitor and control the alarm from Home Assistant (Priority: P2)

**Goal**: A Home Assistant user installs the custom component so alarm and sensor state appear as entities and can drive automations/dashboards.

**Independent Test**: Install the custom component in a Home Assistant instance pointed at the running alarm system and confirm arm/disarm and sensor changes made natively are reflected in Home Assistant in near real time.

### Implementation for User Story 2

- [ ] T031 [P] [US2] Create HomeAssistantLink model + repository (token hash, label, connection status) in `src/db/repositories/ha-link-repository.ts`
- [ ] T032 [US2] Implement `POST /api/v1/ha-links` and `DELETE /api/v1/ha-links/{linkId}` (token issuance/revocation) in `src/api/routes/ha-link-routes.ts` (depends on T031, T014)
- [ ] T033 [US2] Harden `zwave-js-server`'s bound host/port for external Home Assistant consumption in `src/zwave/server.ts` (depends on T010)
- [ ] T034 [US2] Implement WebSocket reconnect/resync semantics — fresh `snapshot` required after reconnect — in `src/api/ws.ts` (depends on T012, T029)
- [ ] T035 [P] [US2] Scaffold the Home Assistant custom component (`manifest.json`, `config_flow.py` validating against `GET /api/v1/panel`) in `ha-integration/custom_components/zwave_alarm/`
- [ ] T036 [US2] Implement the `alarm_control_panel.zwave_alarm` entity in `ha-integration/custom_components/zwave_alarm/alarm_control_panel.py` (depends on T035, T027)
- [ ] T037 [P] [US2] Implement per-zone `binary_sensor.zwave_alarm_zone_<zone>` entities in `ha-integration/custom_components/zwave_alarm/binary_sensor.py` (depends on T035)
- [ ] T038 [P] [US2] Implement the `sensor.zwave_alarm_fault_count` entity in `ha-integration/custom_components/zwave_alarm/sensor.py` (depends on T035)
- [ ] T039 [US2] Implement the WebSocket client coordinator with retry/backoff and `unavailable`-state handling (FR-006) in `ha-integration/custom_components/zwave_alarm/coordinator.py` (depends on T034, T035)

**Checkpoint**: At this point, User Stories 1 AND 2 should both work independently, plus raw sensor entities via Home Assistant's built-in Z-Wave JS integration talking to T010/T033

---

## Phase 5: User Story 3 - Receive alerts when the alarm is triggered (Priority: P3)

**Goal**: Occupants are notified promptly when the alarm triggers, via the local siren natively and via Home Assistant automations remotely.

**Independent Test**: Trigger an alarm condition and confirm the local siren notification fires without requiring the Home Assistant integration to be configured.

### Implementation for User Story 3

- [ ] T040 [US3] Extend siren activation with configurable target Z-Wave alert device selection (FR-013) in `src/alarm/siren.ts` (depends on T026)
- [ ] T041 [US3] Record and broadcast "alarm cleared, and by whom" detail on disarm-after-trigger (User Story 3 acceptance scenario 2) in `src/alarm/panel-service.ts` and `src/api/ws-broadcaster.ts` (depends on T023, T029)
- [ ] T042 [P] [US3] Document a sample Home Assistant automation (notify on `alarm_control_panel.zwave_alarm` → `triggered`) in `ha-integration/README.md` (depends on T036)

**Checkpoint**: All user stories should now be independently functional

---

## Phase 6: Polish & Cross-Cutting Concerns

**Purpose**: Improvements that affect multiple user stories

- [ ] T043 [P] Write top-level `README.md` covering setup, environment variables, and deployment
- [ ] T044 [P] Add request validation (e.g., zod schemas) across all REST endpoints in `src/api/validation.ts`
- [ ] T045 Security hardening: hash disarm codes and HA tokens (e.g., argon2/bcrypt), rate-limit `/api/v1/auth/login` in `src/auth/`
- [ ] T046 [P] Add structured logging across `src/zwave/`, `src/alarm/`, and `src/api/` using the Phase 2 logger
- [ ] T047 Run the full `quickstart.md` validation end-to-end and fix any gaps found
- [ ] T048 [P] Optimize the multi-stage `Dockerfile` build (dependency caching, image size)

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies - can start immediately
- **Foundational (Phase 2)**: Depends on Setup completion - BLOCKS all user stories
- **User Story 1 (Phase 3)**: Depends only on Foundational
- **User Story 2 (Phase 4)**: Depends on Foundational; T036 additionally depends on US1's `T027` (panel REST endpoints) and T039 on US1/US2's WebSocket work
- **User Story 3 (Phase 5)**: Depends on Foundational; T040/T041 extend US1's siren/panel-service files, T042 documents US2's `alarm_control_panel` entity
- **Polish (Phase 6)**: Depends on all desired user stories being complete

### User Story Dependencies

- **User Story 1 (P1)**: No dependencies on other stories — the true independent MVP
- **User Story 2 (P2)**: Independently testable via the raw Z-Wave JS protocol path (T010/T033) alone, but its `alarm_control_panel` entity (T036) reuses US1's REST endpoints
- **User Story 3 (P3)**: Independently testable via the local siren alone (T026/T040); its Home Assistant-automation documentation (T042) assumes US2 is also present

### Within Each User Story

- Models before services
- Services before endpoints
- Core implementation before integration (WebSocket broadcast, dashboard, HA entities)
- Story complete before moving to next priority

### Parallel Opportunities

- Setup tasks T003-T006 can run in parallel
- Foundational tasks T008, T011, T012, T015, T016 can run in parallel once T007/T009/T010/T013/T014 land
- All US1 model tasks T017-T022 can run in parallel
- US2's T031, T035, T037, T038 can run in parallel
- Once Foundational completes, US1, US2, and US3 implementation can proceed in parallel by different developers, keeping in mind the cross-story file touches noted above

---

## Parallel Example: User Story 1

```bash
# Launch all models for User Story 1 together:
Task: "Create AlarmPanel model + repository in src/alarm/panel-repository.ts"
Task: "Create Zone model + repository in src/db/repositories/zone-repository.ts"
Task: "Create SensorDevice model + repository in src/db/repositories/sensor-repository.ts"
Task: "Create SecurityEvent model + repository in src/events/event-repository.ts"
Task: "Create User model + repository in src/auth/user-repository.ts"
Task: "Create LockoutPolicy model + repository in src/auth/lockout-policy-repository.ts"
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Phase 1: Setup
2. Complete Phase 2: Foundational (CRITICAL - blocks all stories)
3. Complete Phase 3: User Story 1
4. **STOP and VALIDATE**: Run `quickstart.md` §3 independently, with Home Assistant off
5. Deploy/demo if ready — this is a fully working self-hosted alarm on its own

### Incremental Delivery

1. Complete Setup + Foundational → Foundation ready
2. Add User Story 1 → Validate via `quickstart.md` §3 → Deploy/Demo (MVP!)
3. Add User Story 2 → Validate via `quickstart.md` §4 → Deploy/Demo
4. Add User Story 3 → Validate via `quickstart.md` §5-6 → Deploy/Demo
5. Each story adds value without breaking previous stories

### Parallel Team Strategy

With multiple developers, once Foundational is done: Developer A takes User Story 1, Developer B takes User Story 2 (can start on the custom component scaffold and raw Z-Wave JS server hardening immediately, integrating with US1's endpoints once available), Developer C takes User Story 3.

---

## Notes

- [P] tasks = different files, no dependencies
- [Story] label maps task to specific user story for traceability
- No test tasks were generated — tests were not requested in `spec.md`; add contract/integration tests ahead of implementation if TDD is desired later
- Commit after each task or logical group
- Stop at any checkpoint to validate a story independently using the matching `quickstart.md` section
