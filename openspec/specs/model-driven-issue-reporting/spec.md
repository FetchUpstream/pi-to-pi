## Purpose

Define bounded model-driven reporting of suspected Pi-to-Pi defects to the fixed upstream repository.

## Requirements

### Requirement: Pi-to-Pi SHALL provide a fixed-destination issue reporter
The reporting service SHALL create or locate issues only in `FetchUpstream/pi-to-pi`. Its public report input SHALL accept a title, description, optional expected/actual observations, and optional Pi-to-Pi correlation identifiers, but SHALL NOT accept a repository, owner, labels, assignees, arbitrary GitHub endpoint, or GitHub operation.

#### Scenario: The model reports a transport failure
- **WHEN** the tool submits a valid report with operation `transport` and a request ID
- **THEN** the reporter targets only `FetchUpstream/pi-to-pi` and uses the correlation identifier to collect automatic diagnostics

### Requirement: Reporting SHALL distinguish untrusted narrative from automatic evidence
A created issue SHALL contain separate Agent report, Expected, Actual, Automatically collected Pi-to-Pi diagnostics, Recent Pi-to-Pi diagnostic events, and Sanitization sections. Model-provided fields SHALL be labeled as untrusted narrative and SHALL be bounded and validated before submission; automatic diagnostics SHALL remain structured allowlisted observations.

#### Scenario: A report is created
- **WHEN** GitHub accepts a new report
- **THEN** the issue body separates model observations from automatic evidence and states that sensitive conversation and credential data were not attached automatically

### Requirement: Reporter results SHALL be explicit and best-effort
The reporting service SHALL return exactly one bounded result with status `created`, `existing`, `unavailable`, or `failed`, plus an issue number and URL for created/existing results when available. Missing authentication, unavailable `gh`, GitHub failure, and duplicate-search failure SHALL NOT throw into or mutate Pi-to-Pi communication state.

#### Scenario: Local GitHub authentication is unavailable
- **WHEN** no supported authenticated local reporting source is available
- **THEN** the tool returns an `unavailable` result with a bounded reason and active Pi-to-Pi tasks continue unchanged

### Requirement: Reporter SHALL deduplicate structurally equivalent open defects
Before creating an issue, the reporter SHALL generate a SHA-256 fingerprint from non-sensitive stable diagnostic attributes and search open issues in the fixed repository for its marker. New issues SHALL include `<!-- p2p-fingerprint: <hash> -->`; a matching open issue SHALL return `existing` rather than create a duplicate.

#### Scenario: A matching issue is already open
- **WHEN** a report has the same structural fingerprint as an open fixed-repository issue
- **THEN** the reporter returns that issue number and URL with status `existing` and does not create another issue

#### Scenario: A new structural defect is reported
- **WHEN** no open issue has the computed fingerprint
- **THEN** the reporter creates one issue with the fingerprint marker and returns status `created`
