## Context

The repository now has independent foundation contracts for Pi session/runtime identity, exact room derivation, instance-keyed discovery records, leases, and Pi lifecycle ownership. The protocol, router, task-store, and transport implementation modules remain reserved for later issues. The protocol change therefore needs to define a stable boundary that those modules can implement without choosing a framing protocol or duplicating the foundation contracts.

The existing discovery Agent Card is presence metadata and is validated by its own module. It uses the repository's `runtimeInstanceId` vocabulary and numeric Agent Card version. The wire protocol will use the existing identity and registry `runtimeId` as its routing identity and the string wire version `1.0`; the design must keep those concepts distinct rather than replacing the discovery contract.

## Goals / Non-Goals

**Goals:**

- Define a small, versioned JSON protocol independent of sockets, HTTP, framing, or Pi UI.
- Make operation delivery and task completion separately observable and explicitly correlated.
- Represent concurrent, nested, retried, expired, cancelled, and runtime-scoped work deterministically.
- Define typed text/JSON content and bounded local JSON Schema validation for structured replies.
- Preserve exact room isolation and bind claimed runtime identity to the active transport binding before task lookup or deduplication.
- Give later implementation issues a precise capability, error, limit, and delivery contract.

**Non-Goals:**

- Implementing protocol types, validators, routers, task storage, deduplication, transport, or Pi tools in this change.
- Selecting transport framing or exposing transport endpoints in the protocol model.
- Providing offline delivery, durable task storage, runtime task handoff, streaming, attachments, broadcast, or a scheduler.
- Replacing the discovery Agent Card schema or making the registry a message relay.
- Implementing internet authentication or full A2A interoperability.

## Decisions

### Use three explicit layers

The contract separates:

1. **Protocol data model:** envelopes, payloads, operation responses, content, errors, and task snapshots.
2. **Operation semantics:** admission, reply, notification, status, cancellation, expiry, and deduplication rules.
3. **Binding contract:** authentication, endpoint selection, byte transport, and delivery failures.

A transport carries opaque protocol values and does not reinterpret task semantics. The registry remains discovery-only and never stores message or task bodies.

### Use separate operation and logical request identifiers

Every envelope has a UUIDv4 `operationId`. A task-bearing initial `message.request` sets `requestId` equal to that operation ID. Later `message.reply`, `task.status`, and `task.cancel` operations have new operation IDs and target the original logical `requestId`. `traceId` is stable across the logical exchange and `parentOperationId` represents nesting or causality.

Operation acknowledgements always echo the operation ID and contain exactly one of `result` or `error`. A task terminal outcome is delivered through an explicit `message.reply`; it is never inferred from Pi transcript order, `agent_end`, or the latest assistant message.

### Keep current identity and discovery vocabulary compatible

Wire envelopes use `sender.sessionId`, `sender.runtimeId`, and `recipientRuntimeId`, matching `identity.ts`, `registry.ts`, and peer lookup. The existing discovery card may continue to expose `runtimeInstanceId`; the protocol specification defines it as the card representation of the same runtime identity and requires an adapter to verify the mapping before routing.

`peer.describe` returns the discovery Agent Card plus a separate protocol capability projection containing supported wire versions, operation names, content capabilities, cancellation/notification support, and effective protocol limits. This avoids changing the existing presence-card validator or confusing Agent Card version `1` with wire version `1.0`.

### Define a small operation set

V1 supports `peer.describe`, `message.request`, `message.reply`, `message.notify`, `task.status`, and `task.cancel`. A request receives an admission acknowledgement (`accepted` or `queued`) and may later receive exactly one terminal reply. A notification receives a delivery acknowledgement but creates no task and no logical reply. Status and cancellation are control operations targeting an existing request ID.

### Make task transitions explicit and terminal states immutable

The public state machine is:

```text
created ─▶ accepted ─▶ queued ─▶ working ─▶ completed
   │          │          │          │  ├── failed
   │          │          │          │  ├── rejected
   │          │          │          │  └── expired
   │          │          └──────────┴──▶ cancelling ─▶ cancelled
   └──────────────▶ rejected / expired
```

`created` is sender-local. `cancelling` is nonterminal and only represents a cancellation request against working work. The first atomically committed terminal transition wins; later operations cannot mutate the terminal snapshot. Queued cancellation is immediate, while working cancellation signals only the matching executor and permits completion/failure to win the race.

### Use absolute deadlines and bounded resources

Every operation carries an absolute UTC `expiresAt`; retries never extend it. Normal requests default to ten minutes and cannot exceed one hour. Control operations cannot exceed 30 seconds. Implementations enforce deadlines with monotonic timers after admission. V1 advertises a 1 MiB serialized-envelope limit, a 64 KiB schema limit, and a default queue limit of 32; peers may advertise stricter limits.

