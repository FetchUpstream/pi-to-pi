## Purpose

Define bounded, allowlist-only Pi-to-Pi runtime diagnostics.

## Requirements

### Requirement: Diagnostic collection SHALL use an explicit allowlist
The runtime SHALL construct diagnostic snapshots only from explicit, bounded Pi-to-Pi fields: package/runtime/platform versions, timestamp, component/operation, protocol or transport code, correlation identifiers, local and peer runtime IDs, room ID, endpoint kind, Agent Card/lease state, router task direction/state, queue counts, lifecycle state/reason, and bounded durations. It SHALL NOT serialize broad runtime, error, request, reply, context, configuration, or environment objects.

#### Scenario: Snapshot is created for a correlated request
- **WHEN** a report includes a known request ID and peer runtime ID
- **THEN** its automatic diagnostics include only allowlisted correlation and runtime state for that context

#### Scenario: Sensitive runtime values exist
- **WHEN** prompts, message bodies, credentials, environment values, paths, configuration secrets, or transcripts are available in process memory
- **THEN** none of those values appear in the automatic snapshot

### Requirement: Diagnostic events SHALL be body-free and bounded
The runtime SHALL retain a fixed-size in-memory ring of recent structured diagnostic events. Each event SHALL contain only timestamp, component, event name, and optional allowlisted correlation identifiers, code, runtime IDs, and duration. Appending beyond the configured capacity SHALL discard the oldest event, and runtime shutdown SHALL discard the buffer.

#### Scenario: Event capacity is exceeded
- **WHEN** more events are recorded than the configured capacity
- **THEN** the snapshot contains the newest events up to that capacity and excludes the oldest events

#### Scenario: Request content is handled by the router
- **WHEN** discovery, transport, routing, or lifecycle instrumentation records an event while a message has content
- **THEN** the event contains no request, reply, notification, or message body

### Requirement: Diagnostic output SHALL remain bounded and safe to format
The diagnostic formatter SHALL validate, normalize, and size-limit each automatic field and the rendered event history before returning it to the reporter. It SHALL omit unavailable values rather than deriving values from unapproved sources.

#### Scenario: A dependency supplies an oversized error string
- **WHEN** an instrumented dependency exposes an error or identifier exceeding the diagnostic bound
- **THEN** the formatter omits or truncates it to the configured safe bound without collecting unrelated error fields
