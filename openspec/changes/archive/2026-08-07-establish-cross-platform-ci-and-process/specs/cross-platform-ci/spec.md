## ADDED Requirements

### Requirement: CI SHALL validate the package on all supported desktop operating systems

The repository SHALL provide a GitHub Actions workflow that runs the standard validation suite on Linux, macOS, and Windows using Node.js 22.x.

#### Scenario: Pull request validation runs on every target operating system

- **WHEN** a pull request is opened, synchronized, or reopened
- **THEN** CI runs the repository validation job on `ubuntu-latest`, `macos-latest`, and `windows-latest`

#### Scenario: Main branch validation runs on every target operating system

- **WHEN** a commit is pushed to `main`
- **THEN** CI runs the same validation matrix on all three target operating systems

### Requirement: CI SHALL install and validate from a clean repository state

Each CI matrix job SHALL use a clean checkout, install dependencies with `npm ci`, and run formatting, linting, type checking, tests, and the package build without relying on a globally installed daemon, service, provider, or Pi session.

#### Scenario: Clean install reproduces the locked dependency graph

- **WHEN** a matrix job starts from a clean checkout
- **THEN** `npm ci` completes using the committed lockfile before validation begins

#### Scenario: Repository validation completes without external services

- **WHEN** the CI validation commands run with no Pi provider credentials or globally running service
- **THEN** formatting, linting, type checking, unit/integration/process tests, and build use only repository code and declared dependencies

### Requirement: CI SHALL report actionable failures

A failed matrix job SHALL preserve the command failure and expose the relevant test output, including managed child-process diagnostics when process tests fail.

#### Scenario: A process test fails

- **WHEN** a process-level test fails on any target operating system
- **THEN** the CI log contains the failing test name and the harness-captured stdout/stderr or timeout diagnostics

#### Scenario: A matrix operating system fails

- **WHEN** validation fails on one operating system
- **THEN** that matrix leg is marked failed without suppressing the failure from the pull request result

### Requirement: Package formatting validation SHALL exclude internal workflow documentation

The package formatting check SHALL validate package source, tests, configuration, and workflow files without requiring the internal `.pi/` prompt and skill documentation to be reformatted as application code.

#### Scenario: Existing package validation runs locally

- **WHEN** a contributor runs the standard repository check from the current scaffold
- **THEN** the formatting step does not fail solely because internal `.pi/` documentation is not Prettier-formatted
