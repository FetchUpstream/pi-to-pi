## Why

Wave 1 established the correct session/runtime identity, naming, and room behavior, but its APIs still expose overlapping terminology and compatibility models. Consolidating those boundaries now prevents later transport, protocol, and discovery work from depending on divergent runtime IDs, room shapes, or name representations while preserving the already-validated behavior.

## What Changes

- Establish one canonical internal vocabulary: `sessionId`, full UUID `runtimeId`, opaque `roomId`, normalized human-facing display name, and machine-actionable peer address.
- Isolate or remove unused identity, room, configuration, naming, and lookup aliases instead of carrying duplicate models into later modules.
- Keep Pi's native session name authoritative unless `--p2p-name` is explicitly supplied; preserve rename propagation without changing identity, room, or endpoint.
- Keep `--p2p-project` as the explicit room selector and hash its normalized value into an opaque room ID.
- Preserve Git common-directory worktree grouping, canonical cwd fallback, and strict same-room isolation.
- Require full canonical UUID runtime IDs at routing and address boundaries; keep shortened runtime-derived suffixes display-only.
- Preserve duplicate display-name support and ambiguity errors containing full machine-actionable runtime addresses.
- Add focused regression coverage for identity lifetime, rename propagation, invalid identifiers, name collisions, worktrees, unrelated repositories, and path safety.

## Capabilities

### New Capabilities

<!-- None. This change consolidates existing foundation contracts. -->

### Modified Capabilities

- `session-runtime-identity`: make the canonical internal runtime identity and peer-address representation explicit, with narrow adapters for external field names.
- `peer-name-normalization`: distinguish the normalized human-facing name from the derived published lookup name and remove duplicate naming models while preserving collision-safe lookup.
- `workspace-room-derivation`: make the opaque `roomId` and canonical room vocabulary authoritative and isolate legacy room shapes without changing derivation precedence or isolation behavior.

## Impact

- Affected foundation APIs: `src/identity.ts`, `src/room.ts`, `src/config.ts`, `src/discovery/naming.ts`, and `src/discovery/lookup.ts`, plus their focused tests and documentation.
- Later Agent Card, transport, protocol/router, and Pi-tool work will consume the canonical contracts but is not implemented here.
- Existing callers using removed aliases may require updates; external Agent Card field names remain adapter concerns owned by the discovery registry work.
