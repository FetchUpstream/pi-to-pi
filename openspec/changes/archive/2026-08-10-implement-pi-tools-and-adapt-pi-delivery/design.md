## Context

The repository now exposes production `MessageRouter`, `TaskExecutor`, and `AgentCardRegistry` contracts, while the Pi-facing modules remain placeholders. The existing lifecycle seam still owns a deprecated `RuntimeRegistry` and an unbound endpoint; P2P-013 owns replacing that wiring and binding concrete local IPC transport. This change must therefore make Pi tools and delivery independently composable with the production router and discovery boundaries without opening sockets, framing bytes, or publishing another discovery record.

## Goals / Non-Goals

**Goals:**

- Provide four communication-only Pi tools backed by live production router/discovery contracts.
- Make exact `requestId` correlation survive concurrent inbound/outbound work within one runtime.
- Deliver inbound work and outbound terminal results through Pi native custom-message modes.
- Keep router tasks runtime-local while permitting body-free Pi audit/UI metadata.
- Expose a clean adapter seam P2P-013 can compose with concrete delivery and lifecycle wiring.

**Non-Goals:**

- Concrete router-to-transport serialization, endpoint binding, authentication, or Agent Card lifecycle migration.
- A second transport, discovery model, task state machine, polling wait-for-idle loop, or active task recovery format.
- `p2p_await`, orchestration semantics, peer-pool UI, streaming responses, or automatic replies inferred from assistant text.

## Decisions

### Runtime-scoped adapter owns Pi-facing coordination

Introduce a Pi adapter constructed with a production `MessageRouter`, an `AgentCardRegistry`, and a session-bound Pi delivery facade. It registers tool definitions once and binds the active runtime/session only after `session_start`; shutdown drops the binding, closes its router ownership when applicable, and clears deduplication bookkeeping.

This separates durable extension registration from session resources and lets P2P-013 supply concrete transport/discovery runtime construction. Extending the current lifecycle into a second endpoint/transport path was rejected because P2P-013 explicitly owns that convergence.

### Router APIs remain the exclusive task authority

`p2p_send` resolves peers through `AgentCardRegistry`, then calls `MessageRouter.createRequest`; it awaits `handle.admission` but never `handle.completion`. It attaches the completion callback solely to inject one terminal result. `p2p_reply` first checks `taskSnapshot` for an active inbound task, then calls `completeTask`, `failTask`, or `rejectTask`; it never constructs a protocol reply envelope. `p2p_status` reads `taskSnapshot` rather than transcript or persisted entries.

This preserves router validation, ownership checks, task transitions, and response correlation. A Pi-local task map was rejected because it would duplicate authoritative router state and risk cross-wiring.

### Discovery retains full identities and ambiguity

Peer listing uses `AgentCardRegistry.listPeers()` for valid live records in the exact room. Target resolution uses its name/runtime lookup methods and only routes a `found` full runtime identity. Ambiguous lookup results are returned as all full candidates, never selected by display name.

Direct use of the legacy `RuntimeRegistry` was rejected because Agent Cards are the production discovery authority.

### Pi custom messages use native queue semantics

The adapter implements `TaskExecutor`. Before injecting inbound work it checks the task signal; cancelled work is suppressed. Idle delivery uses a triggered custom message; busy inbound delivery uses `steer`. The executor returns `void`, so the router leaves the task working until a later explicit reply. Terminal outbound completion is injected exactly once with `followUp`, including request ID, peer, and completed content or terminal error.

This uses Pi's ordering semantics rather than private idle polling. Returning content from the executor was rejected because the router would terminalize the task automatically.

### Persisted metadata is audit-only

Custom message details and optional custom entries may contain body-free request ID, direction, peer runtime, state, and timestamps. They are renderer/UI history only: a fresh router is never repopulated from them after reload, resume, fork, or clone.

This deliberately supersedes the older fixture-only recovery concept, which predates the production router's runtime-local task boundary.

## Risks / Trade-offs

- [P2P-013 runtime wiring is not yet available] → Keep construction injectable and test it with production router/discovery objects plus Pi/transport fakes.
- [A terminal completion can be observed more than once] → Maintain adapter-local terminal request-ID bookkeeping and test duplicate state notifications/completion handling.
- [Pi session replacement can leave stale contexts] → Bind deliveries to the active runtime/session identity and clear the binding during shutdown.
- [Structured reply errors could appear terminal to the model] → Return a normal tool error while retaining the router task; only successful router transition is terminal.
- [Message injection carries model-visible content] → Keep audit records body-free and include only the request/reply body required for the actionable custom message.

## Migration Plan

1. Add the injectable adapter, tool, message, persistence, and rendering surfaces without changing concrete transport or legacy lifecycle publication.
2. Register the adapter tools and lifecycle event delegation while preserving existing flags and lifecycle behavior.
3. Add focused tests against production contracts and Pi boundary fakes.
4. P2P-013 supplies concrete Local IPC delivery, Agent Card lifecycle ownership, endpoint publication, and binding authentication through the adapter seam.

Rollback consists of removing the adapter registration; existing lifecycle/discovery compatibility behavior remains unchanged.

## Open Questions

- Whether v1 exposes notification mode in `p2p_send` now or reserves it until concrete delivery is wired; the adapter will route it through `MessageRouter.notify` if exposed.
- Which body-free audit fields, if any, merit a stable persisted-entry schema rather than renderer-only details.
