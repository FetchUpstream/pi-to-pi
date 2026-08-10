## Why

The production identity, discovery, IPC, protocol router, and Pi adapter components are implemented independently, but the default extension still uses the deprecated registry, publishes an unbound endpoint, and exposes no tools without caller-supplied wiring. The package therefore cannot yet provide end-to-end Pi-to-Pi communication through its normal installed entry point.

## What Changes

- Add a runtime-scoped production composition owner that creates, binds, publishes, and shuts down one transport, Agent Card registry, router, and Pi adapter per Pi runtime.
- Self-wire the default extension and register the four communication tools through a stable runtime-aware dispatcher rather than requiring an injected adapter.
- Add the bounded JSON wire codec and concrete router-to-local-IPC outbound/inbound bridge, including live Agent Card endpoint resolution and binding authentication.
- Publish Agent Card metadata and effective limits from the active runtime only after its endpoint and handler are ready.
- Replace the active lifecycle's deprecated `RuntimeRegistry` path and `unbound:<runtimeId>` fallback with canonical Agent Card discovery and generated endpoints.
- Fence asynchronous adapter/executor callbacks by runtime generation and make runtime replacement shutdown deterministic and idempotent.
- Add production-path end-to-end coverage for independent Pi runtimes, correlation, lifecycle replacement, isolation, malformed input, and routing failures.

## Capabilities

### New Capabilities

- `production-runtime-composition`: Compose the production transport, discovery, router, Pi adapter, wire bridge, and default-extension dispatcher into one lifecycle-owned runtime.

### Modified Capabilities

- `agent-card-registry`: Require active runtime publication to use a bound endpoint and synchronized effective runtime metadata.
- `pi-peer-communication`: Require the default extension tools to dispatch to the current self-composed runtime and suppress stale-runtime result delivery.
- `pi-session-lifecycle`: Define ordered runtime composition startup, generation fencing, and deterministic replacement shutdown.

## Impact

Affected areas include `src/index.ts`, `src/pi/lifecycle.ts`, `src/pi/adapter.ts`, new production composition/codec modules, and integration/process tests. The deprecated legacy registry remains only as an unreachable compatibility export; no new dependency, daemon, TCP listener, or remote transport is introduced.
