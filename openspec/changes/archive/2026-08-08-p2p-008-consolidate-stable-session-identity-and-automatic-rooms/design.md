## Context

Wave 1 already provides the required behavior, but the implementation grew through several parallel foundation changes. The canonical internal identity is currently `sessionId` plus a full UUID `runtimeId`; rooms resolve through explicit project, Git common directory, then canonical cwd; and pure lookup already enforces same-room matching and ambiguity-safe full addresses.

The remaining problem is API shape. `src/identity.ts`, `src/room.ts`, `src/config.ts`, `src/discovery/naming.ts`, and `src/discovery/lookup.ts` expose aliases and overlapping models such as legacy room objects, multiple option names, duplicate name builders, and duplicate lookup result fields. Separately, the Agent Card contract uses the external field name `runtimeInstanceId`; that boundary is owned by the discovery work and must consume, rather than redefine, the internal runtime identity.

The implementation must preserve the existing lifecycle and room behavior. It must not expand into transport, protocol task state, Pi tools, or Agent Card filesystem persistence.

## Goals / Non-Goals

**Goals:**

- Make `sessionId`, `runtimeId`, `roomId`, normalized display name, published network name, and machine-actionable peer address unambiguous internal concepts.
- Keep full canonical UUIDs as the only runtime routing identifiers.
- Keep native Pi naming, explicit overrides, runtime suffixes, automatic room derivation, exact-room isolation, and ambiguity behavior unchanged.
- Remove unused aliases or confine required legacy inputs to explicit compatibility adapters.
- Give later discovery and protocol work a stable address contract without implementing those systems here.
- Add focused tests that prove both preserved behavior and rejected legacy/invalid routing forms.

**Non-Goals:**

- Reimplementing Pi session lifecycle behavior or persisting a replacement session identity.
- Implementing or reconciling the Agent Card filesystem registry and lease defaults.
- Implementing transport, protocol envelopes, task state, routing, messaging tools, or orchestration.
- Changing the room hash algorithm, precedence order, registry root, or runtime lease behavior.
- Making shortened display suffixes unique or machine-actionable.

## Decisions

### Canonical identity and address types

`SessionId` remains Pi's native logical session identifier. `RuntimeId` remains the ephemeral identity generated at each runtime start and is validated as a full canonical lowercase UUID. `RuntimeIdentity` remains the only internal object combining those two values.

`CanonicalPeerAddress` remains the canonical machine address and contains only the validated `runtimeId` and exact `roomId`. The redundant `PeerAddress` type alias is removed from the canonical export surface. Session IDs, display names, and four-character suffixes are never accepted as routing identities.

An external schema may use another property name, such as Agent Card `runtimeInstanceId`, but conversion must happen in a narrow adapter at that schema boundary. No second runtime identity type or shortened-ID adapter is introduced internally.

### Separate display and published names

The normalized human-facing base remains a `NormalizedName`. The suffix-qualified `<base>-<runtime-suffix>` value remains a `PublishedNetworkName` and is the canonical network lookup key. These are distinct values and types; a field must not ambiguously accept either a base name or a full published name.

Pi's native session name supplies the base unless `--p2p-name` is explicitly configured. Rename synchronization changes only the normalized base and derived published name, retaining `sessionId`, `runtimeId`, suffix, room, and endpoint. A discovery adapter may map an external `displayName` plus runtime identity to the published lookup name using the naming module.

Ambiguous name resolution returns the canonical full peer addresses. Any display-only suffix remains a lookup aid and is never used as an endpoint or protocol target.

### Canonical room model

`ResolvedRoom` with `{ roomId, source, value }` is the canonical resolved-room shape. `roomId` is always a versioned opaque hash. The existing precedence and hash inputs remain unchanged:

1. normalized `--p2p-project`;
2. canonical Git common directory;
3. canonical working directory.

The canonical room source vocabulary is `explicit | git | cwd`. Exact-room helpers compare validated opaque IDs and reject cross-room targets before endpoint use. Legacy `{ id }` room objects and legacy source labels, if temporarily required by an existing consumer, are isolated in an adapter rather than accepted by new identity or lookup contracts.

### Compatibility cleanup

First update in-repository consumers and focused tests to canonical names. Remove aliases with no active consumer. For compatibility forms that are still required by the legacy Wave 1 registry or an external schema, keep a one-way adapter at that boundary and mark it as non-canonical; do not add new callers using it.

The Agent Card registry, protocol validation, transport, and Pi lifecycle/tool owners retain their existing ownership boundaries. In particular, missing Agent Card-specific room helpers are not added to `src/room.ts` merely to repair another parallel task's integration.

### Verification strategy

Use the existing unit and lifecycle tests as the regression base, then add focused cases for:

- reload versus new-session identity lifetimes;
- full UUID validation and rejection of shortened routing IDs;
- native rename propagation and explicit override precedence;
- duplicate names, suffix collisions, and full-address ambiguity results;
- explicit projects, Git worktrees, unrelated repositories, cwd fallback, and no default room;
- invalid labels, room IDs, names, and path-controlled values.

Run the targeted foundation tests and typecheck the changed ownership area. Broader typecheck failures from parallel Agent Card work remain reported rather than fixed in this change.

### Alternatives considered

- **Keep every alias indefinitely:** rejected because later modules would continue to choose different vocabularies and duplicate models.
- **Make display names or four-character suffixes routing IDs:** rejected because names are not unique and suffixes are intentionally short.
- **Persist a new extension-owned session ID:** rejected because Pi already supplies the stable logical identity and fork/resume semantics.
- **Use worktree paths or a global default room:** rejected because worktrees would fragment and unrelated directories would mix.
- **Rename external Agent Card fields in this change:** rejected because the Agent Card schema is another task's owned boundary; a narrow adapter is safer.

## Risks / Trade-offs

- **Removing aliases can break unmerged consumers** → Search all in-repository consumers first and retain only explicitly isolated adapters; do not remove behavior that an active canonical path still needs.
- **Changing pure lookup result shapes can affect future tool consumers** → Keep canonical full addresses and provide any transitional mapping only at the consuming boundary, not as new duplicate core fields.
- **Agent Card and naming fields have different display terminology** → Define the adapter from external `displayName`/`runtimeInstanceId` to internal normalized name/runtime address and leave persistence to P2P-010.
- **Existing parallel work may leave the repository-wide typecheck red** → Verify the foundation tests independently and document unrelated failures instead of widening this change.
- **A moved repository changes its automatic room** → Preserve the existing documented behavior and retain `--p2p-project` for an intentionally stable explicit namespace.

## Migration Plan

1. Update the foundation types and pure helpers to use the canonical vocabulary.
2. Update owned consumers and focused tests; remove or isolate aliases only after the consumer search is complete.
3. Add adapter-facing type tests for external runtime field names without changing Agent Card persistence.
4. Run targeted tests, formatting, lint, and typecheck for the changed foundation.
5. If rollback is needed, revert the API cleanup while leaving no new persistent room or identity data to migrate.

## Open Questions

No product questions remain within this ownership boundary. The only deferred integration detail is the concrete Agent Card adapter, which remains owned by the discovery registry work and must map to the canonical `runtimeId`/`roomId` contracts defined here.
