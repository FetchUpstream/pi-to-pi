## Context

P2P-002 merged `openspec/specs/pi-to-pi-v1-protocol/spec.md` as the authoritative transport-independent contract. The current `src/protocol/messages.ts`, `errors.ts`, `task-state.ts`, and `src/router/*` files are intentional stubs. The existing `src/protocol/validation.ts` validates discovery Agent Cards and must remain a separate concern from wire-protocol validation.

This change sits between the authenticated transport binding and the future Pi adapter:

```text
binding context
      │
      ▼
router → wire validation → dedupe → task store → queue/executor
      ▲                                      │
      └──────── correlated operation response ┘
```

P2P-009 owns concrete IPC and binding credentials, P2P-010 owns Agent Card persistence and leases, P2P-008 owns canonical identity and room derivation, and P2P-012 owns Pi lifecycle/tools/message delivery. The engine must therefore expose seams that those components can adapt to without importing their implementation details.

## Goals / Non-Goals

**Goals:**

- Implement the v1 envelope and operation unions with explicit operation/request correlation.
- Provide deterministic wire validation, stable errors, effective limits, and protocol capability projection.
- Enforce the specified task state machine, terminal immutability, cancellation behavior, absolute expiry, monotonic post-admission deadlines, and bounded retention.
- Make retries safe through runtime-scoped canonical deduplication registered before acknowledgement.
- Enforce authentication, recipient, room, and reply-owner checks before task or deduplication disclosure.
- Support concurrent, nested, out-of-order, and schema-validated operations through keyed state rather than a global current request.
- Keep conformance tests independent of sockets, filesystem discovery, and Pi execution.

**Non-Goals:**

- Implementing socket framing, local IPC endpoints, binding-token generation, or transport reachability probing.
- Implementing Agent Card persistence, lease renewal, identity/room derivation, peer-name lookup, or filesystem registry behavior.
- Registering Pi tools, injecting custom messages, rendering UI, or persisting Pi transcript metadata.
- Providing offline delivery, durable task handoff, cross-runtime deduplication, streaming, attachments, broadcast, or orchestration semantics.
- Changing the normative v1 protocol specification or the discovery Agent Card schema.

## Decisions

### Keep protocol values independent from transport and Pi

`messages.ts` will contain readonly discriminated unions and value types for envelopes, payloads, content, operation responses, task snapshots, and protocol capabilities. Router entry points will accept an authenticated binding context and an opaque serialized or decoded operation through an interface; they will not import socket, Pi event, or transcript types.

**Alternative considered:** Put framing and Pi delivery callbacks directly into protocol messages. This would make conformance tests require concrete infrastructure and would duplicate ownership from P2P-009 and P2P-012.

### Separate discovery-card validation from wire validation

The existing Agent Card validators remain responsible only for discovery metadata. Wire validators will use protocol-specific result types and functions, with a distinct module or clearly isolated protocol section, and will validate `runtimeId` at the canonical identity boundary. The numeric Agent Card version will never be treated as wire version `"1.0"`.

**Alternative considered:** Reuse `validateAgentCard()` for envelopes because both contain identity and room fields. That would couple unrelated error models and permit discovery-specific timestamp and size rules to leak onto the wire contract.

### Use a layered router pipeline with stateful subsystems

The router will perform operations in this order:

1. Check the active binding and claimed sender, recipient, and exact room.
2. Enforce serialized envelope size before expensive decoding/validation.
3. Validate version, operation shape, IDs, timestamps, content, schema, expiry, and effective limits.
4. Check an existing dedupe record for operations that are deduplicated.
5. Check queue capacity; a temporary `busy` result does not reserve dedupe state.
6. Atomically reserve the operation result and create/admit task state before acknowledging execution.
7. Dispatch admitted work through an injected executor and return the correlated operation response.

Reply handling will authenticate first, then compare the claimed sender with the stored expected target and the local request owner before returning any existence or state information. Status and cancellation use the same authorization ordering.

**Alternative considered:** Dispatch first and record acknowledgement afterward. A fast retry could then execute twice before the first result is visible, violating the retry guarantee.

### Use a keyed runtime-local task store

Tasks will be indexed by logical `requestId`, with explicit requester, local owner, expected target runtime, room, operation metadata, deadline, expected response contract, cancellation state, and terminal snapshot. Inbound and outbound ownership will be represented as fields on a task record rather than separate global variables. State transitions will be centralized in a transition table and will commit terminal outcomes atomically within the runtime.

The store will expose scoped cancellation signals to an executor and snapshots for authorized status/reply processing. Terminal snapshots will be immutable. Runtime replacement starts with a fresh store; no handoff or durable offline recovery is introduced.

**Alternative considered:** Reuse the fixture-only persisted `p2p.task` metadata model or a single `currentInbound` slot. The fixture vocabulary has different lifecycle semantics, and a single slot cannot represent concurrent or nested requests.

### Enforce wire deadlines with wall-clock admission and monotonic timers

RFC 3339 `createdAt` and `expiresAt` remain the wire truth. At admission, the engine will calculate remaining duration from an injected wall clock and schedule post-admission expiry using an injected monotonic clock/timer. Control-operation and normal-request maximums will be applied without allowing retries to extend the original deadline.

