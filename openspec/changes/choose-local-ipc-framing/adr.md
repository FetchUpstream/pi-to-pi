# ADR: bounded length-prefixed `node:net` local IPC

- **Status:** Accepted for the v1 transport direction
- **Date:** 2026-08-07
- **Scope:** OpenSpec change `choose-local-ipc-framing`; fixture evidence only
- **Evidence:** [`evidence-matrix.md`](evidence-matrix.md) and its retained raw
  output under [`evidence/`](evidence/)

## Decision

Select a four-byte, big-endian length-prefixed byte stream over Node's
path-based `node:net` API for the local v1 transport. On Linux and macOS the
opaque endpoint is a Unix-domain socket path; on Windows it is a named-pipe
value in the `\\?\\pipe\\` namespace. Each connection carries one request
frame and one response frame, and closes after that exchange.

The wire frame is:

```text
uint32 big-endian payload length | exactly that many payload bytes
```

The parser reads the fixed four-byte header from arbitrary stream chunks,
checks the declared length against the maximum before allocating the body, and
then accumulates exactly one payload. A complete frame is dispatched without
waiting for peer EOF. Truncated frames, malformed payloads in the JSON-oriented
spike, oversized declarations, and trailing bytes are errors. The transport
surface stays byte-oriented; JSON encoding and Pi-to-Pi envelopes remain above
it.

The implementation direction is deliberately not production code. The approved
candidates are throwaway fixtures under `tests/fixtures/local-ipc*`; they do not
import or modify `src/`, Pi message/task semantics, discovery, routing, a
broker, a daemon, or an external service.

## Rejected alternative: HTTP over local IPC

Reject HTTP/1.1 over local IPC for v1. The comparison candidate binds the same
path-based endpoint and sends one `POST /` request with an opaque body, but it
adds a start line, headers, status codes, body framing, parser/error lifecycle,
response-size handling, and keep-alive rules to a protocol that needs one local
request and one local response. The candidate must explicitly disable or bound
connection reuse (`agent: false`, `Connection: close`, disabled keep-alive, and
one request per socket), track more stream events, and interpret more failure
states.

HTTP has real benefits: Node supplies a mature parser, malformed requests
produce useful diagnostics, and method/path/status/headers are easier to inspect
with generic tools. The candidate uses only Node built-ins and proves finite
request/response limits, phase deadlines, cancellation, concurrent requests,
parser behavior, and POSIX cleanup on Linux. Those debugging benefits do not
outweigh the additional wire and lifecycle surface for a private transport. The
HTTP named-pipe path also needs a native Windows run before its portability can
be treated as established.

The Ubuntu evidence is not a claim that HTTP works everywhere: Node `v25.0.0`
passed all 14 HTTP fixture tests three times on a native Unix socket, while the
macOS and Windows rows remain explicitly unavailable. The HTTP fixture also
does not exercise a slow-drip response peer, so it supplies no slow-drip result.
See [`http-comparison.md`](http-comparison.md) for the detailed candidate
trade-offs and platform limitations.

## Evidence summary

The available runner is Ubuntu/Linux (`Linux 7.0.0-28-generic x86_64`) with
Node `v25.0.0` (`>=22.19.0`). The reproducible commands are:

```text
node -e "const [major, minor] = process.versions.node.split('.').map(Number); if (major < 22 || (major === 22 && minor < 19)) { console.error('Node >=22.19.0 required; found ' + process.version); process.exit(1); }"
node --version
npx vitest run tests/fixtures/local-ipc/endpoint.test.ts tests/fixtures/local-ipc-spike --reporter=verbose
npx vitest run tests/fixtures/local-ipc-http/http-candidate.test.ts --reporter=verbose
```

The same one-line commands are valid in Bash, PowerShell, and `cmd.exe`. The Node
guard must exit with status `0`; `node --version` records the exact runtime, and
the verbose output must be retained. Canonical raw evidence is indexed as
`raw-run-1.txt`, `raw-run-2.txt`, and `raw-run-3.txt` (71 tests in 6 files each);
canonical HTTP evidence is `http-run-1.txt`, `http-run-2.txt`, and `http-run-3.txt`
(14 tests in 1 file each). `cleanup-baseline-delta.txt` is a separate pre/post
inventory around the third pair, not an additional test run. Non-native platform
cases are explicit limitation assertions; no native macOS or Windows support is
claimed from the Ubuntu run.

