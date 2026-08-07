## 1. Identity and configuration foundations

- [ ] 1.1 Define typed session identity, runtime identity, normalized name, project, room, and canonical peer-address models in `src/identity.ts`, `src/config.ts`, and `src/room.ts`.
- [ ] 1.2 Resolve `--p2p-name` and `--p2p-project` through Pi's namespaced flag API, including explicit-value precedence and validation errors.
- [ ] 1.3 Read Pi's native session UUID at `session_start` and generate a fresh runtime UUID per started extension runtime without allocating session resources during module evaluation.

## 2. Peer naming and address resolution

- [ ] 2.1 Implement and unit-test the NFKC, lowercase, Unicode letter/number preservation, punctuation-to-hyphen, control-character rejection, length-limit, and fallback-name rules.
- [ ] 2.2 Implement and unit-test the four-character lowercase Crockford-base32 suffix derived from the runtime UUID and the `<base>-<suffix>` network-name format.
- [ ] 2.3 Implement collision-safe name lookup that restricts candidates to the current room, returns all full runtime addresses for ambiguity, and never silently renames or selects a peer.
- [ ] 2.4 Wire `session_info_changed` so native Pi name changes update the published name only when `--p2p-name` is not configured, without changing identity or endpoint fields.

## 3. Room derivation and isolation

- [ ] 3.1 Implement explicit project-label normalization and deterministic versioned room hashing with source discrimination and filesystem-safe ID validation.
- [ ] 3.2 Implement canonical Git common-directory discovery using an argument-safe Git invocation and realpath canonicalization.
- [ ] 3.3 Implement canonical working-directory fallback for non-Git or unavailable-Git environments and verify equivalent path spellings converge.
- [ ] 3.4 Enforce exact room equality during discovery and target validation, with no implicit cross-room fallback.

## 4. Runtime registry and lease behavior

- [ ] 4.1 Define and validate runtime-keyed registry records containing runtime ID, session ID, room ID, network name, endpoint, and lease expiry.
- [ ] 4.2 Implement atomic temporary-file publication and exact-runtime cleanup with restrictive registry path validation and permissions.
- [ ] 4.3 Implement periodic lease renewal and expiry filtering using the agreed renewal and expiry bounds.
- [ ] 4.4 Implement idempotent `session_shutdown` cleanup and safe stale-record handling for expired records, definitive endpoint failures, timeouts, malformed records, and replacement runtimes.

## 5. Verification and documentation

- [ ] 5.1 Add unit tests covering session/runtime lifetimes, name normalization, suffix determinism, duplicate resolution, project precedence, room hashing, Git worktrees, and working-directory fallback.
- [ ] 5.2 Add lifecycle tests covering reload, resume, new-session, fork, session-name changes, repeated shutdown, and process-level runtime replacement.
- [ ] 5.3 Add multi-process tests covering same-room discovery, different-room isolation, concurrent starts, stale lease expiry, replacement cleanup, and malformed registry entries.
- [ ] 5.4 Document the `--p2p-name` and `--p2p-project` contracts, network-name format, full runtime addressing, automatic room behavior, and stale-peer behavior.
- [ ] 5.5 Run formatting, linting, type checking, unit tests, build, and the configured process/integration test suites.
