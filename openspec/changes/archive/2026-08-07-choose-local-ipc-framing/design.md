## Context

The repository currently contains only the Pi extension scaffold and no transport implementation. Pi-to-Pi v1 is local-only, direct peer-to-peer, and must run with the Node runtime available to Pi extensions (`node >=22.19.0`) on Linux, macOS, and Windows. Node's `node:net` module presents path-based IPC as Unix domain sockets on POSIX systems and named pipes on Windows, but the endpoint is a byte stream rather than a message protocol.

The spike must establish a transport boundary that later discovery, routing, and Pi integration can consume without coupling transport behavior to Pi message or task semantics. It must also produce evidence for the two candidates in issue #4 before production transport code is written.

## Goals / Non-Goals

**Goals:**

- Compare length-prefixed JSON over `node:net` with HTTP/JSON-RPC over local IPC on Linux, macOS, and Windows.
- Select a small, bounded, one-operation local transport and record the evidence in an ADR.
- Prove partial-read handling, malformed/oversized input rejection, connect/write/read deadlines, abort behavior, bind/close behavior, and endpoint cleanup.
- Define a platform-neutral transport surface using opaque byte payloads.
- Define short endpoint naming that respects POSIX socket path limits and Windows named-pipe naming rules.

**Non-Goals:**

- Production Pi-to-Pi messaging, discovery, routing, task state, or Pi tools.
- Persistent mesh connections, offline delivery, a broker, a daemon, TCP listeners, or external services.
- Full HTTP or JSON-RPC interoperability.
- Linux abstract sockets as the cross-platform endpoint strategy; they are not available on macOS.

## Decisions

### Use `node:net` for the selected transport

The selected v1 direction is a length-prefixed stream over `node:net`. Node documents the same path-based API for Unix sockets on Linux/macOS and named pipes on Windows, avoiding a platform-specific dependency or sidecar. HTTP/local IPC remains in the spike as a comparison candidate, but is not the production direction unless the matrix reveals a compelling, portable advantage.

HTTP is rejected for the v1 transport because `socketPath` is documented primarily as a Unix-domain-socket option, its Windows behavior requires target-platform verification, and HTTP adds headers, body-limit, status, keep-alive, and parser lifecycle concerns to a protocol that needs one local request and one local response. Historical Node HTTP socket-path issues reinforce the need to avoid depending on that extra layer.

### Keep framing below the protocol layer

The wire frame is:

```text
uint32 big-endian payload length | UTF-8 JSON payload
```

The spike uses JSON payloads because that is the current candidate and makes malformed-input testing direct. The transport interface itself accepts and returns opaque `Uint8Array`/`Buffer` payloads; JSON serialization and Pi-to-Pi envelopes remain above it. The parser reads exactly four header bytes, rejects a declared size above the configured hard maximum before allocating or buffering the body, then accumulates arbitrary stream chunks until exactly one payload is complete.

A connection carries one request frame and one response frame. Extra bytes, malformed JSON in the spike, truncated frames, and premature EOF are errors. The client and server close the connection after the operation rather than maintaining a persistent mesh.

### Use explicit phase deadlines and aborts

Connect, write, and read phases each have a bounded deadline. Deadlines are absolute phase timers, not only inactivity timers, so a peer cannot keep a read alive by sending an endless trickle of bytes. `AbortSignal`/explicit socket destruction is used to terminate an operation. Node's `socket.setTimeout()` may be retained as an idle safety measure, but it is not treated as cancellation because Node documents that it emits a timeout without closing the connection.

The exact default durations and maximum payload value are implementation/test constants to be chosen from the spike; the contract requires that they are finite, configurable, and enforced.

### Use short, unique platform-specific endpoints

Each runtime gets a fresh random endpoint identity. POSIX endpoints use a short runtime root plus a short random basename such as `p2p-<id>.sock`; the implementation checks the UTF-8 byte length against a conservative limit below macOS's documented typical 103-byte limit. Repository paths, room names, and display names are never embedded directly in the socket path.

Windows endpoints use a flat named-pipe name such as `\\?\\pipe\\p2p-<id>`. The POSIX and Windows endpoint values are stored as opaque addresses by later discovery code. Linux abstract sockets are not selected because they would make the endpoint strategy platform-specific.

A normal close removes the exact POSIX socket created by the current runtime and closes the server. A crashed POSIX process may leave a stale socket file; fresh runtime-specific names avoid reuse collisions, and cleanup must never blindly unlink an arbitrary existing path. Any stale-path probe used by the spike must first establish that the endpoint is an owned socket with no live listener. Windows named-pipe cleanup is delegated to the OS lifecycle.

### Expose a transport-only interface

The spike and ADR define an interface equivalent to:

```text
bind(endpoint, handler) -> bound server
request(endpoint, payload, deadlines, signal) -> payload
close() -> completion
```

Transport errors cover endpoint availability, bind failure, timeout, cancellation, malformed frame, oversized frame, premature close, and write failure. Pi message types, task IDs, rooms, identity, and routing policy are not interpreted by this layer.

### Verify on all three desktop platforms

The evidence matrix targets the declared minimum Node line on `ubuntu`, `macos`, and `windows`. The `node:net` candidate is required to pass on all three. The HTTP candidate is run where its platform endpoint can be represented, including a Windows named pipe, but remains rejected if it requires platform-specific workarounds or lacks equivalent deadline/size behavior.

The spike covers: normal round trips, split writes and coalesced frames, malformed and oversized input, slow/truncated peers, unavailable endpoints, aborts, concurrent clients, clean shutdown, abrupt process exit, stale POSIX paths, and endpoint byte-length boundaries.

## Risks / Trade-offs

- **[Windows named-pipe behavior or ACLs differ from POSIX]** → Run real Windows CI tests with the exact Node minimum; keep the endpoint abstraction platform-specific and avoid assuming filesystem semantics.
- **[POSIX socket paths exceed OS limits in deep temporary directories]** → Generate short basenames, validate byte length before bind, and report a clear configuration error rather than silently truncating.
- **[Stream chunks do not preserve write boundaries]** → Use a fixed-size length header and a bounded incremental parser; test both split and coalesced delivery.
- **[A slow peer defeats an idle timeout by trickling bytes]** → Enforce absolute phase deadlines and destroy the socket when they expire.
- **[Crash leaves a Unix socket file]** → Use a fresh runtime identity for every endpoint, clean up only the current owned path, and avoid blind unlinking.
- **[HTTP appears easier to debug]** → Capture the debugging benefit in the ADR, but do not accept HTTP complexity unless it passes the same cross-platform and boundedness checks.
- **[JSON framing couples the spike to the eventual protocol]** → Keep JSON in the spike payload and make the transport API byte-oriented so the later protocol can evolve independently.

## Migration Plan

There is no production migration. Keep the spike fixtures and ADR isolated from `src/` transport behavior. Later implementation work will implement the selected interface against the recorded limits and lifecycle rules; if the spike rejects the selected candidate, update this change's ADR before applying implementation tasks.

## Open Questions

- What numeric defaults provide the best balance between Pi prompt size and local transport overhead for maximum frame, connect, write, and read deadlines?
- Should the future reliability layer add a per-runtime capability token in addition to same-user filesystem/pipe permissions?
- Which Node versions beyond the minimum should be included in the release CI matrix?
