## Context

The package has production implementations for local IPC, Agent Card discovery, routing, and Pi adaptation, but `src/pi/lifecycle.ts` still owns the deprecated `RuntimeRegistry` and `src/index.ts` only registers tools for an injected adapter. No code translates protocol envelopes to transport bytes or correlates IPC responses back to the originating router. P2P-013 integrates these existing layers without changing the v1 protocol or rebuilding their semantics.

## Goals / Non-Goals

**Goals:**

- Give every started Pi runtime exactly one bound endpoint, Agent Card registry, router, adapter, and immutable generation.
- Publish discovery only after inbound IPC can authenticate and route requests.
- Make the default extension usable without caller-created runtime components.
- Preserve explicit replies, asynchronous follow-ups, protocol ownership, and bounded local IPC behavior.
- Make replacement/shutdown idempotent and unable to affect a newer runtime.

**Non-Goals:**

- Remote networking, TCP, TLS, credentials/secrets in Agent Cards, a broker/daemon, streaming, persistence of live tasks, `p2p_await`, or new orchestration behavior.

## Decisions

### Use a runtime composition owner behind a stable tool dispatcher

Introduce a runtime-scoped owner (for example `PiToPiRuntimeComposition`) created only from `session_start`. It owns identity, resolved room/name, a generated local endpoint, `LocalIpcTransport`, `AgentCardRegistry`, `MessageRouter`, `PiAdapter`, and a generation token. The default export registers the tools once against a dispatcher that resolves the active composition at execution time.

A fresh router and adapter are created for every generation rather than rebinding one mutable adapter. This makes router task ownership runtime-local and lets every callback capture its originating generation. Injected construction seams may remain for focused tests, but normal startup follows this composition path.

### Bind first, then publish

Startup follows:

```text
identity + room → generated endpoint → bind IPC handler → construct router/adapter
                                                ↓
                                      start Agent Card lease
```

The handler may use narrow deferred references while the router and adapter are assembled, but the registry cannot start until the transport bind succeeds. Endpoint generation uses `createIpcEndpoint`; `unbound:<runtimeId>` is removed from the active path.

### Add a small JSON codec above opaque IPC

A dedicated codec serializes `ProtocolEnvelope` and `OperationResponse` as UTF-8 JSON and validates decoded values using existing protocol validation. Encoded values are limited to the effective minimum of router envelope limits and `LocalIpcTransport.maxPayloadBytes`; framing remains solely transport-owned. Codec or transport failures map to bounded protocol errors and never let an inbound handler crash the server.

### Bridge router delivery through live Agent Cards

The concrete `OutboundDelivery` resolves `recipientRuntimeId` through the local exact-room `AgentCardRegistry`, rejects absent/ambiguous/stale/incompatible targets, requests the card endpoint through local IPC, decodes the returned `OperationResponse`, and calls its own router's `processResponse` before returning delivery success. The inbound handler decodes bytes, validates a same-room live sender card and endpoint/runtime/session identity into `AuthenticatedBindingContext`, calls `processInbound`, and returns the encoded synchronous operation response. Logical terminal replies still use separate `message.reply` operations.

### Project live state into the one canonical Agent Card

The composition derives capabilities and limits from the router/transport intersection, rather than advertising the registry default 16 MiB maximum. Lifecycle events update the same registry card: busy/idle state, name, model, context usage, and queue depth. `peer.describe` projects that canonical card; no second router card is published.

### Fence and close by exact generation

Every callback handed to Pi captures the composition's generation and verifies it remains active before delivery. Shutdown first removes availability/marks draining, fences adapter delivery, closes the router (failing pending waiters), stops/removes the exact card, closes the owned transport endpoint, and releases identity. Each owner resource is instance-local and idempotent, so old cleanup cannot remove a replacement card or endpoint.

## Risks / Trade-offs

- [Deferred assembly can expose an unready router] → bind before registry publication and make the handler return bounded errors until assembly completes.
- [Card lookup races with peer exit/reload] → target exact runtime IDs, use the card endpoint only for that request, and map connection/decode failures to `unreachable`.
- [JSON limits differ from transport limits] → compute and use one effective minimum for codec, router capability projection, and Agent Card metadata.
- [Pi lifecycle callbacks overlap replacement] → use a fresh composition plus generation checks rather than mutable global request state.
- [Integration fixtures become bespoke alternate implementations] → compose the production transport, registry, router, and adapter in existing Pi/process test fixtures.

## Migration Plan

1. Add the codec and composition owner with focused tests.
2. Move lifecycle/default-export wiring to the owner and retain legacy registry exports only for compatibility tests.
3. Add production end-to-end tests and run the existing cross-platform suite.
4. Roll back by reverting the composition change; registry files and endpoints are runtime-scoped and lease/owned-endpoint cleanup remains safe.

## Open Questions

- None blocking: model and context access will be projected when the Pi event/context supplies them and represented as `null` when unavailable.