| Candidate                      | Ubuntu/Linux, Node `v25.0.0`                                                                  | macOS, Node `>=22.19.0`                                      | Windows, Node `>=22.19.0`                                              |
| ------------------------------ | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------ | ---------------------------------------------------------------------- |
| Raw length-prefixed `node:net` | **PASS** — 71/71 tests per run; native Unix socket                                            | **UNAVAILABLE** — native macOS run required; no pass claimed | **UNAVAILABLE** — native named-pipe run required; no pass claimed      |
| HTTP/local IPC comparison      | **PASS** — 14/14 tests per run; native Unix socket                                            | **UNAVAILABLE** — native macOS run required; no pass claimed | **UNAVAILABLE** — native named-pipe HTTP run required; no pass claimed |
| Repeated cleanup               | **PASS** — three focused repetitions, empty pre/post artifact delta and zero fixture children | **UNAVAILABLE** — native filesystem/process run required     | **UNAVAILABLE** — native named-pipe/process run required               |

The raw matrix covers native endpoint selection, short names and byte limits,
normal opaque round trips, split/coalesced framing, one-operation closure,
malformed/truncated/trailing/oversized request and response frames, unavailable
endpoints, connect/write/read deadlines, slow-drip reads, cancellation,
backpressure, concurrency, clean shutdown, abrupt child exit, stale endpoint
probing, endpoint ownership and quarantine replacement races, child diagnostics, and platform limitations. The
HTTP matrix covers native round trips, request/response limits, bounded writes
and close, connect/write/read deadlines, cancellation, split/chunked and
malformed parser input, concurrency, keep-alive/cleanup, endpoint replacement
safety, and the Windows endpoint limitation. The evidence matrix maps each
scenario to its exact test name and retained output file.

Repository checks are recorded in `evidence/ubuntu-node-25.0.0/repository-checks.txt`:
`npm run typecheck` and focused ESLint both pass, and `npm test` passes all 86
tests in 8 files. `npm run format:check` exits 1 because the coordinator
snapshot has 13 pre-existing formatting warnings in `.pi/prompts/*.md`,
`.pi/skills/**/*.md`, and `AGENTS.md`; the changed ADR and evidence Markdown
files pass their focused Prettier check. This pre-existing documentation warning
does not indicate a spike or production-code failure.

## Endpoint strategy

Generate a new random runtime identifier for every endpoint. The identifier is
12 random bytes rendered as 24 lowercase hexadecimal characters.

| Runtime     | Endpoint                  | Rules                                                                                                               |
| ----------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Linux/macOS | `/tmp/p2p-<24 hex>.sock`  | Use the fixed short `/tmp` root in the fixture; never embed a repository, working-directory, room, or display name. |
| Windows     | `\\?\\pipe\\p2p-<24 hex>` | Treat the value as an opaque named-pipe address, never as a filesystem path.                                        |

The fixture rejects a POSIX endpoint over 100 UTF-8 bytes. This conservative
limit is below the shortest commonly encountered Unix socket path limit and is
checked by bytes rather than JavaScript code units. A deep working directory
therefore does not lengthen the endpoint. Distinct random IDs prevent concurrent
runtime collisions.

Normal close removes only the exact POSIX socket identity owned by the current
runtime and releases the server and active sockets. A crashed POSIX process can
leave a stale socket. Recovery is allowed only for a default-generated socket
whose `lstat` identity and bounded no-live-listener probe establish ownership;
the path is atomically quarantined and identity-checked before removal or
restoration. If another listener claims the vacant endpoint during relink, the
moved replacement remains at its quarantine path; only an owned quarantine entry
proven stale within the caller's absolute cleanup deadline may be removed. A
non-socket, a live listener, an arbitrary root, or an inconclusive probe is not
blindly unlinked. Windows named-pipe lifetime is delegated to the operating
system and requires native Windows evidence.

The separate `cleanup-baseline-delta.txt` records the pre/post artifact inventory
captured around `raw-run-3.txt` and `http-run-3.txt`; it is not a fourth test run.
The baseline contained three pre-existing `/tmp/p2p-*.sock` files and eleven
`/tmp/p2p-*` temporary directories. The run introduced no new socket, quarantine
entry, temporary directory, or fixture child, and it did not remove those unrelated
baseline entries because ownership was not established. This is the honest cleanup
result; a global absence claim would be incorrect.

