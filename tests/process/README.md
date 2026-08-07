# Process-level tests

This directory contains the mandatory cross-platform Node process-harness tests. The suite launches
standalone fixtures from `tests/fixtures/` rather than real Pi sessions, so it can run on a clean CI
worker without a daemon, provider credentials, network service, TTY, or interactive Pi session.

## Support imports

Process-level harness tests import reusable helpers from the public `../support/index.js` barrel:

```ts
import {
  createManagedProcess,
  createManagedProcessGroup,
  waitFor,
  withTestWorkspace,
} from '../support/index.js';
```

The helpers create isolated runtime/room workspaces, launch fixtures with `process.execPath` and
`shell: false`, wait for readiness/lifecycle events, send JSON-lines controls, and expose bounded
stdout/stderr diagnostics. They are generic test support and do not import final protocol, registry,
transport, routing, or Pi implementation code.

## Fixture and cleanup conventions

- Wait for `ready` before sending a command; coordinate concurrent children with readiness events,
  not fixed sleeps. The lifecycle fixture accepts `shutdown`, `hang`, and `diagnostic` commands.
- Wrap each test in `withTestWorkspace`; pass the workspace to each directly created managed child,
  or once to `createManagedProcessGroup`. Group-spawned children inherit the group's workspace
  environment/configuration without registering child cleanup hooks; the group remains the sole cleanup owner.
  Keep direct cleanup in `finally` when the test owns a process explicitly.
- Await clean `waitForClose()` results in the normal path. On failure or timeout, managed cleanup
  must terminate every child before workspace removal; repeated `cleanup()` and `killAbruptly()` are
  safe.
- Keep diagnostics bounded and separate: managed-child lifecycle failures retain process identity, state,
  exit code/signal, spawn errors, and bounded stdout/stderr. `JsonLinesParseError` retains process
  identity, line details, and bounded output, but not lifecycle state or exit code/signal; consult the
  managed child's diagnostics for those fields. Do not leave temporary workspaces, child processes,
  polling loops, or timers behind.

The portable fixture control protocol is lifecycle-only and must not become the eventual Pi-to-Pi
wire protocol. Future real-Pi process coverage is intentionally separate from this Node harness and
belongs under `tests/integration/` in a later integration change.
