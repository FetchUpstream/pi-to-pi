## Context

The P2P-013 production composition owns the active runtime's transport, discovery registry, router, and Pi adapter. PiAdapter currently registers four tools through a stable runtime-aware dispatcher. The runtime exposes useful IDs and state, but it has no body-free diagnostic event history or external reporting boundary.

The reporter must collect evidence while state is live without exposing request/reply bodies or credentials, and must not influence the request/reply/transport path when GitHub or authentication is unavailable.

## Goals / Non-Goals

**Goals:**

- Give the model one narrow `p2p_report_issue` action for suspected Pi-to-Pi defects.
- Construct bounded, allowlist-only runtime evidence and a causal event history.
- Submit or reuse issues only in `FetchUpstream/pi-to-pi` through a testable reporter abstraction.
- Return explicit created, existing, unavailable, or failed outcomes without throwing into communication behavior.

**Non-Goals:**

- Generic GitHub operations, configurable model-selected repositories, automatic error reporting, telemetry upload, retries, or background queues.
- Uploading message bodies, transcripts, prompts, arbitrary tool output, files, paths, environment values, or credentials.
- Changing protocol envelopes, Agent Cards, router delivery semantics, or task correctness.

## Decisions

### Runtime-local diagnostics service

`PiToPiRuntimeComposition` will own one diagnostic event buffer and snapshot provider and pass a narrow reporting facade to `PiAdapter`. The buffer is discarded at runtime shutdown, matching router and adapter ownership. Discovery, bridge/transport, router task transitions, and lifecycle/composition transitions record only typed allowlisted attributes.

A central `DiagnosticEventSink` is preferred over logging arbitrary runtime objects: it makes forbidden fields unrepresentable at call sites and permits deterministic ring-buffer tests.

### Allowlist-first snapshot and bounded narrative

Snapshots are built from explicit scalar fields: package/runtime/platform versions, timestamp, operation/error code, correlation IDs, room/runtime IDs, endpoint kind, Agent Card/lease state, router task direction/state, queue counts, lifecycle state, and bounded timings. Values are validated, normalized, and size-limited before formatting. The serializer never accepts a broad error, request, context, environment, or configuration object.

The model narrative is separately labeled untrusted input, has field and total-size limits, and is never reclassified as telemetry. Tool guidance directs the model not to include conversation content or secrets; implementation will also reject or bound unsafe/oversized text rather than attaching it silently.

### Fixed GitHub reporter behind an availability boundary

A `GitHubIssueReporter` receives an already formatted report and has no caller-provided repository, labels, assignees, endpoint, or operation. The initial implementation deliberately supports an existing authenticated `gh` CLI session using a small injectable command runner. Missing executable/authentication and command/API errors become bounded `unavailable` or `failed` results. No token is read into diagnostics or exposed in tool output.

Using `gh` avoids embedding a credential or adding an HTTP/auth dependency. A future explicit configured credential source can implement the same reporter interface without changing the tool contract.

### Structural deduplication before creation

A canonical serialization of non-sensitive, stable snapshot fields is SHA-256 hashed. The reporter searches open issues in the fixed repository for `<!-- p2p-fingerprint: <hash> -->` before creating a new issue. Existing matches return `existing`; creation writes the marker and clearly separate Agent report, expected/actual, automatic diagnostics, recent events, and sanitization sections. Model prose is excluded from the fingerprint so equivalent defects deduplicate despite different interpretations.

### Best-effort isolation

The adapter invokes reporting only from the explicit tool call. It does not invoke the reporter from router, bridge, or lifecycle operations. Event recording failures are swallowed locally, and reporter failures are represented in the tool result. No retries, blocking joins, or changes to active router state occur.

## Risks / Trade-offs

- [The `gh` CLI is absent or unauthenticated] → Return `unavailable` with a bounded reason; communication remains operational.
- [Agent narrative contains sensitive content] → Strong tool guidance plus bounded validation/rejection; automatic data remains allowlist-only.
- [Event instrumentation becomes too broad] → Use a closed event shape, field limits, and tests asserting forbidden keys cannot appear.
- [Fingerprint collisions or overly broad reuse] → Include component, operation, error code, version/platform, and normalized failure location; search only open issues and return the matched URL.
- [Reporting work delays a model turn] → Bound input, event count, command output, and subprocess deadline; do not retry.
- [Runtime replacement leaks old evidence] → Own all diagnostics/reporting state per composition and discard it during shutdown.

## Migration Plan

1. Add diagnostics and reporter modules with isolated unit tests.
2. Compose them into the production runtime and instrument explicit event seams.
3. Register the fifth tool through the existing runtime-aware adapter dispatcher.
4. Add integration coverage proving normal Pi-to-Pi delivery remains unaffected by unavailable reporting.
5. Rollback is removal of the new tool/service; no stored schema, Agent Card, wire protocol, or migration is involved.

## Open Questions

- Whether the first version should attempt optional sanitized occurrence comments on an existing issue; creation/reuse is sufficient for the initial contract.
- Exact credential-source precedence beyond authenticated `gh`; the initial scope can report unavailable until an explicit source is designed.
