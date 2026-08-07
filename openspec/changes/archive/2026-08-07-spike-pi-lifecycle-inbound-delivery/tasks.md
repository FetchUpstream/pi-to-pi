## 1. Build the deterministic Pi fixture

- [x] 1.1 Add a reusable in-process runtime fixture using `createAgentSessionRuntime()`, `createAgentSessionServices()`, `SessionManager`, `SettingsManager`, and a registered faux provider.
- [x] 1.2 Add an inline probe extension and rebinding helper that records lifecycle, agent, custom-message, session identity, and idle-state observations.
- [x] 1.3 Add persisted-session fixture helpers using isolated temporary directories for reload, resume, fork, and clone scenarios.

## 2. Verify Pi session lifecycle

- [x] 2.1 Test side-effect-free extension loading and resource creation/cleanup at `session_start` and `session_shutdown`.
- [x] 2.2 Test `agent_start`/`agent_end`/`agent_settled` ordering, including a scripted retry, compaction, or queued continuation where `agent_end` precedes settlement.
- [x] 2.3 Test reload ordering, stable session identity/name, and replacement ordering for `/new`, `/resume`, `/fork`, and clone, including target/previous session file fields.
- [x] 2.4 Test session-name bootstrap from `pi.getSessionName()` and subsequent `session_info_changed` rename propagation.

## 3. Verify inbound delivery and correlation

- [x] 3.1 Test idle custom delivery with `triggerTurn: true`, asserting request registration occurs first and request ID details survive events and session entries.
- [x] 3.2 Test busy `steer` and `followUp` delivery, asserting steering is processed before follow-up and each message retains independent request metadata.
- [x] 3.3 Add a request-scoped correlation helper/test that completes only the explicitly named request and rejects unknown IDs without inspecting the latest assistant message.

## 4. Verify task-state recovery and ownership

- [x] 4.1 Add helpers for append-only `p2p.task` metadata records and latest-state folding without duplicating message bodies.
- [x] 4.2 Test reload recovery of unexpired non-terminal tasks and exclusion of completed, failed, expired, or superseded tasks.
- [x] 4.3 Test that `/new` and `/resume` do not migrate the outgoing in-memory task scope, while resume recovers only the selected persisted session.
- [x] 4.4 Test that fork/clone inherited non-terminal records are superseded with a replacement reason and cannot be completed by the new session.

## 5. Document and validate the spike

- [x] 5.1 Reconcile `docs/adr/0001-pi-lifecycle-and-reply-correlation.md` with the executable fixture results and final task-state vocabulary.
- [x] 5.2 Run formatting, lint, typecheck, and test validation, and record any pre-existing repository validation failures separately from this change.
