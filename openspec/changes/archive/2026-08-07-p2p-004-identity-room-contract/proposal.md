## Why

Pi-to-Pi currently has no contract for distinguishing a logical Pi conversation from the concrete extension runtime that owns a local endpoint. It also lacks a safe workspace boundary and normalized peer addressing, which could allow stale runtimes, duplicate names, or unrelated repositories to be confused with one another.

This change establishes the identity and room rules needed before discovery, registry, and transport implementation can safely proceed.

## What Changes

- Define stable session identity using Pi's native session ID, with explicit lifetime rules for reload, resume, new-session, and fork flows.
- Define an ephemeral runtime ID and lease ownership model for every started P2P runtime.
- Define namespaced `--p2p-name` and `--p2p-project` options.
- Normalize network names to lowercase canonical labels and append a four-character runtime-derived hash suffix.
- Keep the full runtime ID as the canonical machine-actionable peer address.
- Define safe ambiguity behavior for normalized-name collisions.
- Define explicit project room precedence over automatic Git-common-directory and working-directory derivation.
- Define opaque, versioned, filesystem-safe room IDs and input validation.
- Define lease expiry and stale-record cleanup behavior.

## Capabilities

### New Capabilities

- `session-runtime-identity`: Stable logical session IDs, ephemeral runtime IDs, lifecycle transitions, and canonical peer addresses.
- `peer-name-normalization`: Namespaced peer naming, lowercase normalization, runtime hash suffixes, and collision handling.
- `workspace-room-derivation`: Explicit project rooms, Git worktree grouping, working-directory fallback, and safe room identifiers.
- `runtime-lease-cleanup`: Registry lease renewal, shutdown cleanup, stale-record expiry, and safe record ownership.

### Modified Capabilities

<!-- No existing OpenSpec capabilities are present. -->

## Impact

- Fills the contracts currently reserved by `src/identity.ts`, `src/room.ts`, and `src/config.ts`.
- Defines interfaces consumed by future Agent Card, registry, discovery, transport, and Pi lifecycle work.
- Adds deterministic unit-test requirements for normalization, hashing, lifecycle identity, room derivation, and stale-record handling.
- Uses only Pi's existing session lifecycle/name APIs and Node platform primitives; no broker, daemon, database, or external runtime dependency is introduced.
