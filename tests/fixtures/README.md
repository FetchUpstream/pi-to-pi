# Portable test fixtures

Fixtures in this directory are standalone Node programs used to exercise OS process boundaries.
They are test infrastructure, not package or Pi-to-Pi implementation modules.

## Control convention

- A parent launches a fixture with `process.execPath`, an absolute fixture path, `shell: false`, and
  piped stdin/stdout/stderr.
- The parent waits for a JSON-lines `ready` event before sending commands. Commands are one JSON
  object per stdin line; the lifecycle fixture supports `shutdown`, `hang`, and `diagnostic` (with
  stdout or stderr selection), plus line-ending controls used by parser tests.
- Lifecycle events are JSON lines on stdout. Diagnostic output is intentionally observable on each
  stream independently, and `--crlf`/the corresponding environment setting exercises CRLF parsing.
- Fixture commands and events describe process lifecycle only. They MUST NOT become the final
  Pi-to-Pi wire protocol or import protocol, registry, transport, routing, or Pi implementation
  modules.

Fixtures must be deterministic, local, and small: they do not require a daemon, provider
credentials, network service, TTY, or interactive Pi session. A fixture may deliberately remain
alive for a bounded-timeout test, but the parent remains responsible for terminating it.

## Ownership and cleanup

Process tests should use the managed helpers exported from `tests/support/index.ts` rather than
reimplementing child-process control. From a test in `tests/process/` or `tests/integration/`, use
`../support/index.js`; the managed process default points at `LIFECYCLE_FIXTURE_PATH`.

Managed-harness consumers should give each managed child or group a test workspace. Create the
workspace with `withTestWorkspace` (or call `workspace.cleanup()` explicitly), pass it to
`createManagedProcess` for an individual child or to `createManagedProcessGroup` for a group, and
let workspace cleanup terminate remaining children before removing runtime and room paths. Group-spawned children inherit the group's workspace
environment/configuration without registering child cleanup hooks; the group remains the sole cleanup owner.
The standalone `tests/fixtures/lifecycle.test.ts` is a direct-fixture test exception: it launches
`lifecycle.mjs` with Node's `spawn` and owns shutdown/cleanup itself in `finally`.
Tests that own a process directly should keep cleanup in `finally`; repeated cleanup and
`killAbruptly()` calls must be safe. Workspace removal uses bounded retries for transient failures,
including Windows file locks, and a failed owner cleanup leaves the workspace for a retry instead of
hiding a live child.

## Diagnostics

The managed helpers retain bounded stdout and stderr separately. Managed-child lifecycle diagnostics for
readiness, exit, timeout, and spawn failures include the fixture identity, lifecycle state, exit code or
signal, and retained output. A `JsonLinesParseError` from a managed child exposes its process identity,
line details, and bounded output, but does not carry lifecycle state or exit code/signal; use the managed
child's diagnostics for those fields.
Managed harness tests must await lifecycle events instead of using fixed sleeps. The direct fixture tests
in `tests/fixtures/lifecycle.test.ts` are separate: they use Node's `spawn`, and the queued-command test
intentionally waits 25 ms after `exited` before asserting that no later diagnostic event ran.

These fixtures support the mandatory Node harness suite only. Future real-Pi lifecycle tests are a
separate integration concern under `tests/integration/` and must not be confused with, or required
by, the portable fixtures.
