# Pi lifecycle and reply-correlation spike

**Status:** Accepted for the P2P-006 spike  
**Pi version:** `@earendil-works/pi-coding-agent@0.84.1`  
**Scope:** Pi integration semantics only; no transport or production router

## Decision

Pi-to-Pi will treat an accepted request as an explicit task identified by its
`requestId`. The request ID is stored before delivery, carried in the custom
message `details`, and supplied explicitly to `p2p_reply(requestId, ...)`.
Reply selection must never use a global `currentInbound`, the newest inbound
request, or the latest assistant message in the session.

`agent_settled` is the completion boundary for a Pi turn. The scripted retry
fixture shows that `agent_end` marks only an intermediate low-level run and must
not complete a request. Compaction and automatic queued-continuation behavior
are untested by this spike and are not part of its observed lifecycle contract.

## Repeatable fixture

The observations below were reproduced with an in-process fixture using:

- `createAgentSessionRuntime()` and `createAgentSessionFromServices()`;
- `SessionManager.inMemory()` or a temporary persisted session directory;
- `SettingsManager.inMemory()`;
- a registered `fauxProvider()` model;
- an inline extension loaded through `DefaultResourceLoader` and rebound with
  `session.bindExtensions()` after each runtime replacement.

The fixture records extension events, custom-message events, session IDs/files,
`ctx.isIdle()`, session entries, and custom-message `details`.

## Observed lifecycle

```text
session_start(startup)
  └─ agent_start
       └─ agent_end
            └─ scripted retry (observed)
                 └─ agent_settled
```

- During `agent_end`, `ctx.isIdle()` is still false.
- At the observed `agent_settled`, `ctx.isIdle()` is true and the scripted retry
  has no remaining continuation; compaction and automatic queued-continuation
  cases are untested.
- `session_shutdown` runs before the old session is disposed. The old context
  is still usable for cleanup and is idle by the time replacement teardown
  completes.
- `session_start` runs on the replacement session after teardown. The new
  session has a new session ID; its context is idle at startup.

### Reload

`/reload` emits:

```text
session_shutdown(reason: "reload")
  └─ session_start(reason: "reload")
```

The session file, session ID, and session name survive. Reload does not itself
emit `session_info_changed`. Resources must therefore be closed and recreated
at these lifecycle boundaries, and startup must read `pi.getSessionName()`
directly.

### Session replacement

`/new`, `/resume`, and `/fork` emit shutdown on the old session followed by
start on the new session. The shutdown event includes `targetSessionFile` and
the start event includes `previousSessionFile`. Clone is the runtime's fork
operation with `position: "at"`, so it uses `reason: "fork"` as well.

The replacement runtime does not inherit the old in-memory delivery queues.
Pi first aborts/waits for the outgoing agent; queued custom messages may be
drained and persisted on the outgoing session while that abort settles. They
must still be treated as belonging to the outgoing session, not silently
migrated to the destination.

A persisted `/new` session starts with new header/config entries and no old
conversation. `/resume` loads the target file's own history. `/fork` normally
branches before the selected user message and returns that message text for
editing; clone copies the current branch. A clone can therefore copy extension
metadata entries and must not claim inherited pending work automatically.

## Message delivery observations

| Agent state | Pi call                                   | Result                                                                                                           |
| ----------- | ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| idle        | `sendMessage(..., { triggerTurn: true })` | custom message is persisted, a turn starts, and the custom message appears in message events and session entries |
| busy        | `deliverAs: "steer"`                      | delivered after the current assistant response/tool work and before a follow-up                                  |
| busy        | `deliverAs: "followUp"`                   | delivered after steering messages and only when the agent would otherwise stop                                   |

A fixture queued one steer request `S` and one follow-up request `F`. The
observed order was `S`, assistant response, `F`, assistant response. Both
custom entries retained their independent `{ requestId }` details. This shows
that multiple requests can be carried through one Pi session without a global
inbound pointer.

`details` is opaque extension metadata. Pi preserves it through message events
and persisted custom-message entries, but does not correlate replies or attach
semantic request ownership to it. Correlation remains the extension's job.

## Persistence and replacement rule

Persist only task metadata, not a second copy of the request body. The
fixture exercises an exact version-1, body-free `p2p.task` metadata shape:

```json
{
  "version": 1,
  "requestId": "...",
  "sessionId": "...",
  "ownerSessionId": "...",
  "runtimeId": "...",
  "peerId": null,
  "state": "accepted",
  "updatedAt": "...",
  "expiresAt": null,
  "reason": null
}
```

`sessionId` is the immutable origin session identity captured when the request
is accepted. `ownerSessionId` is the current session identity that wrote the
latest record; it starts equal to `sessionId` and changes to the destination
session only when that destination appends a supersession record.
For a superseded record, `ownerSessionId` is audit-only: the terminal
state grants no live ownership or completion authority.
In this fixture, `runtimeId` is a non-empty, caller-supplied provenance label
from the fixture option or transition call. It is not derived from or validated
against the bound `AgentSessionRuntime`; uniqueness and writer authenticity are
not enforced, so it is not evidence of actual runtime identity. That production
identity contract remains outside this spike. `peerId` is the peer identity when
known and immutable across transitions. `reason` is `null` except on a
`superseded` record, where it is required. `expiresAt` is nullable. The state
vocabulary is exactly `accepted`, `completed`, `failed`, `expired`, and
`superseded`; only `accepted` is recoverable/non-terminal.
Each transition appends a new record, and folding by `requestId` makes the
latest record authoritative. Metadata contains no request or response body.

