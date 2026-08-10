## MODIFIED Requirements

### Requirement: Platform-specific local endpoints
The production transport SHALL use Node's path-based local IPC API. On Linux and macOS it SHALL bind Unix domain socket paths; on Windows it SHALL bind named-pipe paths using the `\\?\\pipe\\` or `\\.\\pipe\\` namespace. It MUST NOT introduce a TCP listener or another fallback transport for v1.

#### Scenario: Linux endpoint
- **WHEN** the transport binds on Linux with a generated endpoint
- **THEN** Node SHALL create a Unix domain socket endpoint and a client SHALL connect to it using the same endpoint value

#### Scenario: macOS endpoint
- **WHEN** the transport binds on macOS with a generated endpoint
- **THEN** Node SHALL create a Unix domain socket endpoint and a client SHALL connect to it using the same endpoint value

#### Scenario: Windows endpoint
- **WHEN** the transport binds on Windows with a generated endpoint
- **THEN** Node SHALL create a named-pipe endpoint in the Windows pipe namespace and a client SHALL connect to it without treating it as a filesystem path

#### Scenario: No TCP fallback
- **WHEN** a native local endpoint cannot be bound
- **THEN** the transport SHALL report the bounded local-endpoint failure and SHALL NOT open a TCP listener

### Requirement: Short safe endpoint names
The transport SHALL generate endpoints from a short runtime-specific identifier, SHALL avoid embedding repository or working-directory paths, and SHALL reject a POSIX endpoint whose UTF-8 byte length exceeds the configured conservative limit. Generated endpoints SHALL be distinct for concurrently starting runtimes and SHALL remain valid for the native platform endpoint API.

#### Scenario: Deep working directory
- **WHEN** the process runs from a deeply nested working directory
- **THEN** the generated POSIX endpoint SHALL remain within the configured byte limit because it does not include the working-directory path

#### Scenario: Endpoint collision
- **WHEN** two runtimes start concurrently in the same room
- **THEN** they SHALL receive distinct endpoint values without overwriting one another

#### Scenario: Endpoint byte boundary
- **WHEN** a configured POSIX endpoint is exactly at the allowed UTF-8 byte limit
- **THEN** the transport SHALL accept it, and SHALL reject an endpoint one UTF-8 byte over the limit before binding

### Requirement: Explicit length-prefixed frames
The selected production transport SHALL encode each payload exactly once as a four-byte unsigned big-endian length followed by exactly that many payload bytes, and SHALL parse incoming data as an arbitrary stream rather than relying on write or data-event boundaries. The frame codec SHALL be reusable by both request and response paths and SHALL not add protocol or JSON semantics.

#### Scenario: Split header and body
- **WHEN** a peer delivers a frame header and body across multiple data chunks
- **THEN** the receiver SHALL accumulate the chunks and deliver exactly one complete payload to the handler

#### Scenario: Coalesced data
- **WHEN** multiple writes cause header and body bytes to arrive in a single data chunk
- **THEN** the receiver SHALL parse the complete frame without treating the chunk itself as a message boundary

#### Scenario: Reusable codec
- **WHEN** the client encodes a request or the server encodes a response
- **THEN** both paths SHALL use the same four-byte codec behavior and SHALL not implement a second length-prefix format

#### Scenario: One operation per connection
- **WHEN** a request frame is accepted and a response frame is written
- **THEN** the connection SHALL be closed after that request/response exchange rather than retained as a persistent mesh connection

### Requirement: Bounded and validated input
The transport SHALL enforce a finite maximum frame size before allocating or buffering the declared body, and SHALL reject malformed, truncated, oversized, or unexpected trailing frame input. Complete arbitrary byte payloads SHALL be valid transport payloads; JSON, UTF-8, Pi envelopes, and task semantics SHALL remain above this layer.

#### Scenario: Oversized declaration
- **WHEN** a peer sends a length header greater than the configured maximum
- **THEN** the transport SHALL reject and close the connection before allocating a buffer for the declared body

#### Scenario: Opaque binary payload
- **WHEN** a peer sends a complete bounded payload containing arbitrary byte values
- **THEN** the transport SHALL deliver those exact bytes without applying JSON or text validation

