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

Every fixture belongs to a test workspace. Create the workspace with `withTestWorkspace` (or call
`workspace.cleanup()` explicitly), pass it to `createManagedProcess`/`createManagedProcessGroup`,
and let workspace cleanup terminate remaining children before removing runtime and room paths.
Tests that own a process directly should keep cleanup in `finally`; repeated cleanup and
`killAbruptly()` calls must be safe. Workspace removal uses bounded retries for transient failures,
including Windows file locks, and a failed owner cleanup leaves the workspace for a retry instead of
hiding a live child.

## Diagnostics

The managed helpers retain bounded stdout and stderr separately. Readiness, exit, timeout, spawn,
and parse failures include the fixture identity, state, exit code or signal, and retained output;
fixture tests must not accumulate unbounded output or use fixed sleeps in place of lifecycle events.

These fixtures support the mandatory Node harness suite only. Future real-Pi lifecycle tests are a
separate integration concern under `tests/integration/` and must not be confused with, or required
by, the portable fixtures.
