# Local IPC spike evidence matrix

## Scope and provenance

This record closes OpenSpec tasks 4.1–4.4 for the approved, fixture-only
candidates. The candidate snapshot exercised below is the coordinator worktree
at commit `6956017` (`docs: correct HTTP comparison test count`), after the
raw `node:net`, helper, and HTTP lifecycle review fixes were merged. The
fixtures remain under `tests/fixtures/`; no production `src/` transport or Pi
message/task module is imported.

The available runner is Ubuntu/Linux (`uname -srm`: `Linux 7.0.0-28-generic
x86_64`) with Node `v25.0.0`, which satisfies the repository minimum
`node >=22.19.0`. Node `v25.0.0` is recorded exactly; no result below the
minimum is accepted.

## Reproducible commands

Run these commands from the repository root on Ubuntu, macOS, or Windows. They
are one-line commands so the same text works in Bash, PowerShell, and `cmd.exe`:

```text
node -e "const [major, minor] = process.versions.node.split('.').map(Number); if (major < 22 || (major === 22 && minor < 19)) { console.error('Node >=22.19.0 required; found ' + process.version); process.exit(1); }"
node --version
npx vitest run tests/fixtures/local-ipc/endpoint.test.ts tests/fixtures/local-ipc-spike --reporter=verbose
npx vitest run tests/fixtures/local-ipc-http/http-candidate.test.ts --reporter=verbose
```

The first Vitest command is the raw candidate matrix: it intentionally names
`endpoint.test.ts` rather than the whole `tests/fixtures/local-ipc` directory,
so it cannot accidentally select the HTTP directory by path prefix.
The second command is the HTTP comparison. The Node guard must exit with status `0`; `node --version` records the exact runtime after the guard, and the verbose output
must be retained, not replaced by a test-count summary.

For the full fixture check, run the two focused commands above followed by:

```text
npm run typecheck
npx eslint tests/fixtures/local-ipc tests/fixtures/local-ipc-spike tests/fixtures/local-ipc-http
```

The canonical test commands and per-test output captured on the available runner are
stored beside this record:

- [`raw-run-1.txt`](evidence/ubuntu-node-25.0.0/raw-run-1.txt) — canonical raw run 1;
  6 files, 70 tests passed.
- [`raw-run-2.txt`](evidence/ubuntu-node-25.0.0/raw-run-2.txt) — canonical raw run 2;
  6 files, 70 tests passed.
- [`raw-run-3.txt`](evidence/ubuntu-node-25.0.0/raw-run-3.txt) — canonical raw run 3;
  6 files, 70 tests passed.
- [`http-run-1.txt`](evidence/ubuntu-node-25.0.0/http-run-1.txt) — canonical HTTP run 1;
  1 file, 14 tests passed.
- [`http-run-2.txt`](evidence/ubuntu-node-25.0.0/http-run-2.txt) — canonical HTTP run 2;
  1 file, 14 tests passed.
- [`http-run-3.txt`](evidence/ubuntu-node-25.0.0/http-run-3.txt) — canonical HTTP run 3;
  1 file, 14 tests passed.
- [`cleanup-baseline-delta.txt`](evidence/ubuntu-node-25.0.0/cleanup-baseline-delta.txt)
  — separate pre/post artifact inventory captured around the third raw/HTTP repetitions; it is not a test-run record or a fourth run.
- [`repository-checks.txt`](evidence/ubuntu-node-25.0.0/repository-checks.txt)
  — typecheck, focused lint, format check, and full repository test output.
- [`openspec-validation.txt`](evidence/ubuntu-node-25.0.0/openspec-validation.txt)
  — strict OpenSpec change validation output.

Each canonical raw/HTTP run file contains the Vitest pass/fail output for its acceptance
scenarios. `cleanup-baseline-delta.txt` contains only inventory/delta metadata around
the third raw and HTTP repetitions; it is not a replacement for either run file.
Non-native-platform cases are explicit limitation assertions; they do not claim native
macOS or Windows support.

## Platform matrix

| Platform and runtime         | Raw `node:net` candidate                                                                  | HTTP comparison                                                                                                                    | Cleanup/process evidence                                                                 | Limitation                                                                                                                                                                          |
| ---------------------------- | ----------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ubuntu/Linux, Node `v25.0.0` | **PASS** — 6 files, 70 tests, including native Unix-socket bind/request/close             | **PASS** — 1 file, 14 tests, including native Unix-socket HTTP bind/request/close                                                  | **PASS** on three repeated focused runs; artifact delta is empty and child count is zero | Three unrelated pre-existing `/tmp/p2p-*.sock` files and eleven `/tmp/p2p-*` directories were present in the baseline. They were not removed because ownership was not established. |
| macOS, Node `>=22.19.0`      | **UNAVAILABLE — native run required**; no macOS result is claimed from Linux              | **UNAVAILABLE — native run required**; no macOS result is claimed from Linux                                                       | **UNAVAILABLE — native filesystem/process cleanup requires macOS**                       | The source uses the same POSIX path API and includes a Darwin endpoint-generation assertion, but that is not a native macOS bind or lifecycle result.                               |
| Windows, Node `>=22.19.0`    | **UNAVAILABLE — native run required**; no Windows named-pipe result is claimed from Linux | **UNAVAILABLE — native run required**; `socketPath` capability shape is tested, but no Windows HTTP bind/request result is claimed | **UNAVAILABLE — native named-pipe/process cleanup requires Windows**                     | Named pipes are OS-managed objects rather than POSIX files. The Linux run cannot enumerate or prove Windows pipe cleanup, and the fixture records that limitation explicitly.       |

