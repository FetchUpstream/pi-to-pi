## Context

Pi-to-Pi is currently a package scaffold with lifecycle hook registration but no
peer router. The P2P-006 spike must establish the contract that a future adapter
can rely on without introducing transport or production task-routing logic.

The local development dependency is `@earendil-works/pi-coding-agent@0.84.1`.
The tested SDK exposes `createAgentSessionRuntime()`, `SessionManager`,
`SettingsManager`, custom-message delivery, extension lifecycle events, and
session replacement methods. A deterministic model is available through the
Pi AI faux provider, so the fixture does not require credentials, network
access, or child Pi processes.

## Goals / Non-Goals

**Goals:**

- Make lifecycle ordering and cleanup executable and repeatable.
- Cover idle delivery, busy steering, busy follow-up, retry/compaction settling,
  reload, and session replacement.
- Preserve an explicit request ID from acceptance through custom-message events
  and persisted entries.
- Define session-scoped task metadata recovery and fork/clone ownership rules.
- Keep the existing ADR aligned with the executable behavior.

**Non-Goals:**

- Implement sockets, discovery, peer routing, protocol handlers, or reply
  transport.
- Test platform-specific child-process behavior; that belongs to the separate
  process-testing wave.
- Infer or synthesize production assistant replies in the fixture.
- Persist request or response bodies in a second task-state store.

## Decisions

### Use an in-process Pi runtime fixture

Create a fixture around `createAgentSessionRuntime()` and a runtime factory that
uses `createAgentSessionServices()` with an inline extension. Register a faux
provider as a native provider and use `SessionManager.inMemory()` for fast
cases. Use a temporary persisted session directory for reload, resume, fork,
and clone cases.

This is preferred over shelling out to Pi because it makes event ordering,
queued-message state, session entries, and replacement boundaries observable
without platform-specific process behavior. The fixture will rebind the new
session with `session.bindExtensions()` after every runtime replacement, as a
real host mode does.

### Record events at the extension boundary

The probe extension will record `session_start`, `session_info_changed`,
`session_shutdown`, `agent_start`, `agent_end`, `agent_settled`, and custom
message start/end events. Assertions will include event order, session ID/file,
`targetSessionFile`, `previousSessionFile`, and `ctx.isIdle()`.

The test contract will use `agent_settled` as the point at which no automatic
continuation remains. `agent_end` is recorded only as an intermediate run
boundary; retries, compaction, and queued continuations must not complete a
request there.

### Correlate by request ID, never by transcript position

The fixture will model acceptance with a task map keyed by `requestId`, then
send a custom message whose opaque `details` contains that ID. A reply helper
will require the request ID explicitly and will transition only that task.

Idle messages use `triggerTurn: true`. Busy messages use `deliverAs: "steer"`
or `deliverAs: "followUp"`; the fixture asserts steering before follow-up
ordering. No assertion or implementation helper may use a global current
inbound request or the latest assistant message as correlation state.

### Persist metadata as append-only custom entries

A future adapter will persist compact `p2p.task` custom entries with the exact
version-1, body-free fields `version`, `requestId`, `sessionId`,
`ownerSessionId`, `runtimeId`, `peerId`, `state`, `updatedAt`, `expiresAt`,
and `reason`. `sessionId` is the immutable origin session identity captured
when the request is accepted. `ownerSessionId` is the current session identity
that wrote the latest record. For `superseded`, destination `ownerSessionId` is
audit-only and does not grant live ownership or completion authority. `runtimeId`
identifies the runtime that wrote the latest record, and `peerId` is the known
peer identity or `null`; peer identity and expiry remain immutable across
transitions. `reason` is `null` except on a `superseded` record, where it is
required.

The state vocabulary is exactly `accepted`, `completed`, `failed`, `expired`,
and `superseded`. Only `accepted` is non-terminal and eligible for recovery
when unexpired and owned by the selected session. Each transition appends a
new record; folding by `requestId` selects the latest record. Request bodies
remain in Pi custom-message entries when needed for context and are not
duplicated in task records.

### Scope ownership to session identity

Reload preserves the current session and may recover its latest unexpired
`accepted` records only when both `sessionId` and `ownerSessionId` match that
session. New sessions start with an empty task scope. Resume recovers only the
selected target session's records and never carries the outgoing in-memory map
into it.

Fork and clone create a new session identity. At the destination
`session_start`, the lifecycle binding automatically appends a `superseded`
record for each copied, unexpired, non-terminal record before destination
delivery. The superseding record preserves immutable `sessionId`, `peerId`, and
`expiresAt`, and records destination `ownerSessionId`, `runtimeId`, and a
replacement reason. The destination recovers no superseded task and cannot
complete it. Terminal or expired records are not changed; a fork branch that
predates a metadata entry has no record to supersede. Fork/clone replacement
therefore produces only `superseded` history rather than reopening copied work.

The lifecycle binding clears the outgoing active task scope at
`session_shutdown`, and Pi emits that boundary before the replacement
`session_start`. It does not migrate outgoing delivery queues or task state.

### Synchronize names through bootstrap plus change events

At every `session_start`, the adapter reads `pi.getSessionName()` to initialize
its published identity. It also subscribes to `session_info_changed` for later
renames. This covers already-named sessions loaded through reload, resume, fork,
and clone even when no rename event is emitted during the load.

## Risks / Trade-offs

- **[Risk] The Pi extension API changes after the pinned development version.**
  → **Mitigation:** Keep the fixture isolated behind test helpers, record the
  Pi version in the ADR, and use public SDK/runtime APIs only.
- **[Risk] Faux-provider streaming does not model every provider failure or
  compaction detail.** → **Mitigation:** Use scripted responses and explicit
  event assertions for ordering; leave provider/process integration to later
  waves.
- **[Risk] Aborting a replacement can drain queued custom messages before
  shutdown rather than dropping them.** → **Mitigation:** Assert ownership and
  persisted details on the outgoing session, but never rely on those queues
  migrating to the destination.
- **[Risk] Fork and clone copy extension entries along the selected branch.**
  → **Mitigation:** Include immutable `sessionId` and assert inherited
  non-terminal records become `superseded`.
- **[Limitation] Task-state lifecycle is fixture-only in this spike.**
  → The fixture validates the schema and in-process session boundaries;
  production persistence, transport, and crash recovery remain later work.
- **[Risk] The repository's current full format check includes pre-existing
  unformatted `.pi` skill files.** → **Mitigation:** Keep new artifacts and
  fixture files formatted and report baseline check failures separately.

## Migration Plan

No runtime migration is required. This change adds tests, fixture utilities,
specifications, and documentation only. A later implementation wave can adopt
the task-entry schema and lifecycle rules; rollback consists of removing the
new fixture and report without changing existing session files or transport
behavior.

## Open Questions

None block this spike. A later production-routing change must decide wire-level
reply/error schemas, timeout policy, cancellation, and how a stale runtime is
reconciled with the discovery registry.
