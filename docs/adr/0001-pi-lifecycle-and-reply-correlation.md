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

`agent_settled` is the completion boundary for a Pi turn. `agent_end` only
marks the end of one low-level run and must not complete a request: retries,
auto-compaction, and queued continuations can follow it.

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
            ├─ retry / compaction / queued continuation
            └─ agent_settled
```

- During `agent_end`, `ctx.isIdle()` is still false.
- At `agent_settled`, `ctx.isIdle()` is true and no automatic continuation
  remains.
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

A persisted `/new` session starts with a new header/config entries and no old
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

Persist only task metadata, not a second copy of the request body. A compact
append-only custom entry such as `p2p.task` can record state transitions:

```json
{
  "version": 1,
  "requestId": "...",
  "originSessionId": "...",
  "originRuntimeId": "...",
  "peerSessionId": "...",
  "state": "accepted|completed|failed|expired|superseded",
  "updatedAt": "...",
  "expiresAt": "..."
}
```

On `session_start(reason: "reload")`, fold the latest `p2p.task` record for
each request ID and recover non-terminal tasks. The request body remains in
Pi's custom-message entry, if needed for the conversation, and is not copied
into the task record.

Task ownership is session-scoped:

- **reload:** recover the same session's non-terminal records;
- **new:** create an empty task scope; finish or mark outgoing tasks before
  teardown, but do not migrate them;
- **resume:** recover only records from the selected target session;
- **fork/clone:** treat copied non-terminal records as inherited history and
  mark them `superseded`/`needs-reissue` rather than allowing both sessions to
  complete the same request.

The task key should include the originating session identity (with the globally
unique request ID), not just a process-global current request.

## Session-name synchronization

At every `session_start`, initialize the published display name from
`pi.getSessionName()`. Also subscribe to `session_info_changed` and update the
published identity when a rename occurs. The event-driven path handles later
renames; the startup read handles reload, resume, fork, and clone paths where a
name can already exist without a new rename event.

## Consequences

- Reply production belongs at an explicit `p2p_reply(requestId, ...)` call or
  equivalent task-store transition.
- A Pi lifecycle handler must be idempotent: `session_shutdown` closes only
  resources owned by that runtime, and `session_start` creates the new
  session-scoped resources.
- Cross-platform child-process testing remains a separate concern for P2P-007/
  issue #8; this spike validates the current extension API in process.
