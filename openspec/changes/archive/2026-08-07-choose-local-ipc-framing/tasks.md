## 1. Build the isolated spike harness

- [x] 1.1 Add an isolated spike fixture area and scripts that do not import or modify the production `src/` transport boundary.
- [x] 1.2 Implement platform-aware endpoint generation for POSIX socket paths and Windows named pipes, including a UTF-8 byte-length guard and unique runtime identifiers.
- [x] 1.3 Implement the four-byte big-endian frame encoder and bounded incremental decoder used by the raw `node:net` candidate.
- [x] 1.4 Add bounded test helpers for absolute phase deadlines, abort signals, child-process cleanup, and diagnostic error capture.

## 2. Exercise the `node:net` candidate

- [x] 2.1 Prove a normal one-request/one-response round trip over a Unix socket on Linux and macOS and a named pipe on Windows.
- [x] 2.2 Test split headers/bodies, coalesced data, concurrent clients, response ordering, and connection closure after one operation.
- [x] 2.3 Test malformed, truncated, trailing, and oversized frames, verifying rejection before unbounded body allocation or handler invocation.
- [x] 2.4 Test unavailable endpoints, connect/write/read deadlines, slow-drip reads, caller cancellation, and write backpressure.
- [x] 2.5 Test clean shutdown, abrupt process termination, POSIX stale endpoint behavior, endpoint-length boundaries, and Windows pipe cleanup.

## 3. Compare HTTP over local IPC

- [x] 3.1 Add a throwaway HTTP client/server candidate using platform-appropriate local endpoint values and one operation per connection.
- [x] 3.2 Apply equivalent body-size, deadline, abort, cleanup, and concurrent-request tests to the HTTP candidate where the platform supports it.
- [x] 3.3 Record HTTP-specific startup, framing, parser, keep-alive, debugging, dependency, and Windows named-pipe observations.

## 4. Run the cross-platform evidence matrix

- [x] 4.1 Define a reproducible command for the spike on Ubuntu, macOS, and Windows using the declared Node minimum (`22.19.0` or later).
- [x] 4.2 Run the raw `node:net` suite on all three platforms and preserve pass/fail output for every acceptance scenario.
- [x] 4.3 Run the HTTP comparison suite on all available platforms, explicitly recording any platform-specific limitation rather than silently skipping it.
- [x] 4.4 Confirm repeated runs leave no socket files, named-pipe artifacts, temporary directories, or child processes behind.

## 5. Record and validate the decision

- [x] 5.1 Write the ADR/design report with the selected length-prefixed `node:net` approach, rejected HTTP alternative, evidence table, endpoint strategy, transport interface, limits, and known limitations.
- [x] 5.2 Record finite frame, connect, write, and read test defaults and explain how future production configuration may override them.
- [x] 5.3 Run the repository's relevant formatting, lint, typecheck, and test commands, distinguishing pre-existing scaffold failures from spike failures.
- [x] 5.4 Verify the spike remains isolated from Pi message/task semantics and that no production messaging layer, broker, daemon, or external service was introduced.
