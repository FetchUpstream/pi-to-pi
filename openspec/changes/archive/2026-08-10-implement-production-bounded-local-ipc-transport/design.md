## Context

P2P-003 accepted a four-byte big-endian length-prefixed byte stream over Node's path-based `node:net` API. The spike implementation and frame codec live under `tests/fixtures/` and are intentionally not production modules; they provide Linux evidence and lifecycle edge-case guidance, but native macOS and Windows behavior still needs to be proven by the production test matrix. P2P-007 provides the reusable managed-process harness and GitHub Actions matrix, while `src/transport/transport.ts` and `src/transport/local-ipc.ts` remain reserved placeholders.

The transport is a lower-layer boundary for later protocol and runtime integration. It must carry bounded opaque bytes and must not know Pi protocol envelopes, task state, rooms, identities, discovery records, routing, or Pi lifecycle semantics.

## Goals / Non-Goals

**Goals:**

- Implement a production transport using Unix-domain sockets on POSIX and named pipes on Windows through Node's path-based `node:net` API.
- Provide one-operation request/response connections, reusable length framing, bounded memory, bounded phase and overall operation time, cancellation, backpressure handling, and idempotent shutdown.
- Generate short safe endpoints and recover stale POSIX endpoints only when ownership and liveness evidence is definitive.
- Prove the real implementation with focused unit, integration, and multi-process tests on Linux, macOS, and Windows using the existing harness.
- Keep the public surface transport-only and suitable for protocol-independent callers.

**Non-Goals:**

- HTTP, TCP, remote networking, a broker, daemon, database, or external service.
- Pi-to-Pi protocol envelopes, JSON parsing, task/reply semantics, authentication policy, discovery, identity/room derivation, routing, tools, or lifecycle integration.
- Persistent connections, offline delivery, retries, orchestration, or a second process-test framework.
- Claiming macOS or Windows support from the existing Ubuntu spike evidence.

## Decisions

### 1. Keep the production boundary byte-oriented

`src/transport/transport.ts` will define the transport-facing payload, handler, request-options, bound-server, and error contracts. `src/transport/local-ipc.ts` will provide the concrete implementation; small private modules such as a frame codec or endpoint helper may remain under `src/transport/`. Payloads will be accepted and returned as bounded `Uint8Array`/`Buffer` values. JSON validation from the spike will not be copied into production.

**Alternative rejected:** exposing protocol envelopes or JSON objects from the transport. That would couple this issue to P2P-011 and make the later integration boundary impossible to test independently.

### 2. Use one reusable incremental frame codec

The codec will encode exactly one four-byte unsigned big-endian length followed by the payload and decode arbitrary stream chunks incrementally. It will validate the configured maximum immediately after the complete header is available and before allocating the body. It will reject truncated headers/bodies and trailing bytes for the one-operation connection. The codec will be the only production location that implements the prefix format.

**Alternative rejected:** relying on `data` event or `write` boundaries. Node exposes a byte stream, so those boundaries cannot represent messages reliably.

### 3. Use short native endpoints without a TCP fallback

Endpoint generation will use a fresh short runtime-specific identifier. POSIX defaults will avoid repository and working-directory paths and enforce the conservative UTF-8 byte limit; Windows values will remain opaque named-pipe addresses in the supported pipe namespace. Binding and connecting will pass the endpoint directly to `net.Server.listen` and `net.createConnection`.

**Alternative rejected:** TCP loopback fallback. It violates the v1 local-IPC decision, introduces port allocation and ownership races, and creates a different security/lifecycle surface.

### 4. Model each request as an independent connection

A bound server will accept concurrent sockets. Each socket has one bounded request decoder, one handler invocation, one bounded response encoder, and a forced close after the response is flushed. The client maps one request to one socket and closes it in a `finally` path. No global current request or response ordering state is used.

**Alternative rejected:** a persistent mesh connection. It adds multiplexing, peer failure, reconnect, and request association complexity that v1 does not need.

### 5. Enforce absolute phase and operation deadlines

Transport options will carry finite validated defaults and per-operation overrides for connect, write, read, shutdown, and the overall operation. Each phase uses an absolute deadline and the effective deadline is never extended by incoming bytes, drain events, or phase transitions. The overall deadline starts when the request begins and bounds the entire connect/write/read exchange; server-side request handling and response production are also detached and the connection is closed when the bound expires. Timers are cleared on every completion path.

