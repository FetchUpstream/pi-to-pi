## 1. Contracts and validation

- [ ] 1.1 Define the versioned Agent Card, model, context-usage, capability, state, and endpoint descriptor types in `src/protocol/agent-card.ts`.
- [ ] 1.2 Define explicit nullability and effective display-name rules for unset Pi model, context usage, purpose, and session name values.
- [ ] 1.3 Implement strict card validation in `src/protocol/validation.ts`, including protocol version, identity matching, room matching, enum values, timestamps, queue bounds, endpoint shape, and card-size limits.
- [ ] 1.4 Add the room-module contract for canonical `roomId` plus safe `storageKey`, and make the registry consume it without re-deriving raw room input.

## 2. Runtime root and filesystem primitives

- [ ] 2.1 Implement platform runtime-root resolution using `PI_TO_PI_RUNTIME_DIR`, POSIX `XDG_RUNTIME_DIR`, Windows LocalAppData, and a private per-user temporary fallback.
- [ ] 2.2 Create and validate private runtime, room, and agent directories with POSIX `0700`/`0600` semantics and Windows ACL-aware handling.
- [ ] 2.3 Implement unique same-directory temporary card writes followed by atomic replacement, including cleanup of abandoned temporary files.
- [ ] 2.4 Add safe path construction for `rooms/<storageKey>/agents/<runtimeInstanceId>.json` and reject unsafe storage keys or identity/path mismatches.

## 3. Registry and lease implementation

- [ ] 3.1 Implement instance-keyed card publication, renewal, listing, and exact-owner removal in `src/discovery/registry.ts`.
- [ ] 3.2 Implement serialized lease renewal with the 90-second TTL and 30-second renewal defaults in `src/discovery/lease.ts`.
- [ ] 3.3 Make discovery omit expired, malformed, incompatible, and cross-room records without aborting the rest of a room listing.
- [ ] 3.4 Implement delayed stale-record cleanup after expiry plus two TTLs, re-reading candidates before deletion to avoid renewal races.
- [ ] 3.5 Keep registry operations metadata-only and avoid periodic peer heartbeat probing or capability-token storage.

## 4. Pi lifecycle integration

- [ ] 4.1 Create a fresh runtime instance identity at each `session_start` while retaining Pi's logical session ID across reloads.
- [ ] 4.2 Populate and refresh card metadata from Pi session name, model selection, context usage, runtime state, and inbound queue depth.
- [ ] 4.3 Start registry resources only from session lifecycle handlers and make `session_shutdown` cleanup idempotent across reload, new-session, resume, fork, and quit flows.
- [ ] 4.4 Expose the registry through the existing discovery interfaces without coupling it to local IPC framing or message routing.

## 5. Verification

- [ ] 5.1 Add unit tests for Agent Card schema validation, nullability, identity matching, room/storage-key validation, and runtime-root selection.
- [ ] 5.2 Add process-level tests for concurrent starts, duplicate display names, atomic publication, partial writes, and stale-runtime replacement safety.
- [ ] 5.3 Add process-level lease tests for renewal, crash expiry, delayed cleanup, cleanup/renewal races, and idempotent shutdown.
- [ ] 5.4 Add POSIX permission tests and Windows process/ACL coverage for runtime roots and card files.
- [ ] 5.5 Run formatting, typechecking, unit tests, and the cross-platform process-test lane; verify malformed records never hide valid peers.
