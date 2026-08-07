## Why

The repository currently has only a single bootstrap unit test and no automated validation across operating systems. Pi-to-Pi will depend on local process lifecycle, temporary runtime state, Unix sockets, and Windows named pipes, so regressions in startup, shutdown, timeouts, or cleanup could otherwise remain invisible until later protocol work.

This change establishes a deterministic testing foundation now, before discovery, transport, and routing implementations depend on it.

## What Changes

- Add continuous integration for Linux, macOS, and Windows.
- Add reusable unit and integration test support for isolated temporary runtime state and rooms.
- Add a cross-platform process harness for launching and coordinating multiple independent Node test fixtures.
- Add deterministic helpers for readiness, endpoint/lease waiting, bounded timeouts, output capture, abrupt termination, concurrent peer startup, and cleanup.
- Add smoke coverage for two independent child processes starting and exiting cleanly.
- Add coverage proving hung children fail within bounded time and are cleaned up.
- Keep fixture control and harness behavior independent from the eventual Pi-to-Pi wire protocol.
- Keep the mandatory process tests independent of a globally installed daemon, service, provider, or interactive Pi session.

## Capabilities

### New Capabilities

- `cross-platform-ci`: Automated repository validation on Linux, macOS, and Windows with the supported Node.js runtime.
- `process-test-harness`: Reusable isolated test workspaces, child-process lifecycle control, bounded waiting, output capture, abrupt termination, concurrent fixture startup, and cleanup guarantees.

### Modified Capabilities

- None.

## Impact

- Adds GitHub Actions workflow configuration.
- Extends the `tests/` structure with harness support, portable Node fixtures, integration helpers, and process-level tests.
- May adjust package formatting checks so internal `.pi/` workflow documentation does not make the existing validation command fail.
- Uses existing TypeScript, Vitest, and Node.js built-ins; no runtime dependency or Pi-to-Pi protocol API is introduced.
- Establishes test contracts that later registry, transport, protocol, and Pi integration changes can reuse.
