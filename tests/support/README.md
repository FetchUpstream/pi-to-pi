# Reusable test support

Reusable process-test helpers live under `tests/support/`; portable child fixtures live under
`tests/fixtures/`. Keeping both boundaries below `tests/` prevents the harness from becoming a
runtime or protocol dependency.

## Imports

Tests in `tests/process/` and future tests in `tests/integration/` should import the public support
barrel:

```ts
import {
  createManagedProcess,
  createManagedProcessGroup,
  waitFor,
  withTestWorkspace,
} from '../support/index.js';
```

The barrel exposes workspace, bounded-wait, output/JSON-lines, and managed-process helpers. The
support modules do not import protocol, registry, transport, routing, or Pi implementation code;
later tests can therefore reuse them without importing the final wire protocol. Tests that verify a
support module itself may import that module directly from the same directory.

## Fixture control and cleanup

- Launch fixtures with `createManagedProcess` or `createManagedProcessGroup`; use the default
  `LIFECYCLE_FIXTURE_PATH` or pass an absolute path below `tests/fixtures/`.
- Control a fixture with one JSON object per stdin line. Wait for its `ready` event before sending
  commands, and use lifecycle commands such as `shutdown`, `hang`, or `diagnostic` rather than
  fixed sleeps.
- Wrap each test in `withTestWorkspace` (or explicitly call `createTestWorkspace` and
  `workspace.cleanup()`), pass the workspace to every managed child, and await `waitForClose()` in
  the test's normal path. The workspace cleanup hook terminates any remaining children before
  removing temporary runtime and room paths.
- Keep cleanup in a `finally` path when a test owns a process directly. Repeated cleanup and
  `killAbruptly()` calls are expected to be safe; do not remove a workspace while a child is still
  running.

Workspace cleanup is bounded and retries transient filesystem failures, including Windows file
locks. A failed owner cleanup leaves the workspace in place so the child-termination diagnostic is
not hidden; retry the cleanup after the owner has released its resources.

## Bounded diagnostics

Managed children capture stdout and stderr independently with fixed retention limits. Readiness,
exit, timeout, spawn, and JSON-lines failures include the process label/PID, lifecycle state, exit
code or signal, and retained output. Fixture diagnostics must remain bounded; use the output helper
instead of accumulating unbounded child output in a test.

## Node harness versus real Pi integration

The mandatory process suite uses standalone Node `.mjs` fixtures and the harness-only JSON-lines
lifecycle controls. It must run on a clean CI worker without a globally running daemon, provider
credentials, network service, TTY, or interactive Pi session. These tests validate process startup,
readiness, command delivery, timeout handling, abrupt termination, diagnostics, and cleanup only.

Tests that exercise a real Pi process or a composed protocol/registry/transport/Pi integration are a
separate future integration layer under `tests/integration/`. Real-Pi coverage is intentionally not a
requirement of the Node harness and must not change the fixture control protocol into the eventual
Pi-to-Pi wire protocol.
