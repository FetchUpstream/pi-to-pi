# HTTP over local IPC comparison evidence

## Scope and decision

This is the isolated evidence record for OpenSpec tasks 3.1–3.3. The candidate
is implemented only under `tests/fixtures/local-ipc-http/`; it does not import
or modify `src/`, the production transport boundary, or Pi message/task code.
The candidate is a throwaway HTTP/1.1 request/response layer over Node's
path-based local IPC API:

- `http.createServer().listen(endpoint)` binds the endpoint.
- `http.request({ socketPath: endpoint, ... })` connects to it.
- The operation is `POST /` with an opaque byte body and one response body.
- `agent: false`, `Connection: close`, `server.keepAliveTimeout = 0`, and
  `server.maxRequestsPerSocket = 1` make one request/response one connection.
- No package or runtime dependency was added; the candidate uses `node:http`,
  `node:net`, `node:fs/promises`, `node:crypto` through the shared fixture, and
  the shared bounded deadline helpers.

**Decision: reject HTTP for the selected v1 transport.** HTTP provides useful
request inspection and parser diagnostics, but it adds start-line/header/body
framing, status handling, parser lifecycle, response-size handling, and
keep-alive rules to a one-operation local transport. Its named-pipe behavior
also requires a real Windows run before it can be treated as portable. The
length-prefixed `node:net` candidate remains the selected raw transport; this
comparison does not change it.

Implementation candidate/test commit: `f30e4ca6e2eadc5342c6c22d53ca20b6732f8e5b`.

## Bounded behavior evidence

The focused suite is `tests/fixtures/local-ipc-http/http-candidate.test.ts`.
On this Linux runner (`node v25.0.0`, repository minimum `node >=22.19.0`),
all 10 tests passed. The checks cover:

| Behavior               | Evidence                                                                                                                                                       | Linux result |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| Normal operation       | Native Unix socket round trip with opaque bytes                                                                                                                | PASS         |
| Request body limit     | `Content-Length` is rejected with HTTP 413 before the handler is called; a split chunked body is parsed and delivered to the handler                           | PASS         |
| Response body limit    | Client rejects `HttpIpcBodyLimitError` before retaining a response over its configured limit; raw capture rejects once its configured response cap is exceeded | PASS         |
| Connect deadline/error | Unavailable generated endpoint fails with a finite connect deadline                                                                                            | PASS         |
| Write deadline         | A zero-millisecond write phase rejects with `PhaseDeadlineExceededError` before sending the body                                                               | PASS         |
| Read deadline          | Delayed handler response exceeds an absolute read deadline; no slow-drip response peer was exercised                                                           | PASS         |
| Cancellation           | Caller `AbortSignal` rejects with `AbortError` and destroys the request/socket                                                                                 | PASS         |
| HTTP parser/framing    | Split header/body and chunked input are parsed; malformed input receives 400; truncated `Content-Length` input does not invoke the handler                     | PASS         |
| Concurrent requests    | Three independent connections complete concurrently with response association preserved                                                                        | PASS         |
| Cleanup/keep-alive     | `Connection: close`, disabled keep-alive, tracked active sockets, bounded close, and POSIX socket removal                                                      | PASS         |

The candidate exposes `startupMs`, measured from the `listen()` call until the
`listening` event. A separate 10-run Linux sample over fresh endpoints recorded
0.031–0.663 ms (mean 0.100 ms) for the server bind/listen phase. This is not a
process-start measurement; it isolates endpoint startup and is reported so the
HTTP layer's startup cost is not confused with client request latency.

## HTTP-specific observations

### Startup and framing

HTTP reuses the same Node path-based IPC endpoint setup as the raw candidate,
then adds creation of the HTTP server/parser and an HTTP request object. A
request carries a method, path, HTTP version, headers, and either a declared
`Content-Length` or Node's chunked transfer framing. The candidate deliberately
keeps the application body opaque; it does not introduce JSON-RPC semantics.
Node's parser, rather than a custom four-byte decoder, handles arbitrary stream
chunking and coalescing. This removes custom frame-codec code but makes the
wire contract larger and dependent on HTTP parser behavior.

