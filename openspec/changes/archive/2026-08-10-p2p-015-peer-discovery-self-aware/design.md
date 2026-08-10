## Context

`PiAdapter.listPeers()` currently maps every live `AgentCardPeerRecord` field into a model-facing object, and `p2p_peers` pretty-prints that object as JSON. The production `AgentCardRegistry` is already the authoritative exact-room discovery boundary, while `MessageRouter.runtimeId` identifies the local runtime and `networkName` is the existing collision-resistant lookup target.

The change is intentionally limited to the adapter/tool presentation layer. Discovery persistence, room filtering, protocol routing, and full Agent Card metadata remain internal contracts.

## Goals / Non-Goals

**Goals:**

- Produce a typed compact view partitioned into `self` and remote `peers`.
- Identify self by exact canonical runtime ID comparison with `router.runtimeId`.
- Present display names, published target names, meaningful state/load, and optional model identity.
- Render a concise text result suitable for model context.
- Retain full runtime IDs when a human-facing name is ambiguous.
- Keep every target emitted for a unique peer valid for the existing `p2p_send` resolver.

**Non-Goals:**

- Changing Agent Card schema, persistence, leases, or registry scanning.
- Changing room derivation, endpoint transport, protocol envelopes, or router task behavior.
- Replacing existing name normalization or ambiguity resolution.
- Adding a verbose/diagnostic tool unless implementation reveals a necessary compatibility seam.

## Decisions

1. **Use the router runtime ID as the self-identity authority.**
   Compare each discovered record's canonical `runtimeId` to `router.runtimeId`. This is safer than comparing display names, published names, endpoint paths, or object identity. The registry remains responsible for obtaining the complete live record set.

2. **Add a compact adapter projection rather than shrinking Agent Cards.**
   Keep full records available to `resolveTarget()` and internal diagnostics. Build a presentation view containing `self`, remote peers, and only routing-relevant fields. This preserves existing discovery and routing contracts while making the model interface context-efficient.

3. **Use published network names as normal targets.**
   Emit each peer's existing `networkName` because it is collision-resistant and already accepted by `resolvePeerTarget()`. Do not expose filesystem endpoint addresses. Full runtime IDs remain a fallback for explicit routing and ambiguity messages.

4. **Render text at the tool boundary.**
   `p2p_peers` should return concise deterministic text, with one self line and one peer line per remote runtime. Omit null/default values, omit queue depth when zero, and include state when useful. This avoids serializing transport/protocol internals and avoids repeated JSON punctuation.

5. **Expose full IDs only for ambiguity.**
   Normal unique peers show no full UUID. When the presentation detects multiple peers sharing a display/lookup base, include full runtime IDs in the relevant lines or an explicit disambiguation section. Existing resolver errors remain authoritative for actual send-time ambiguity.

6. **Preserve adapter compatibility deliberately.**
   Keep target resolution using the raw registry records. If the public `listPeers()` return shape changes, update its adapter tests and any integration consumers together; do not alter the registry's `listPeers()` shape.

## Risks / Trade-offs

- **[Risk] A formatter could accidentally hide information needed to send.** → Always include the published target for every normal peer and test each displayed target through `p2p_send` resolution.
- **[Risk] Self filtering could remove a remote runtime incorrectly.** → Compare validated full runtime IDs only; add tests with identical display names and distinct runtime IDs.
- **[Risk] Ambiguous display names may remain unclear.** → Detect duplicate human-facing names and include full canonical runtime IDs while retaining published targets.
- **[Risk] Existing consumers may depend on the old `listPeers()` JSON shape.** → Scope the breaking presentation change to the model-facing adapter/tool contract, update repository tests, and preserve raw registry records and internal resolution.
- **[Risk] Context-size improvements regress as peer count grows.** → Add a many-peer assertion comparing compact output length against the old Agent Card-shaped projection.