**Alternative considered:** Use `Date.now()` for every later transition. Wall-clock adjustments could extend or prematurely expire admitted work and make cancellation/expiry races nondeterministic.

### Use explicit runtime JSON Schema Draft 2020-12 validation

The package will add Ajv 8 as an explicit runtime dependency and use its Draft 2020-12 API. The engine will not supply `loadSchema`, will reject non-fragment `$ref` values unless a deliberately bounded local resolver is added, and will disable format assertions so `format` remains annotation-only. Schema byte size will be checked before compilation; compiled validators will be bounded by the request/schema limits and kept local to the task contract.

**Alternatives considered:**

- The existing Ajv 6 nested under ESLint: it is a development-only transitive dependency and does not provide the required Draft 2020-12 contract.
- Manual `JSON.parse()` or ad-hoc shape checks: these do not implement JSON Schema semantics and would diverge between sender and receiver.
- A network-backed schema resolver: it violates the local-only and bounded-runtime requirements.

### Fingerprint immutable operation data, never binding credentials

The dedupe layer will key records by `(senderRuntimeId, operationId)`. It will recursively canonicalize JSON object keys while preserving array order and encode the immutable operation, IDs, sender/recipient identity, room, timestamps, trace/parent fields, and payload. A bounded SHA-256 digest of that canonical representation will be stored with the cached acknowledgement or delivery result. Binding credentials remain in the separate authentication context and are neither fingerprinted nor logged as ordinary content.

**Alternative considered:** Fingerprint only the payload or include the capability token. Payload-only fingerprints permit destination/identity changes under one operation ID; credential inclusion makes retries unstable and leaks binding material.

### Make capabilities and errors policy-derived

The protocol capability projection will be built from the engine's supported operation/version/content set and effective policy limits, then returned alongside (not inside) the discovery Agent Card. Error construction will use a closed v1 code union with bounded messages/details and a centralized retryability policy. `busy` and transport-reported `unreachable` remain retryable while their deadlines permit; validation, authorization, expiry, conflicting duplicate, and invalid-reply errors are not retried unchanged.

**Alternative considered:** Derive protocol capabilities from the Agent Card numeric version or expose raw implementation exceptions. That would conflate discovery and wire contracts and make error handling unstable for callers.

### Test through injected clocks, bindings, stores, and executors

Focused tests will use in-memory fakes for binding authentication, transport delivery, task execution/cancellation, and wall/monotonic clocks. Spy stores will verify that unauthorized and cross-room operations cannot consult task or dedupe state. Conformance tests will cover the issue's acceptance scenarios without starting sockets or Pi.

**Alternative considered:** Wait for the concrete transport and Pi adapter before testing the engine. That would delay detection of state and authorization races and would blur ownership between parallel issues.

## Risks / Trade-offs

- **[Protocol validation may accidentally share Agent Card assumptions]** → Keep distinct validator types, error codes, entry points, and tests; never use discovery card validation as wire validation.
- **[Schema compilation or recursive references can consume unbounded resources]** → Enforce byte limits before compilation, allow only bounded local references, disable network loading, and use the selected validator's bounded evaluation controls where available.
- **[A dedupe record can become inconsistent with task admission]** → Reserve dedupe and task admission in one synchronous router critical section; never cache transient `busy`; cache only the acknowledgement/delivery result that was actually committed.
- **[Expiry and cancellation can race with executor completion]** → Centralize terminal transitions, use monotonic timers after admission, and make the first committed terminal transition authoritative.
- **[Authorization failures can leak task existence]** → Authenticate and validate target/room before all task and dedupe lookups; use generic unauthorized/cross-room responses before `not_found`.
- **[Parallel transport, discovery, and Pi work may choose incompatible types]** → Keep binding, executor, and transport interfaces narrow; use the canonical `runtimeId` internally and explicit boundary adapters for Agent Card `runtimeInstanceId`.
- **[In-memory runtime state is lost on replacement]** → Treat this as an intentional v1 boundary; callers receive `unreachable` or create a new operation after rediscovery rather than replaying an accepted ID against a replacement runtime.
- **[Large terminal/dedupe maps can retain sensitive content]** → Bound queue and retention, avoid body logging, and retain only the task metadata and terminal content required by the protocol contract.

## Migration Plan

1. Add the explicit runtime schema-validator dependency and implement the protocol/router modules behind their existing reserved paths.
2. Add engine conformance tests and run them without changing transport, discovery, identity, or Pi integration.
3. Expose the stable engine interfaces for P2P-009 and P2P-012 to consume through fakes first.
4. The later integration issue will wire concrete transport and Pi adapters; no Agent Card or task-storage migration is required here.
5. Rollback is a code/dependency rollback before downstream integration. Runtime state is in-memory and is intentionally not migrated across runtime replacement.

## Open Questions

- The exact exported names for the binding, transport, executor, and clock interfaces should be reconciled with the parallel P2P-009 and P2P-012 adapters without changing the semantics above.
- The protocol capability projection may live beside `agent-card.ts` or in a dedicated protocol-capabilities module; either location must preserve discovery ownership and the numeric/version distinction.
- The precise in-memory queue implementation and timer scheduler are implementation details as long as capacity, cancellation scope, monotonic expiry, and bounded cleanup remain observable through the conformance tests.