The macOS and Windows rows are limitations, not skipped platforms. On each
native runner, preserve the same commands, Node version, verbose output, and
post-run cleanup inventory before changing a row to `PASS` or `FAIL`.

## Raw `node:net` acceptance matrix

The raw output files contain the exact test names and statuses. This table maps
each acceptance area to those output lines and to the approved fixture code.
All entries are `PASS` on Ubuntu/Linux; a native macOS or Windows result remains
unavailable as stated above.

| Acceptance area                           | Exact evidence covered by the raw suite                                                                                                                                                                                                                                            | Ubuntu result                                                                            |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Endpoint kind and naming                  | `endpoint.test.ts`: short Linux and Darwin socket paths, Windows `\\?\\pipe\\` value, distinct concurrent endpoints, 24-hex runtime IDs, UTF-8 byte limit, exact boundary, deep/unsafe roots; `raw-net.test.ts`: native endpoint matrix boundary and endpoint byte-length boundary | **PASS** (9 endpoint tests; native Linux endpoint bound)                                 |
| Normal opaque round trip                  | `raw-net.test.ts`: `round-trips one opaque request and one response on the native endpoint`                                                                                                                                                                                        | **PASS**                                                                                 |
| Length-prefixed framing                   | `frame-codec.test.ts`: uint32 big-endian length, split headers/bodies, coalesced data, and exactly one frame; `raw-net.test.ts`: split/coalesced request exchange                                                                                                                  | **PASS**                                                                                 |
| One operation per connection              | `raw-net.test.ts`: closes after one operation, resolves before peer half-close, force-closes a peer that stays open, and closes on trailing request bytes                                                                                                                          | **PASS**                                                                                 |
| Input limits and validation               | `frame-codec.test.ts`: oversized declaration before body allocation, encode limit, truncated frame, trailing bytes, malformed chunks; `raw-net.test.ts`: malformed/truncated/trailing/oversized request before handler invocation                                                  | **PASS**                                                                                 |
| Response limits and validation            | `raw-net.test.ts`: malformed/truncated/trailing/oversized response cases                                                                                                                                                                                                           | **PASS**                                                                                 |
| Connect deadline and unavailable endpoint | `raw-net.test.ts`: unavailable endpoint and deterministic never-connect fake socket                                                                                                                                                                                                | **PASS**                                                                                 |
| Write deadline and backpressure           | `raw-net.test.ts`: fake drain deadline and real bounded 256 KiB request/response backpressure                                                                                                                                                                                      | **PASS**                                                                                 |
| Read deadline                             | `raw-net.test.ts`: peer never responds and slow-drip response that defeats an idle-only timeout                                                                                                                                                                                    | **PASS**                                                                                 |
| Caller cancellation                       | `raw-net.test.ts`: aborts an in-flight request and destroys the underlying socket; `test-helpers.test.ts`: abort races and already-aborted operations                                                                                                                              | **PASS**                                                                                 |
| Concurrency and association               | `raw-net.test.ts`: six concurrent clients preserve response/request association                                                                                                                                                                                                    | **PASS**                                                                                 |
| Bind/close lifecycle                      | `raw-net.test.ts`: rechecks sockets during shutdown, waits for forced socket close, serializes bind with close, rejects post-shutdown requests, and releases active sockets                                                                                                        | **PASS**                                                                                 |
| Child-process cleanup and diagnostics     | `test-helpers.test.ts`: bounded terminate/escalate/close, null close state, reused child generations, late errors, bounded output; `raw-net.process.test.ts`: abrupt child termination, diagnostics, and cleanup                                                                   | **PASS**                                                                                 |
| POSIX stale endpoint safety               | `raw-net.process.test.ts`: safely probes an abrupt stale socket, preserves a live listener, rejects unowned roots, and refuses non-socket unlink                                                                                                                                   | **PASS** on Linux; macOS unavailable                                                     |
| Windows cleanup boundary                  | `raw-net.test.ts` and `raw-net.process.test.ts`: explicit native-only Windows named-pipe limitations                                                                                                                                                                               | **PASS as an explicit limitation assertion** on Linux; native Windows result unavailable |