The server performs a numeric `Content-Length` check before retaining a body and
bounds chunked accumulation at the configured request limit. The focused suite
verifies the `Content-Length` rejection and parses a split chunked request; it
does not independently stress an oversized chunked body. The client similarly
bounds response accumulation. Node's parser rejects malformed HTTP syntax and
emits `clientError`; an incomplete body emits an aborted request or response
and is treated as failure. Node's built-in header/parser limits are additional
HTTP behavior, not part of the raw transport contract, and the candidate does
not claim a separate server-side slow-header deadline.

### Deadline, cancellation, and cleanup lifecycle

The client arms one absolute timer for each connect, write, and read phase. The
focused suite verifies a delayed handler response exceeds the read deadline; it
does not exercise a slow-drip response peer, so no trickle result is claimed.
The read timer starts after the request is flushed and is not reset by response
data. The abort listener destroys the `ClientRequest` and socket. The server
tracks accepted sockets, stops accepting on `close()`, destroys remaining
connections after the finite close deadline, and removes only the owned POSIX
socket if Node has not already removed it. A Windows named pipe is not treated
as a filesystem path and has no POSIX unlink step.

HTTP has a more involved lifecycle than the raw one-frame exchange: status
codes and headers must be interpreted, body streams must end, parser aborts
must be handled, and keep-alive must be actively disabled. `agent: false`,
`Connection: close`, `keepAliveTimeout = 0`, and `maxRequestsPerSocket = 1`
make the lifecycle bounded for this candidate; persistent HTTP connections are
not part of the comparison target.

### Debugging/tooling benefit

HTTP is easier to inspect than an opaque length-prefixed stream. A failure can
show method, path, status, headers, and parser-generated 400 errors, and POSIX
raw-socket tools or HTTP-aware diagnostics can inspect the exchange without a
custom frame decoder. That benefit is useful for a diagnostic fixture, but it
does not offset the additional parser/status/keep-alive surface for a private
one-operation transport. External services and dependencies are not required
for the candidate or its tests.

## Platform matrix and limitations

| Runtime         | Endpoint value           | HTTP candidate evidence                                                                                                 | Limitation                                                                                                                                                                                                                                                                      |
| --------------- | ------------------------ | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Linux (current) | `/tmp/p2p-<24 hex>.sock` | Native bind, request, parser, limits, deadlines, cancellation, concurrency, and cleanup all passed                      | None for the exercised POSIX path                                                                                                                                                                                                                                               |
| macOS           | `/tmp/p2p-<24 hex>.sock` | Not run in this Linux environment                                                                                       | The code uses the same Node Unix-socket API and needs a native macOS run; no macOS pass is claimed here                                                                                                                                                                         |
| Windows         | `\\?\pipe\p2p-<24 hex>`  | Endpoint shape and capability reporting were exercised without binding; actual HTTP named-pipe bind/request was not run | A Linux runtime cannot honestly execute Windows named-pipe semantics. Node's `listen(endpoint)` and `request({ socketPath: endpoint })` are wired for the generated pipe namespace, but ACLs, parser behavior, cleanup, and one-operation lifecycle require Windows CI evidence |

The test explicitly records the Windows named-pipe limitation rather than
skipping it silently. The fixture's Windows branch uses the OS-owned named-pipe
lifecycle and never calls POSIX filesystem cleanup. A future Windows run must
execute the same focused test command and preserve its result before the HTTP
candidate could be considered portable.

## Reproducibility

```sh
npm test -- --run tests/fixtures/local-ipc-http/http-candidate.test.ts
```

The focused test command is the available-platform evidence for this work. The
candidate remains isolated from the raw `node:net` candidate and production
transport; no external service is started and no production transport behavior
is changed.
