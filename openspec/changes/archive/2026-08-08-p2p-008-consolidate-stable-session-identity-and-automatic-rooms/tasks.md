## 1. Establish canonical identity contracts

- [x] 1.1 Inventory all in-repository consumers of identity, room, naming, and lookup exports; classify each alias as removable, canonical, or an isolated compatibility adapter.
- [x] 1.2 Consolidate `SessionId`, full UUID `RuntimeId`, `RuntimeIdentity`, and `CanonicalPeerAddress` so internal routing uses only `runtimeId` and `roomId`; add narrow external-field adapters without introducing a second runtime identity type.
- [x] 1.3 Update owned imports and focused tests to the canonical identity/address exports, removing unused identity aliases while preserving runtime lifecycle behavior.

## 2. Consolidate room derivation and isolation

- [x] 2.1 Make `ResolvedRoom` and opaque `RoomId` the canonical room model with `explicit | git | cwd` sources; preserve explicit-project, Git common-directory, and cwd precedence and hashing unchanged.
- [x] 2.2 Isolate or remove legacy room source names, `{ id }` room shapes, duplicate option names, and redundant room helper aliases without adding Agent Card-specific helpers to `src/room.ts`.
- [x] 2.3 Update owned room consumers and tests to pass canonical `roomId` values and verify no default room, raw user-controlled path component, or cross-room fallback is introduced.

## 3. Normalize names and peer resolution

- [x] 3.1 Separate normalized human-facing `NormalizedName` values from suffix-qualified `PublishedNetworkName` values and keep native Pi naming primary unless `--p2p-name` is explicitly set.
- [x] 3.2 Preserve rename propagation, runtime-derived suffix generation, and full-UUID routing while removing duplicate naming builders, synchronizers, and configuration aliases that have no active consumer.
- [x] 3.3 Simplify pure lookup contracts around canonical full peer addresses, exact-room filtering, and one unambiguous ambiguity result containing all candidate addresses.
- [x] 3.4 Keep compatibility mappings for legacy/external field names at explicit boundaries only; do not modify transport, protocol task state, Pi tools, or Agent Card persistence.

## 4. Add focused regression coverage

- [x] 4.1 Cover reload/new-session/resume/fork identity lifetimes, repeated shutdown ownership, full UUID validation, and rejection of shortened runtime routing values.
- [x] 4.2 Cover native rename propagation, explicit name override precedence, normalized display/published name separation, duplicate names, suffix collisions, and full-address ambiguity errors.
- [x] 4.3 Cover explicit project precedence, normalized opaque room IDs, Git worktree grouping, unrelated repositories, cwd fallback, equivalent paths, invalid labels, and strict cross-room isolation.
- [x] 4.4 Cover path safety so raw names, project labels, directory strings, and legacy room values cannot become registry path components.

## 5. Verify and document the foundation

- [x] 5.1 Update foundation documentation and API comments to state the canonical vocabulary, display-only suffix rule, room precedence, and adapter boundary.
- [x] 5.2 Run the targeted identity, room, naming, lookup, and lifecycle tests and resolve failures caused by this change.
- [x] 5.3 Run formatting, lint, and typecheck/build checks for the changed foundation; report unrelated parallel Agent Card failures without fixing out-of-scope modules.