#### Scenario: Truncated payload
- **WHEN** the peer closes before the declared number of bytes arrives
- **THEN** the transport SHALL report a premature-close failure and SHALL not deliver a partial payload

#### Scenario: Unexpected trailing input
- **WHEN** bytes arrive after the one complete frame allowed for the connection
- **THEN** the transport SHALL reject the connection and SHALL not silently deliver a second frame

### Requirement: Bounded deadlines and cancellation
The transport SHALL enforce finite connect, write, read, shutdown, and overall-operation deadlines. Phase deadlines SHALL be absolute rather than inactivity-only timers, and the overall operation deadline SHALL bound the complete request/response exchange, including a peer that accepts a connection but never produces a response. The transport SHALL terminate the operation when its abort signal is triggered and SHALL release all operation-owned sockets, listeners, and timers.

#### Scenario: Unavailable endpoint
- **WHEN** a client requests an endpoint with no listening peer
- **THEN** the request SHALL fail within the configured connect and overall-operation bounds

#### Scenario: Silent peer
- **WHEN** a peer accepts a connection but never replies
- **THEN** the request SHALL fail within the configured absolute read or overall-operation deadline and SHALL destroy the connection

#### Scenario: Slow-drip headers or body
- **WHEN** a peer sends request or response header/body bytes slowly enough to avoid an idle timeout but exceeds the absolute applicable deadline
- **THEN** the transport SHALL fail the operation at that deadline and SHALL destroy the connection without waiting for peer EOF

#### Scenario: Caller cancellation
- **WHEN** the caller aborts an in-flight request
- **THEN** the request SHALL reject as cancelled, close the underlying socket, and leave no operation listener or timer behind

### Requirement: Transport-only interface
The transport SHALL expose operations equivalent to `bind(endpoint, handler)`, `request(endpoint, payload, options)`, and `close()`, and SHALL pass opaque bounded byte payloads without interpreting Pi message, task, room, identity, or routing semantics. A bound handler SHALL be isolated to its one request/response connection, and lifecycle operations SHALL be idempotent.

#### Scenario: Protocol-independent payload
- **WHEN** a caller sends an arbitrary bounded byte payload through `request`
- **THEN** the transport SHALL deliver the same payload bytes to the bound handler and return the handler's response bytes

#### Scenario: Concurrent requests
- **WHEN** multiple callers issue requests to one bound endpoint concurrently
- **THEN** each caller SHALL receive the response produced for its own connection without cross-wiring

#### Scenario: Clean shutdown
- **WHEN** `close()` is called on a bound transport
- **THEN** the transport SHALL stop accepting new connections, finish or force-close active operations according to the shutdown deadline, and resolve only after its resources and owned endpoint are released

#### Scenario: Repeated shutdown
- **WHEN** `close()` is called more than once, including while the first close is in progress
- **THEN** all calls SHALL complete using the same shutdown lifecycle without reopening resources or throwing solely because the transport is already closed

### Requirement: Platform evidence and decision record
The change SHALL include repeatable production transport tests on Linux, macOS, and Windows and SHALL record the selected framing approach, rejected alternatives, platform evidence, and known limitations in the existing ADR or an equivalent design record. The cross-platform tests SHALL use the repository's existing managed process harness rather than a second bespoke child-process framework.

#### Scenario: Cross-platform matrix
- **WHEN** the production transport suite runs on Ubuntu, macOS, and Windows using the supported Node runtime
- **THEN** it SHALL exercise the native local endpoint on each platform and report pass/fail results for framing, limits, deadlines, cancellation, multi-process exchange, and cleanup

#### Scenario: Rejected HTTP alternative
- **WHEN** the transport decision is reviewed
- **THEN** the existing decision record SHALL document HTTP/local-IPC startup, framing, limits, deadlines, cancellation, cleanup, dependency footprint, and debugging trade-offs before retaining the length-prefixed `node:net` approach

#### Scenario: Harness reuse
- **WHEN** a cross-process transport test starts independent peers
- **THEN** it SHALL use the existing isolated workspace, managed-process, bounded-wait, diagnostics, and cleanup helpers and SHALL not create a competing process lifecycle framework
