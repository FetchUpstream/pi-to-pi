## 1. Make the existing validation baseline CI-ready

- [x] 1.1 Exclude internal `.pi/` prompt and skill documentation from the package Prettier check without excluding source, tests, configuration, or workflow files.
- [x] 1.2 Add a GitHub Actions workflow triggered by pull requests and pushes to `main` with Ubuntu, macOS, and Windows Node 22.x matrix jobs.
- [x] 1.3 Configure each matrix job to run `npm ci`, the standard check suite, and the package build without external services or credentials.
- [x] 1.4 Configure failed process-test jobs to retain actionable child-process diagnostics in CI logs and upload available test artifacts on failure.

## 2. Build isolated test-support primitives

- [x] 2.1 Add a test workspace helper that creates unique temporary runtime/room paths and removes them with bounded retries, including Windows file-lock handling.
- [x] 2.2 Add bounded asynchronous wait helpers with default deadlines, per-call overrides, abort/timeout cleanup, and injected predicates for future endpoint and lease checks.
- [x] 2.3 Add bounded stdout/stderr collection and CRLF-tolerant JSON-lines event parsing with useful process identity and output diagnostics.

## 3. Add the portable child-process harness

- [x] 3.1 Add a portable `.mjs` Node fixture that emits readiness, accepts JSON-lines lifecycle commands, supports clean shutdown and deliberate hanging, and can emit diagnostic output.
- [x] 3.2 Implement a managed process abstraction using `process.execPath`, absolute fixture paths, `shell: false`, piped stdio, readiness waits, command delivery, and exit/close observation.
- [x] 3.3 Implement idempotent `killAbruptly()` behavior using direct POSIX termination and Windows process-tree termination, preserving exit code, signal, spawn error, and captured output.
- [x] 3.4 Ensure timeout and teardown paths terminate all managed children before removing their workspace and do not leave active timers, polling loops, or persistent artifacts.

## 4. Prove the harness acceptance cases

- [x] 4.1 Add a process smoke test that starts two independent fixtures concurrently, observes distinct readiness events, requests clean shutdown, and verifies both exit successfully.
- [x] 4.2 Add a bounded-timeout test for a deliberately hung fixture that asserts the expected rejection, captures diagnostics, terminates the child, and verifies cleanup.
- [x] 4.3 Add abrupt-termination coverage that verifies the portable kill helper on each operating system and remains safe when teardown repeats it.
- [x] 4.4 Add concurrent fixture and diagnostic assertions covering unique workspaces, independent stdout/stderr, CRLF event parsing, and no dependency on a global daemon.

## 5. Integrate and document the reusable support

- [x] 5.1 Keep process helpers and fixtures under the established `tests/` boundaries so later protocol, registry, transport, and Pi tests can import them without importing final protocol code.
- [x] 5.2 Update test-directory documentation with fixture control conventions, cleanup expectations, and the distinction between Node harness tests and future real-Pi integration tests.
- [ ] 5.3 Run formatting, linting, type checking, unit/integration/process tests, and build locally; resolve Linux, macOS, and Windows-specific failures surfaced by CI.