The fixture applies this transition matrix; expiry is evaluated at `now`, and a
`null` `expiresAt` means that an accepted record does not expire:

| Current latest state                              | Next state              | Allowed condition                                                                        | Result                                        |
| ------------------------------------------------- | ----------------------- | ---------------------------------------------------------------------------------------- | --------------------------------------------- |
| no record                                         | `accepted`              | Initial append; `expiresAt` is an ISO timestamp or `null`; `reason` is `null`            | Non-terminal                                  |
| `accepted`                                        | `completed` or `failed` | Current session owns the record and it is unexpired, including `expiresAt: null`         | Terminal                                      |
| `accepted`                                        | `expired`               | Current session owns the record and a non-null `expiresAt` is at or before `now`         | Terminal                                      |
| `accepted`                                        | `superseded`            | Lifecycle-authorized inherited fork/clone record is unexpired and has a non-empty reason | Terminal; destination ownership is audit-only |
| `accepted`                                        | `accepted`              | Never                                                                                    | Rejected                                      |
| `completed`, `failed`, `expired`, or `superseded` | Any state               | Never; terminal records have no outgoing transitions                                     | Rejected                                      |

An accepted record may be appended with an already-passed expiry, but recovery
excludes it and only the explicit `accepted` → `expired` transition is valid.
Every allowed transition appends a record, preserves `sessionId`, `peerId`, and
`expiresAt`, and does not move `updatedAt` backwards. `requestId` is folded only
within the selected session branch; this fixture does not establish process-global
request ID uniqueness.

On `session_start(reason: "reload")`, fold the latest `p2p.task` record for
each request ID and recover only records whose state is `accepted`, whose
expiry has not passed, and whose `sessionId` and `ownerSessionId` both equal
the selected session ID. Completed, failed, expired, superseded, and expired
accepted records do not reopen. The request body remains in Pi's
custom-message entry, if needed for the conversation, and is not copied into
the task record.

Task ownership and lifecycle boundaries are session-scoped:

- **reload:** `session_shutdown` clears the outgoing runtime's active task
  scope; the following `session_start` binds the same session and recovers its
  live records.
- **new:** the replacement starts with an empty task scope. Outgoing records
  and queues remain associated with the outgoing session; no task state is
  migrated or synthesized by the replacement.
- **resume:** the replacement recovers only the selected target session's
  records; the outgoing in-memory map is not carried over.
- **fork/clone:** the replacement `session_start` automatically appends a
  `superseded` record for each copied, unexpired, non-terminal task before
  destination delivery. The record preserves `sessionId`, `peerId`, and
  `expiresAt`, sets `ownerSessionId` to the destination session and `runtimeId`
  to the destination caller-supplied fixture option,
  and requires a replacement reason. It is terminal and cannot be completed
  by the destination. Terminal/expired records are not changed, and a fork
  branch that predates a metadata entry contains no record to supersede.
  Fork/clone replacement therefore produces only `superseded` history; a new
  request must be accepted explicitly rather than reopening copied work.

The lifecycle binding runs task recovery and fork/clone supersession during
`session_start` before any destination turn and resets the active scope at
`session_shutdown`; `session_shutdown` runs before replacement
`session_start`. It does not migrate queued delivery state.

The task key is `requestId` folded within the selected session branch. This
fixture does not enforce process-global `requestId` uniqueness; session identity
and owner fields enforce scope rather than a process-global current request.

## Session-name synchronization

At every `session_start`, initialize the published display name from
`pi.getSessionName()`. Also subscribe to `session_info_changed` and update the
published identity when a rename occurs. The event-driven path handles later
renames; the startup read handles reload, resume, fork, and clone paths where a
name can already exist without a new rename event.

## Fixture-only limitation

The task-state lifecycle and metadata writer remain test-fixture utilities in
this spike; no production adapter consumes or persists them. The in-process
faux provider and temporary session files do not validate transport,
cross-process failure, or production router behavior.

The fixture appends every `p2p.task` transition without pruning terminal records
or bounding session-file history. This unbounded-retention limitation is measured
against the repository retention convention in `SPEC.md`; production retention and
garbage collection remain outside this spike.
The harness also cannot prove crash durability for a metadata append before
Pi's first assistant entry. It records the observed session-file flush boundary
but leaves production durability and recovery after abrupt process loss to a
later implementation wave.

## Consequences

- Reply production belongs at an explicit `p2p_reply(requestId, ...)` call or
  equivalent task-store transition.
- A Pi lifecycle handler must be idempotent: `session_shutdown` closes only
  resources owned by that runtime, and `session_start` creates the new
  session-scoped resources.
- Cross-platform child-process testing remains a separate concern for P2P-007/
  issue #8; this spike validates the current extension API in process.
