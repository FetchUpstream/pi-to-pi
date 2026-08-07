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

A future adapter will persist compact `p2p.task` custom entries containing the
request ID, origin session/runtime identity, peer identity, state, timestamps,
and expiry. The fixture will exercise the same session-manager entry shape and
fold the latest record per request ID during `session_start(reason: "reload")`.

Request bodies remain in Pi custom-message entries when needed for context and
are not duplicated in task records. The state vocabulary for this change is
`accepted`, `completed`, `failed`, `expired`, and `superseded`; fork/clone
records use `superseded` with a reason rather than an additional ambiguous
`needs-reissue` state.

### Scope ownership to session identity

Reload preserves the current session and may recover its non-terminal tasks.
New sessions start with an empty task scope. Resume recovers only the selected
target session's records. Fork and clone create a new session identity; copied
non-terminal records are treated as inherited history and superseded before the
new session can complete them. The fixture will assert that the replacement
session does not inherit the outgoing agent's in-memory delivery queues.

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
  → **Mitigation:** Include origin session identity and assert inherited
  non-terminal records become `superseded`.
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