## Transport-only interface

Later production code should consume an interface equivalent to:

```text
bind(endpoint, handler) -> bound server
request(endpoint, payload, options) -> payload
close() -> completion
```

- `endpoint` is an opaque platform-specific address.
- `payload` is bounded `Uint8Array`/`Buffer` data in both directions.
- `handler` receives one request payload and returns one response payload.
- `options` may carry phase deadlines and an `AbortSignal`.
- transport errors identify endpoint availability, bind failure, timeout,
  cancellation, malformed/truncated/trailing frame, oversized frame, premature
  close, write failure, or shutdown failure.

This layer must not parse Pi message envelopes, task IDs, rooms, identities,
route policy, or delivery semantics. The spike's optional JSON validator exists
only to make malformed-JSON acceptance scenarios observable; it is not part of
the selected byte transport contract.

## Finite defaults and future overrides

The spike records these finite defaults as the starting contract for later
production configuration:

| Setting               |                   Default | Enforcement/evidence                                                                                                        |
| --------------------- | ------------------------: | --------------------------------------------------------------------------------------------------------------------------- |
| Maximum frame/payload | `1,048,576` bytes (1 MiB) | Four-byte decoder checks the declaration before body allocation; encoder and request/response paths reject larger payloads. |
| Connect deadline      |                `1,000 ms` | Absolute phase deadline; unavailable and never-connect tests use shorter explicit deadlines.                                |
| Write deadline        |                `1,000 ms` | Absolute phase deadline, including drain/backpressure; fake and real backpressure tests use bounded values.                 |
| Read deadline         |                `1,000 ms` | Absolute phase deadline, not an idle timer; never-response and slow-drip tests prove destruction at the deadline.           |

Related lifecycle defaults in the fixture are a `1,000 ms` shutdown deadline,
`250 ms` forced socket drain, and `250 ms` stale-listener probe. Test helpers
also use a finite `5,000 ms` phase default, `1,000 ms` child cleanup wait,
`250 ms` force-kill wait, and 64 KiB diagnostic output cap. These helper values
bound test cleanup and do not expand the transport wire contract.

Future production configuration may override the frame, connect, write, and
read values at transport construction or per-request options, but only through
validated finite values. The implementation must reject `NaN`, infinities,
negative values, unsafe integers, values beyond Node's timer maximum, and frame
sizes beyond the unsigned 32-bit header range. An override must remain an
absolute phase deadline; replacing it with an inactivity-only timeout would
reintroduce the slow-drip failure the spike is intended to prevent. Endpoint
root overrides, if ever needed, must retain the UTF-8 byte-length guard and
must not embed untrusted room or working-directory strings. Production defaults
should be chosen from real Pi prompt-size and latency measurements, then
recorded as a follow-up decision rather than silently changing this evidence.

## Known limitations and follow-up requirements

1. Only Ubuntu/Linux was available for this run. macOS Unix-socket behavior and
   Windows named-pipe behavior, ACLs, process cleanup, and endpoint lifecycle
   require native runners. No unavailable row is reported as a pass.
2. The available runtime was Node `v25.0.0`, which satisfies but does not equal
   the declared minimum `v22.19.0`. The reproducible Node guard command enforces
   the lower bound; a release matrix should still include the minimum line explicitly.
3. The HTTP suite did not include a slow-drip response peer. The selected raw
   candidate does, and no equivalent HTTP claim is made.
4. The spike is behavioral evidence, not a throughput or latency benchmark. It
   does not select final production defaults from performance measurements.
5. Same-user endpoint permissions and OS named-pipe ACLs are the current local
   trust boundary. A future reliability/security decision may add a capability
   token, but that is outside this spike.
6. Existing unrelated `/tmp/p2p-*` artifacts were observed during cleanup
   inventory. The fixture correctly leaves paths of unknown ownership alone;
   CI should provide an isolated temporary environment when a zero-baseline
   inventory is required.

## Consequence

The later transport implementation has one small, portable byte-stream boundary
to implement and a concrete set of bounded lifecycle rules to preserve. It must
not inherit HTTP's parser/status/keep-alive surface merely for convenience. HTTP
remains available as a diagnostic comparison fixture, and the evidence matrix
must be rerun natively on macOS and Windows before claiming all-platform
support.
