# Protocol-engine implementation map

The authoritative contract for this work is [`openspec/specs/pi-to-pi-v1-protocol/spec.md`](../openspec/specs/pi-to-pi-v1-protocol/spec.md). This map is a handoff for the protocol-engine implementation issue; it does not implement source code in the specification issue.

## Scope and request flow

The engine owns transport-independent protocol values and task semantics:

```text
binding authentication
        |
        v
router boundary -> protocol validation -> deduplication -> task store -> queue/executor
        ^                                                        |
        +---------------- correlated operation response --------+
```

The router must authenticate the binding and validate the claimed sender, recipient runtime, and exact room before consulting task or deduplication state. Admission and delivery acknowledgements are separate from terminal task replies.

## Module map

| Boundary                     | Responsibility                                                                                                                                                                  | Must not own                                                                  |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `src/protocol/messages.ts`   | Version `1.0`, operation/envelope unions, request/reply/notification payloads, operation responses, IDs, typed content, and capability projections.                             | Socket framing, Pi events, or UI rendering.                                   |
| `src/protocol/validation.ts` | Envelope and payload validation, UUIDv4/timestamp/trace checks, version and limit checks, local-only Draft 2020-12 schema validation, and deterministic canonical fingerprints. | Binding credentials or network access for schema references.                  |
| `src/protocol/task-state.ts` | Legal transitions, terminal immutability, cancellation state, snapshots, absolute expiry, and first-terminal-transition-wins behavior.                                          | Model execution and transport retries.                                        |
| `src/protocol/errors.ts`     | Stable error codes, bounded messages/details, retryability, and retry-delay metadata.                                                                                           | Transport-specific exception types.                                           |
| `src/protocol/agent-card.ts` | Protocol capability and effective-limit projections alongside the existing discovery Agent Card.                                                                                | Replacing the numeric Agent Card version or storing task bodies in discovery. |
| `src/router/task-store.ts`   | Runtime-local request ownership, queue-visible task records, atomic transitions, expiry scheduling, scoped cancellation signals, and bounded terminal retention.                | Cross-runtime handoff or durable offline storage.                             |
| `src/router/dedupe.ts`       | Runtime-scoped `(senderRuntimeId, operationId)` records, canonical fingerprint comparison, cached acknowledgements/delivery results, and deadline-plus-grace retention.         | Binding credentials in fingerprints or reserving transient `busy` responses.  |
| `src/router/policy.ts`       | Effective envelope/schema/queue limits, admission capacity, and retryable `busy` decisions.                                                                                     | Unbounded buffering or task-state transitions.                                |
| `src/router/router.ts`       | Operation dispatch and ordering: authenticate, target/room checks, validate, expire/limit-check, deduplicate, admit/queue, dispatch, correlate replies, and return responses.   | Transport framing, Pi transcript inference, or a global current request.      |

## Conformance test seams

The engine should accept a fake binding/transport that supplies authenticated identity context and carries opaque envelopes and operation responses. Conformance tests should exercise concurrent and nested requests, retries, every legal task transition, terminal races, schema failures, queue exhaustion, room/auth rejection, runtime replacement, and the complete stable error taxonomy without opening a socket or starting Pi.

## Explicit dependent boundaries

- `src/transport/transport.ts` and concrete local IPC work own endpoint delivery, framing, byte/deadline behavior, binding credentials, and unreachable transport failures. They must not reinterpret task semantics or duplicate protocol types.
- `src/pi/lifecycle.ts`, `src/pi/messages.ts`, `src/pi/tools.ts`, persistence, and UI work own Pi session lifecycle, model-facing APIs, custom-message rendering, prompt guidance, and scoped executor integration. They must use the engine's request IDs and task transitions rather than infer replies from `agent_end`, transcript order, or the latest assistant message.
- End-to-end and concrete transport wiring belong to the dependent integration issues. Those issues compose the engine, binding, discovery, and Pi adapter; they do not redefine the v1 envelope, state machine, error codes, or room/authentication contract.

The v1 engine intentionally provides no streaming, attachments, broker, durable offline delivery, or runtime task handoff.
