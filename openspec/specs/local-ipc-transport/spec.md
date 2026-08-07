# Local IPC Transport

## Purpose

Provide a bounded, platform-specific local IPC transport for Pi-to-Pi runtime communication using native local endpoints and length-prefixed opaque byte frames.

## Requirements

### Requirement: Platform-specific local endpoints
The transport SHALL use Node's path-based local IPC API. On Linux and macOS it SHALL bind Unix domain socket paths; on Windows it SHALL bind named-pipe paths using the `\\?\\pipe\\` or `\\.\\pipe\\` namespace.

#### Scenario: Linux endpoint
- **WHEN** the transport binds on Linux with a generated endpoint
- **THEN** Node SHALL create a Unix domain socket endpoint and a client SHALL connect to it using the same endpoint value

#### Scenario: macOS endpoint
- **WHEN** the transport binds on macOS with a generated endpoint
- **THEN** Node SHALL create a Unix domain socket endpoint and a client SHALL connect to it using the same endpoint value

#### Scenario: Windows endpoint
- **WHEN** the transport binds on Windows with a generated endpoint
- **THEN** Node SHALL create a named-pipe endpoint in the Windows pipe namespace and a client SHALL connect to it without treating it as a filesystem path

### Requirement: Short safe endpoint names
The transport SHALL generate endpoints from a short runtime-specific identifier, SHALL avoid embedding repository or working-directory paths, and SHALL reject a POSIX endpoint whose UTF-8 byte length exceeds the configured conservative limit.

#### Scenario: Deep working directory
- **WHEN** the process runs from a deeply nested working directory
- **THEN** the generated POSIX endpoint SHALL remain within the configured byte limit because it does not include the working-directory path

#### Scenario: Endpoint collision
- **WHEN** two runtimes start concurrently in the same room
- **THEN** they SHALL receive distinct endpoint values without overwriting one another

### Requirement: Explicit length-prefixed frames
The selected transport SHALL encode each payload as a four-byte unsigned big-endian length followed by exactly that many payload bytes, and SHALL parse incoming data as an arbitrary stream rather than relying on write or data-event boundaries.

#### Scenario: Split header and body
- **WHEN** a peer delivers a frame header and body across multiple data chunks
- **THEN** the receiver SHALL accumulate the chunks and deliver exactly one complete payload to the handler

#### Scenario: Coalesced data
- **WHEN** multiple writes cause header and body bytes to arrive in a single data chunk
- **THEN** the receiver SHALL parse the complete frame without treating the chunk itself as a message boundary

#### Scenario: One operation per connection
- **WHEN** a request frame is accepted and a response frame is written
- **THEN** the connection SHALL be closed after that request/response exchange rather than retained as a persistent mesh connection

### Requirement: Bounded and validated input
The transport SHALL enforce a finite maximum frame size before allocating or buffering the declared body, and SHALL reject malformed, truncated, oversized, or unexpected trailing input.

#### Scenario: Oversized declaration
- **WHEN** a peer sends a length header greater than the configured maximum
- **THEN** the transport SHALL reject and close the connection before allocating a buffer for the declared body

#### Scenario: Malformed payload
- **WHEN** the spike receives a complete frame that is not valid UTF-8 JSON
- **THEN** the spike SHALL report a malformed-frame failure and SHALL not invoke the application handler

#### Scenario: Truncated payload
- **WHEN** the peer closes before the declared number of bytes arrives
- **THEN** the transport SHALL report a premature-close failure and SHALL not deliver a partial payload

### Requirement: Bounded deadlines and cancellation
The transport SHALL enforce finite connect, write, and read deadlines, SHALL use absolute phase deadlines rather than relying only on inactivity, and SHALL terminate the operation when its abort signal is triggered.

#### Scenario: Unavailable endpoint
- **WHEN** a client requests an endpoint with no listening peer
- **THEN** the request SHALL fail within the configured connect deadline

#### Scenario: Slow-drip response
- **WHEN** a peer sends response bytes slowly enough to avoid an idle timeout but exceeds the absolute read deadline
- **THEN** the request SHALL fail and destroy the connection at the read deadline

#### Scenario: Caller cancellation
- **WHEN** the caller aborts an in-flight request
- **THEN** the request SHALL reject as cancelled and release the underlying socket without waiting for the peer

### Requirement: Transport-only interface
The transport SHALL expose operations equivalent to `bind(endpoint, handler)`, `request(endpoint, payload, options)`, and `close()`, and SHALL pass opaque byte payloads without interpreting Pi message, task, room, identity, or routing semantics.

#### Scenario: Protocol-independent payload
- **WHEN** a caller sends an arbitrary bounded byte payload through `request`
- **THEN** the transport SHALL deliver the same payload bytes to the bound handler and return the handler's response bytes

#### Scenario: Clean shutdown
- **WHEN** `close()` is called on a bound transport
- **THEN** the transport SHALL stop accepting new connections, finish or force-close active operations according to the shutdown deadline, and resolve only after its resources are released

### Requirement: Platform evidence and decision record
The change SHALL include repeatable spike tests on Linux, macOS, and Windows and SHALL record the selected framing approach, rejected alternatives, platform evidence, and known limitations in an ADR or equivalent design note.

#### Scenario: Cross-platform matrix
- **WHEN** the spike runs on Ubuntu, macOS, and Windows using the supported Node runtime
- **THEN** the `node:net` candidate SHALL exercise its native local endpoint on each platform and report pass/fail results for framing, limits, deadlines, cancellation, and cleanup

#### Scenario: Rejected HTTP alternative
- **WHEN** the comparison report is finalized
- **THEN** it SHALL document HTTP/local-IPC startup, framing, limits, deadlines, cancellation, cleanup, dependency footprint, and debugging trade-offs before rejecting or retaining it