### Make structured content explicit and local-only

Content is either `{ type: "text", text }` or `{ type: "json", value }`. An expected structured response requires JSON and a JSON Schema Draft 2020-12 schema. Schemas are validated before admission, bounded by size and evaluation budget, limited to embedded/local references, and never fetched from the network. The recipient and requester both validate a completed reply; invalid content leaves the task nonterminal and returns `invalid_reply`.

### Make retries safe without promising durability

Mutating operations are deduplicated by `(senderRuntimeId, operationId)`. The receiver canonicalizes immutable operation data, excluding binding credentials, and stores the fingerprint plus admission or delivery result before acknowledging execution. Identical retries replay the stored result; conflicting reuse returns `duplicate` without executing or mutating the original operation. `busy` does not reserve an operation. Records are retained through the request deadline plus a ten-minute grace period, but deduplication is runtime-scoped and need not survive runtime replacement.

### Authenticate and isolate before looking up state

The binding supplies authentication context; credentials are not application payload and are not fingerprinted or logged as ordinary content. The receiver verifies the authenticated sender/runtime, intended recipient runtime, and exact room before consulting task or deduplication state. Invalid credentials return `unauthorized`; an exact room mismatch returns `cross_room`; neither response reveals task existence.

A session may survive `/reload`, but every replacement runtime receives a new runtime ID. V1 does not hand active tasks to the replacement or provide offline delivery. A sender that rediscovers a replacement must create a new operation with a new ID rather than replaying an accepted operation against a different runtime.

### Use stable, typed protocol errors

Errors contain a stable code, bounded human-readable message, retryability, and optional safe details. Core codes distinguish malformed/incompatible/expired input, room and authentication failures, ambiguity, capacity, size, duplicate, cancellation, reachability, lookup, schema, and internal failures. `rejected` is a task outcome, not an error code. `busy` and `unreachable` are retryable while the deadline permits; permanent validation and authorization failures are not retried unchanged.

## Risks / Trade-offs

- **[A protocol-only contract can drift from later code]** → Make issue #12 derive discriminated unions, validators, task transitions, and error values directly from the normative spec, then add conformance fixtures before transport integration.
- **[The existing Agent Card and wire protocol use different version and identity spellings]** → Keep the discovery card unchanged in this issue, define the `runtimeInstanceId`/`runtimeId` mapping and the separate protocol capability projection explicitly, and require integration tests at the boundary.
- **[Binding authentication is transport-specific]** → Specify the required authenticated identity context and check ordering without embedding a token format in the transport-independent envelope.
- **[Same-user capability credentials do not defend against malicious same-user code]** → Treat them as stale-peer and accidental-routing protection; defer stronger authorization to a future binding.
- **[Clock skew can cause premature expiry]** → Use UTC wire timestamps, reject unreasonable deadlines, and use monotonic timers after admission in the expected same-host deployment.
- **[JSON Schema implementations may disagree]** → Pin Draft 2020-12, prohibit remote references, bound evaluation, keep `format` annotation-only by default, and validate replies on both sides.
- **[Runtime loss can strand accepted work]** → Document no offline delivery or handoff and report lost delivery as `unreachable` rather than inventing a terminal outcome.
- **[A large protocol envelope or queue can exhaust a runtime]** → Enforce limits before admission, advertise effective limits through `peer.describe`, and keep terminal retention bounded.

## Migration Plan

1. Add the new OpenSpec capability delta with the envelope, operation, lifecycle, content, compatibility, security, delivery, and error requirements.
2. Review the contract against the current identity, room, registry, lease, lifecycle, and local-IPC specifications without modifying those modules.
3. Sync the capability into `openspec/specs/pi-to-pi-v1-protocol/spec.md` when the change is accepted or archived.
4. Implement the contract in the follow-up protocol-engine issue behind the existing module boundaries, using fake bindings for conformance tests and the [implementation map](../../../docs/protocol-engine-implementation-map.md) as the handoff.
5. Implement Pi lifecycle/tools and concrete transport integration only in their dependent issues.
6. Rollback is documentation-level for this change; no runtime code, dependency, or persistence migration is introduced.

## Open Questions

The v1 wire contract has no blocking architectural questions. The following implementation choices are intentionally deferred:

- the concrete local capability-token mechanism to the transport/integration work;
- the JSON Schema evaluator dependency and exact evaluation-budget implementation to the protocol-engine work;
- prompt rendering, custom-message delivery mode, persistence details, and UI presentation to the Pi adapter work;
- streaming, attachments, offline delivery, runtime handoff, and richer authorization to future protocol versions.

## Verification

- `openspec validate "define-pi-to-pi-v1-protocol" --type change --json` passed with 1/1 change valid.
- `openspec validate --all --strict --json` passed with 13/13 repository changes/specifications valid; only informational long-requirement notices remain.
