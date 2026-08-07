## Context

Pi-to-Pi currently contains placeholders for Agent Cards, the filesystem registry, and lease handling. The extension runs inside independent Pi sessions, so discovery must not depend on a parent process, a broker, or a shared message store. Pi exposes a stable session ID through `ctx.sessionManager.getSessionId()`, an optional display name through `pi.getSessionName()`, model state through `ctx.model`, context usage through `ctx.getContextUsage()`, and session lifecycle boundaries through `session_start` and `session_shutdown`.

The registry is same-machine discovery infrastructure. It must distinguish a logical Pi session from the exact extension runtime that owns an endpoint, work with concurrent starts and reloads, and avoid exposing conversation bodies or credentials.

## Goals / Non-Goals

**Goals:**

- Define a versioned, validated Agent Card contract.
- Provide deterministic room-scoped discovery without display-name or raw-path filenames.
- Make each runtime the sole writer and lease owner of its card.
- Make publication crash-tolerant through same-directory atomic replacement.
- Provide bounded presence semantics through renewable leases and stale-record cleanup.
- Preserve private per-user filesystem semantics on POSIX and Windows.
- Keep the registry independent of local IPC framing and message routing.

**Non-Goals:**

- Implementing request, reply, notification, or task-state protocols.
- Choosing length-prefixed JSON versus HTTP for local IPC.
- Offline delivery or a central broker/daemon.
- Mandatory capability-token authentication; that belongs to later transport/security work.
- Deriving room identity inside the registry.
- Persisting full prompts, responses, or task bodies in registry records.

## Decisions

### Runtime root

The registry uses the first usable location in this order:

1. `PI_TO_PI_RUNTIME_DIR`, when it is an absolute, private directory override.
2. `$XDG_RUNTIME_DIR/pi-to-pi` on POSIX when `XDG_RUNTIME_DIR` is absolute, user-owned, and private.
3. `%LOCALAPPDATA%\\pi-to-pi\\runtime` on Windows.
4. A deterministic per-user child of `os.tmpdir()` as a fallback, using the POSIX UID or a stable user-home key to avoid cross-user collisions.

The implementation creates and validates the root with `0700` semantics on POSIX. It must warn when the XDG runtime directory is unavailable and the fallback is used. It must fail closed if it cannot establish a private root rather than silently selecting a shared directory. Pi's persistent `PI_CODING_AGENT_DIR` and `--session-dir` are intentionally not used as registry roots.

### Identity and room boundaries

The identity module supplies a stable session ID and a fresh random runtime instance ID for every extension runtime start, including reloads. The room module supplies a canonical `roomId` and safe filesystem `storageKey`; the registry consumes and validates both and never hashes display names or raw room input.

The effective display name comes from Pi's session name. If no name is set, the card uses a non-secret runtime-derived fallback so every card remains addressable without treating a user prompt as metadata. Model and context values use explicit nullability: an unavailable model is `null`; unavailable context usage is `null`; unknown token/percentage subvalues are also `null` rather than zero.

### Registry layout

Each room has an independent directory:

```text
<Pi-to-Pi runtime root>/
└── rooms/
    └── <storageKey>/
        └── agents/
            ├── <runtimeInstanceId>.json
            └── <runtimeInstanceId>.json
```

The filename and the `runtimeInstanceId` in the payload must match exactly. Display names, session IDs, process IDs, and endpoint addresses are never used as record keys. There is no global index and no message body in the registry.

### Agent Card shape

The v1 card is JSON and includes protocol version, session ID, runtime instance ID, effective display name, room ID, optional purpose, optional working-directory label and role tags, nullable model information, protocol capabilities, state, nullable context usage, inbound queue depth, endpoint descriptor, runtime start time, and lease expiry.

The endpoint is an opaque transport descriptor containing its transport kind and address plus the owning runtime identity. The card contains no capability secret. A later transport/security design may add authentication without changing registry ownership rules.

### Atomic publication and ownership

A runtime writes a complete card to a unique temporary file in the target `agents` directory, applies restrictive file permissions, flushes as required by the platform implementation, and replaces the final filename with same-directory rename. Renewal is serialized by the owning runtime so concurrent timers cannot reorder snapshots.

Only the runtime instance that owns a filename may publish or remove it. Cleanup re-reads a candidate before removal and compares its runtime identity and lease state, preventing a cleanup race from deleting a newer replacement. Readers treat a missing or partially written file as absent.

### Lease and cleanup policy

The initial defaults are a 90-second lease TTL and a 30-second renewal interval. A card is discoverable only while its lease has not expired and its schema, room, and protocol version are valid. Shutdown attempts best-effort removal, but expiry remains authoritative for crashes and forced termination.

Expired records become cleanup-eligible after an additional two TTLs. Cleanup is best effort, bounded, and never required for correctness. Registry reads do not create an all-to-all peer heartbeat mesh; presence comes from self-renewal. Endpoint probing is reserved for explicit diagnostics or a transport operation.

### Pi lifecycle integration

Long-lived registry resources start at `session_start` and stop idempotently at `session_shutdown`. A reload closes the old runtime's endpoint/timers and registers a new runtime instance while retaining the logical session ID. Extension factory execution does not start registry timers or sockets.

### Validation and platform protection

Malformed, unsupported, cross-room, expired, or structurally invalid cards are ignored as individual records and cannot prevent discovery of other valid cards. Protocol fields, IDs, enum values, queue counts, timestamps, endpoint descriptors, and card size are bounded before use.

On POSIX, the runtime tree and card files use private `0700` directories and `0600` files. On Windows, the implementation uses a per-user LocalAppData location and ACL-based protection; POSIX mode bits are not treated as a Windows security mechanism.

## Risks / Trade-offs

- **[XDG runtime directory is unavailable]** → Use a private per-user temporary fallback, warn once, and fail closed if privacy cannot be verified.
- **[Windows ACL behavior differs from POSIX]** → Keep the platform-specific protection boundary explicit and cover it with Windows process tests.
- **[A process crashes between temporary write and rename]** → Readers ignore temporary files and malformed records; cleanup removes abandoned temporary files conservatively.
- **[Wall-clock changes affect expiry]** → Use bounded ISO wall-clock timestamps in cards, tolerate small local clock changes, and retain a generous cleanup grace period.
- **[A late renewal races with cleanup]** → Serialize owner writes and re-read/compare the candidate immediately before deletion.
- **[Card schema evolves]** → Include `protocolVersion`, reject incompatible versions without failing the whole room, and keep future fields additive where possible.
- **[Persistent Windows runtime roots retain stale files across reboot]** → Lease expiry and delayed cleanup bound their visibility and storage lifetime.

## Migration Plan

There is no existing supported registry format in this repository. The new implementation creates its own namespaced runtime root and ignores malformed or incompatible records, so rollout does not require transforming legacy files. Shutdown cleanup remains best effort; expiry handles records left by older or crashed runtimes.

Rollback is safe because the registry is discovery-only: removing the extension or reverting the implementation stops publication, and no application data or conversation history is modified.

## Open Questions

No questions block this change. Local IPC framing, task persistence across reload, automatic replies, first-contact policy, and capability-token authentication remain explicit follow-up work outside this registry contract.
