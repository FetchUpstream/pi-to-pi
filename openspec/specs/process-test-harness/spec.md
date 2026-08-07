# Process Test Harness

## Purpose

TBD: Provide deterministic, isolated, cross-platform process lifecycle support for repository tests without coupling fixtures to the final Pi-to-Pi protocol.

## Requirements

### Requirement: Tests SHALL receive isolated temporary runtime workspaces

The test support layer SHALL create a unique temporary workspace for each test or fixture group and SHALL expose isolated runtime and room identifiers without mutating global process state.

#### Scenario: A test creates a workspace

- **WHEN** a test requests a workspace
- **THEN** the harness creates unique temporary paths and environment/configuration values for that test

#### Scenario: A test finishes normally

- **WHEN** the test completes successfully
- **THEN** all child processes, temporary files, sockets, named-pipe references, and workspace directories owned by the harness are removed

#### Scenario: A test fails

- **WHEN** an assertion or child process failure interrupts a test
- **THEN** teardown still attempts bounded child termination and workspace cleanup before reporting the failure

### Requirement: The harness SHALL launch and observe independent Node processes

The harness SHALL launch portable Node fixtures with `process.execPath` and no shell, capture stdout and stderr independently, and expose readiness and exit observations for each child.

#### Scenario: Two fixtures start concurrently

- **WHEN** a test launches two independent fixtures
- **THEN** both processes are started without a fixed sleep and the test can await a distinct readiness event from each process

#### Scenario: A fixture exits cleanly

- **WHEN** the parent sends the fixture's shutdown command
- **THEN** the harness observes closed stdio and exit code `0` for that fixture

#### Scenario: A fixture fails during startup

- **WHEN** a fixture exits or emits a spawn error before readiness
- **THEN** the readiness wait fails with the child identity and captured diagnostics

### Requirement: The harness SHALL provide bounded asynchronous waiting

The test support layer SHALL provide generic predicate-based waits for readiness, endpoints, leases, and other eventual conditions. Every wait SHALL have a default deadline with a per-call override and SHALL fail deterministically when the deadline expires.

#### Scenario: An eventual condition becomes true

- **WHEN** an injected asynchronous predicate reports success before its deadline
- **THEN** the wait resolves without relying on a fixed sleep duration

#### Scenario: A condition never becomes true

- **WHEN** an injected asynchronous predicate remains false until its deadline
- **THEN** the wait rejects with a descriptive timeout and does not leave an active timer or polling loop

#### Scenario: A child remains hung

- **WHEN** a process test waits for a hung child beyond its deadline
- **THEN** the harness reports a bounded-timeout failure, captures diagnostics, terminates the child, and completes teardown

### Requirement: The harness SHALL support abrupt process termination

The harness SHALL expose an OS-independent abrupt-termination operation that terminates a child and its descendants where supported, preserves the observed exit outcome, and remains safe to call during teardown.

#### Scenario: A POSIX child is terminated abruptly

- **WHEN** a test invokes abrupt termination for a running child on Linux or macOS
- **THEN** the child is forcefully terminated and the harness resolves after the process and stdio have closed

#### Scenario: A Windows child is terminated abruptly

- **WHEN** a test invokes abrupt termination for a running child on Windows
- **THEN** the harness forcefully terminates the process tree using the platform-appropriate mechanism and resolves after closure

#### Scenario: Abrupt termination is repeated

- **WHEN** teardown invokes abrupt termination for an already exited or previously terminated child
- **THEN** the operation is idempotent and does not mask the original test failure

### Requirement: Fixture control SHALL remain independent of the final Pi-to-Pi protocol

Portable fixtures and their JSON-lines control events SHALL exercise process lifecycle behavior only. The harness SHALL expose generic hooks for later endpoint, lease, duplicate, or malformed-frame tests without embedding the final wire schema.

#### Scenario: A lifecycle smoke test runs before protocol implementation

- **WHEN** the process harness runs against the current extension scaffold
- **THEN** the test can verify process startup, readiness, shutdown, timeout, and cleanup without importing protocol or transport implementation modules

#### Scenario: A later protocol test needs custom observation

- **WHEN** a later test supplies an endpoint/lease reader or raw-operation callback
- **THEN** the generic wait and process helpers can coordinate it without changing the harness's fixture lifecycle contract

### Requirement: Harness diagnostics SHALL be bounded and useful

The harness SHALL retain bounded stdout and stderr for every managed child, tolerate platform line endings, and include process identity, exit state, timeout context, and retained output in failure messages.

#### Scenario: A child writes diagnostic output

- **WHEN** a managed child emits stdout or stderr
- **THEN** the harness makes the output available to assertions and failure reporting without retaining unbounded data

#### Scenario: Output contains CRLF line endings

- **WHEN** a fixture emits Windows-style line endings
- **THEN** readiness and control events are parsed correctly

### Requirement: The process suite SHALL prove the core harness acceptance cases

The repository SHALL include process-level tests covering two-process startup and clean exit, bounded hung-child failure, abrupt termination support, and cleanup without a globally running service.

#### Scenario: Two independent processes start and exit

- **WHEN** the smoke test launches two fixtures, observes both readiness events, requests shutdown, and waits for both exits
- **THEN** both fixtures exit cleanly and the workspace is empty or removed

#### Scenario: A deliberately hung child is exercised

- **WHEN** the timeout test launches a fixture that remains alive beyond the configured deadline
- **THEN** the test observes the expected timeout rejection within a bounded duration and leaves no child or persistent runtime artifact

#### Scenario: The suite runs without a daemon

- **WHEN** the process suite runs on a clean CI worker
- **THEN** it creates all required resources within the test workspace and does not connect to or require a globally running service
