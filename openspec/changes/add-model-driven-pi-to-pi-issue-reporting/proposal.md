## Why

Autonomous Pi agents often observe Pi-to-Pi failures while the relevant runtime state still exists, but cannot turn that observation into a reproducible upstream defect report. A narrow reporting path can preserve useful, sanitized evidence without adding generic GitHub tooling or affecting communication correctness.

## What Changes

- Register a `p2p_report_issue` model-facing tool for suspected Pi-to-Pi defects only.
- Add a bounded, allowlist-based diagnostic snapshot and in-memory diagnostic event ring that exclude message bodies, prompts, credentials, environment values, files, paths, and transcripts.
- Add a fixed-destination GitHub reporter for `FetchUpstream/pi-to-pi`, including authenticated-local availability handling and structural duplicate detection.
- Separate untrusted agent narrative from automatically collected Pi-to-Pi evidence in generated issue bodies and tool results.
- Keep reporting best-effort, bounded, and isolated from request, reply, discovery, transport, and lifecycle correctness.

## Capabilities

### New Capabilities

- `pi-to-pi-diagnostics`: Collect bounded, structured, non-sensitive runtime snapshots and causal diagnostic events.
- `model-driven-issue-reporting`: Report suspected Pi-to-Pi defects to the fixed upstream repository with duplicate detection and safe failure handling.

### Modified Capabilities

- `pi-peer-communication`: Expose the narrowly scoped reporting tool alongside the existing communication tools and define its model-facing boundary.
- `production-runtime-composition`: Compose runtime-local diagnostic/reporting dependencies without changing production communication behavior.

## Impact

- Affected code: `src/pi/adapter.ts`, `src/runtime/composition.ts`, lifecycle/router/discovery/transport integration seams, and new diagnostics/reporting modules.
- Affected API: adds `p2p_report_issue`; existing tool and protocol semantics remain unchanged.
- External integration: optional existing authenticated `gh` CLI session; unavailable authentication is a normal reporter result.
- Tests cover sanitization, bounded retention, fingerprints, reporter outcomes, and runtime-context integration.
