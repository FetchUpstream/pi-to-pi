## Context

The repository is a TypeScript Pi extension scaffold with a single bootstrap unit test. The source boundaries for protocol, discovery, transport, routing, and Pi integration are present but intentionally empty. The existing Vitest configuration already discovers `tests/**/*.test.ts`, while no CI workflow or reusable process-test support exists.

Issue #8 needs a test foundation that can exercise lifecycle behavior on Linux, macOS, and Windows before later work implements sockets, named pipes, leases, routing, and Pi integration. The harness must remain useful while those protocol details are still changing.

## Goals / Non-Goals

**Goals:**

- Run the repository validation suite on Linux, macOS, and Windows with supported Node.js.
- Provide isolated temporary workspaces and room/runtime identifiers for each test.
- Launch multiple independent Node fixture processes without a shell or globally running service.
- Observe readiness and clean exits, capture bounded diagnostics, enforce deadlines, terminate hung processes, and clean all resources.
- Make concurrent fixture startup deterministic through explicit readiness events rather than sleeps.
- Keep the harness independent of the eventual Pi-to-Pi wire framing and registry schema.

**Non-Goals:**

- Implement Pi-to-Pi protocol, discovery, transport, lease, routing, or Pi UI behavior.
- Use the interactive `pi` CLI as the mandatory smoke-test process.
- Add a daemon, broker, database, network service, or runtime dependency.
- Validate real Pi session lifecycle behavior; that belongs to a later Pi integration change.
- Implement duplicate or malformed final-protocol frames now; the harness only needs extension points for later tests.

## Decisions

### Use pure Node fixtures for the mandatory process suite

Process tests SHALL spawn portable Node fixtures rather than real interactive Pi sessions. Fixtures can start, emit readiness, accept control commands, hang, and exit without provider credentials, TTYs, Pi configuration, or model traffic. Real Pi-process tests can be added later as a separate integration layer once the extension has behavior to exercise.

**Alternatives considered:**

- **Real Pi CLI processes:** higher integration fidelity, but slower, more environment-sensitive, coupled to Pi CLI versions, and not meaningful while the extension is still a no-op scaffold.
- **In-process mocks:** faster, but do not exercise OS process boundaries, stdio, termination, or cleanup.

### Use a harness-only JSON-lines fixture protocol

Fixtures SHALL communicate lifecycle events and control commands using line-delimited JSON over stdin/stdout. Events such as `ready`, `log`, and `exited` give tests a stable observable contract. This protocol is test infrastructure only and MUST NOT become the Pi-to-Pi wire protocol.

The parent SHALL capture stdout and stderr independently, parse complete lines with CRLF tolerance, retain bounded output, and include captured diagnostics in failures.

**Alternatives considered:**

- **Fixed sleeps:** nondeterministic and slow under CI load.
- **OS-specific IPC for fixture control:** unnecessarily couples the harness to the transport under test.
- **Launching TypeScript directly:** depends on Node version-specific type stripping; portable `.mjs` fixtures avoid that coupling.

### Use a managed process abstraction with explicit cleanup

A managed child process SHALL be created with Node's `child_process.spawn`, `process.execPath`, an absolute fixture path, and `shell: false`. It SHALL expose readiness waiting, command sending, exit waiting, bounded output, and an OS-independent `killAbruptly()` operation.

Each test SHALL create a unique temporary workspace under the operating system temp directory. Workspace cleanup SHALL run in `finally`/fixture teardown after all child processes have been awaited or terminated. Windows cleanup SHALL tolerate transient file locks with bounded retries.

**Alternatives considered:**

- **Third-party process libraries:** useful abstractions, but unnecessary for this package and would add dependency/install surface to the test foundation.
- **Global process signal handlers:** can interfere with Vitest and other tests; cleanup remains owned by each harness instance with optional suite-level fallback.

### Normalize process termination without hiding outcomes

`killAbruptly()` SHALL use direct process signaling on POSIX and `taskkill /F /T /PID` on Windows when terminating a process tree. The harness SHALL preserve the observed exit code, signal, spawn error, stdout, and stderr so tests can distinguish an expected abrupt termination from an unexpected failure.

A timeout SHALL first collect diagnostic state, then terminate the affected process tree, await closure, clean the workspace, and report a bounded-timeout error. The timeout test will assert the rejection, so CI remains green while proving a hung child cannot hang the suite.

### Keep waiting helpers generic

Endpoint and lease helpers SHALL accept an injected asynchronous predicate/reader and a timeout rather than importing a future registry or transport schema. They may use bounded polling with a small backoff, but SHALL not rely on fixed sleeps. This allows later registry, endpoint, and lease implementations to reuse the same helpers.

### Run one cross-platform CI matrix

GitHub Actions SHALL run on `ubuntu-latest`, `macos-latest`, and `windows-latest`, install the declared Node 22.x runtime, use `npm ci`, and run formatting, linting, type checking, unit/integration/process tests, and the build. The workflow SHALL run for pull requests and pushes to `main` and SHALL not require credentials or services outside the repository.

The existing formatting command currently checks internal `.pi/` workflow documentation that is not package source. The package formatting scope SHALL exclude `.pi/` so the baseline validation command can pass without unrelated documentation churn.

## Risks / Trade-offs

- **[Risk]** Process startup and filesystem behavior differ across operating systems. → Use explicit readiness events, unique temp paths, bounded polling, and run the same process tests on all three CI platforms.
- **[Risk]** Windows may retain handles briefly after child exit. → Await `close`, retry workspace removal with a bounded limit, and report remaining paths on failure.
- **[Risk]** A fixture can emit unbounded output or never close stdio. → Bound retained output, enforce deadlines, and terminate the process tree during teardown.
- **[Risk]** `taskkill` behavior differs from POSIX signals. → Keep the kill implementation platform-specific behind one API and assert only normalized lifecycle guarantees in shared tests.
- **[Risk]** Pure Node fixtures may miss Pi integration regressions. → Track real Pi lifecycle tests as a later change rather than weakening the deterministic foundation.
- **[Risk]** CI runtime increases with three operating systems. → Keep fixtures small, avoid provider/network work, and use one matrix job with cached npm dependencies where supported.
- **[Risk]** Excluding `.pi/` from formatting hides documentation formatting issues. → Keep `.pi/` covered by its own workflow/tooling validation if that becomes necessary; it is not package source validation.

## Migration Plan

This is an additive test-infrastructure change with no production data or protocol migration. Add the harness and fixtures first, then add the process tests, then add the CI matrix. Existing unit tests remain in place. If CI rollout exposes unrelated platform failures, the workflow can be reverted without affecting runtime code; the harness itself remains available for later implementation work.

## Open Questions

No blocking design questions remain. Real Pi-process coverage, raw final-protocol frame injection, and broader Node-version matrices are intentionally deferred to later changes.