The raw run totals are stable across runs 1, 2, and 3: endpoint 9, frame codec
8, raw lifecycle 22, raw unit 4, process lifecycle 5, and helper lifecycle 22,
for 70 passing tests in 6 files.

## HTTP comparison acceptance matrix

| Acceptance area                       | Exact evidence covered by `http-candidate.test.ts`                                                                                                                                                             | Ubuntu result                                                                        |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Native one-operation request/response | `round-trips one request and one response over the native POSIX endpoint`                                                                                                                                      | **PASS**                                                                             |
| Request and response body limits      | `rejects an oversized request before invoking the handler`, `rejects an oversized response without retaining an unbounded body`, and `bounds raw HTTP response capture`                                        | **PASS**                                                                             |
| Write and close bounds                | `bounds server response writes and completes resource cleanup`, `bounds close by the caller deadline and preserves a failed close`                                                                             | **PASS**                                                                             |
| Connect/write/read deadlines          | `applies finite connect, write, and read phase deadlines`                                                                                                                                                      | **PASS**                                                                             |
| Caller cancellation                   | `destroys the request when the caller aborts`                                                                                                                                                                  | **PASS**                                                                             |
| HTTP parser/framing                   | `handles split HTTP headers/body and rejects malformed HTTP through the parser`; chunked input is sent in separate writes and truncated `Content-Length` does not invoke the handler                           | **PASS**                                                                             |
| Concurrent one-operation requests     | `supports concurrent one-operation requests and preserves response association`                                                                                                                                | **PASS**                                                                             |
| Keep-alive and endpoint cleanup       | `closes the HTTP server, disables keep-alive, and removes its POSIX socket`; its Windows branch asserts the named-pipe limitation; this also exercises an abrupt child and stale socket recovery               | **PASS**                                                                             |
| Endpoint replacement safety           | `recovers an unchanged moved regular-file replacement without following it` and corresponding symlink case; each Windows branch asserts the named-pipe limitation instead of running POSIX replacement cleanup | **PASS**                                                                             |
| Windows endpoint limitation           | `represents Windows named pipes explicitly even when this run is not Windows`                                                                                                                                  | **PASS as an explicit limitation assertion**; native Windows HTTP result unavailable |

The canonical HTTP run files `http-run-1.txt`, `http-run-2.txt`, and `http-run-3.txt`
each record 14 passing tests in one file. The fixture's focused report also records that no
slow-drip response peer was exercised for HTTP; therefore no HTTP slow-drip result is claimed.

## Repeated-run cleanup evidence

The canonical test records are `raw-run-1.txt`, `raw-run-2.txt`, and `raw-run-3.txt`
for raw (70 tests each), plus `http-run-1.txt`, `http-run-2.txt`, and `http-run-3.txt`
for HTTP (14 tests each). `cleanup-baseline-delta.txt` is a separate cleanup inventory
captured around the third pair; it runs the raw command and then the HTTP command
with a pre-run and post-run inventory of:

- POSIX socket files (`/tmp/p2p-*.sock`);
- named-pipe placeholders (none can exist on this Linux runner);
- `/tmp/p2p-*` temporary directories; and
- child processes matching the fixture's `raw-net-child` or stale-server
  helpers.

The baseline contained 3 socket files, 11 temporary directories, and 0 fixture
children. The post-run-minus-pre-run delta and the reverse delta were empty;
both focused commands exited `0`, and the recorded `CLEANUP_COMMAND_EXIT_STATUS`
and `EXIT_STATUS` are `0`. This proves that the repeated runs introduced no new
owned endpoint, quarantine file, temporary directory, or helper process. The
pre-existing baseline entries were deliberately left untouched because the
fixture must never blindly unlink an arbitrary path.

The raw and HTTP tests additionally assert owned POSIX endpoint removal after
normal close, stale socket quarantine/restore behavior, active socket drain,
and child close observation. Windows pipe cleanup cannot be inferred from this
Ubuntu inventory and remains a required native Windows run.

## Evidence status

- Ubuntu/Linux raw candidate: **PASS** — `raw-run-1.txt`, `raw-run-2.txt`, and
  `raw-run-3.txt` each contain all 70 passing scenarios.
- Ubuntu/Linux HTTP candidate: **PASS** — `http-run-1.txt`, `http-run-2.txt`, and
  `http-run-3.txt` each contain all 14 passing scenarios.
- Ubuntu/Linux repeated cleanup delta: **PASS** — `cleanup-baseline-delta.txt` records
  no new artifacts or fixture children.
- macOS raw/HTTP/cleanup: **UNAVAILABLE**, native runner required; no pass
  claimed.
- Windows raw/HTTP/cleanup: **UNAVAILABLE**, native named-pipe runner required;
  no pass claimed.