The starting values recorded by P2P-003 remain the defaults: 1 MiB maximum payload, 1,000 ms connect/write/read deadlines, 1,000 ms shutdown, 250 ms forced drain, and 250 ms stale probe. All overrides must be finite, safe, non-negative values within Node timer limits and the four-byte frame range.

**Alternative rejected:** an inactivity-only socket timeout. A slow-drip peer can keep resetting such a timeout indefinitely.

### 6. Make cancellation and shutdown resource-owning operations

A caller abort destroys the active client socket and rejects promptly. Every operation removes its listeners and timers even when the peer errors or closes unexpectedly. `close()` first stops accepting, then drains or force-closes tracked server/client sockets within its absolute shutdown bound, waits for close observations, and only then removes the exact owned POSIX endpoint. Repeated calls return the same completion and never reopen resources; bind and request reject once shutdown has begun.

The transport cannot cancel an arbitrary user handler promise, but it must stop waiting for its response, close the connection, and avoid retaining transport listeners/timers after the operation deadline or shutdown.

### 7. Treat stale endpoint cleanup as an ownership protocol

On POSIX, an `EADDRINUSE` bind may invoke stale cleanup only for a default-generated endpoint. Cleanup first confirms the path is a socket, probes it with a bounded connection attempt, and distinguishes live, definitively stale, and inconclusive states. A successful connection or any timeout/ambiguous close preserves the endpoint. Only a definitive refused/missing listener result permits an identity-checked quarantine/rename and unlink. If a replacement claims the path during recovery, the replacement is preserved and the quarantined inode is handled only when its identity is still owned and independently stale. Windows named-pipe lifetime is left to the OS and is never treated as POSIX filesystem cleanup.

**Alternative rejected:** blind unlink-before-bind. It can remove a live peer or a replacement runtime merely because a probe timed out.

### 8. Test the production implementation through the existing harness

Focused codec and lifecycle tests will run in-process. Cross-process tests will add only the transport-specific fixture behavior needed to bind/request opaque frames, while using `tests/support/index.ts`, managed process groups, isolated workspaces, bounded waits, diagnostics, and cleanup. The existing `.github/workflows/ci.yml` matrix will exercise the same suite on Ubuntu, macOS, and Windows with Node 22.x.

Coverage will include multiple requests between two independent processes, concurrent association, silent and slow-drip peers, split/coalesced streams, backpressure, malformed/truncated/oversized/trailing frames, abort cleanup, peer exit, idempotent close, endpoint release, and stale/live/replacement endpoint races. The spike fixtures remain evidence/reference tests and are not imported as runtime code.

## Risks / Trade-offs

- **[Windows named-pipe semantics or cleanup differ from POSIX]** → Run native Windows bind/request/abort/close/process tests in the CI matrix and keep pipe values out of filesystem cleanup code.
- **[macOS or Windows evidence is accidentally inferred from Linux]** → Mark platform results by the actual runner and require native matrix coverage before completion.
- **[Slow peers or handlers retain resources]** → Use absolute operation/phase deadlines, destroy sockets on expiry, track close events, and clear all listeners/timers.
- **[Stale cleanup races with a new runtime]** → Restrict generated paths, compare filesystem identity, quarantine atomically, recheck before unlinking, and preserve inconclusive/live replacements.
- **[A frame declaration causes excessive allocation]** → Check the four-byte declaration against the maximum before allocating or accumulating the body.
- **[Transport scope expands into parallel work]** → Keep changes under `src/transport/` and focused transport tests; leave protocol, discovery, identity, Pi, and final runtime wiring to their owning issues.

## Migration Plan

There is no data or deployment migration. Implement the reserved transport boundary and its tests without changing current lifecycle/runtime wiring. Later issue #14 can instantiate the transport and replace its temporary endpoint publication after this change is merged. Rollback is limited to reverting the transport modules and focused tests; no registry, session, or persisted artifact needs conversion.

## Open Questions

- The recorded finite defaults are implementation starting points; later runtime integration may tune them from real Pi measurements, but that is a separate decision and must not weaken boundedness.
- Capability-token authentication and remote transport security are intentionally deferred; same-user local OS permissions remain the current trust boundary for this issue.
