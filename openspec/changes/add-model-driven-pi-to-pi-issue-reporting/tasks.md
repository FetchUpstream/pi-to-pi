## 1. Diagnostic foundations

- [x] 1.1 Add closed, allowlist-only diagnostic event and snapshot types with scalar bounds and forbidden-data exclusions.
- [x] 1.2 Implement the fixed-capacity in-memory diagnostic event ring and body-free snapshot formatter.
- [x] 1.3 Add unit tests for event eviction, field bounds, snapshot context selection, and exclusion of messages, credentials, environment values, paths, and transcripts.

## 2. Fixed GitHub reporting boundary

- [x] 2.1 Define bounded model-report input, reporter result, and fixed repository reporter interfaces.
- [x] 2.2 Implement canonical non-sensitive fingerprint generation and issue-body rendering with separate narrative and automatic-diagnostics sections.
- [x] 2.3 Implement an injectable `gh` CLI reporter that checks availability, searches open fingerprint markers, creates fixed-repository issues, and maps failures to created/existing/unavailable/failed outcomes.
- [x] 2.4 Add reporter unit tests for sanitization, fingerprint stability, issue creation, existing-issue reuse, unavailable authentication, command/API failure, and bounded tool-safe errors.

## 3. Runtime composition and instrumentation

- [x] 3.1 Create runtime-local diagnostic/reporting dependencies in `PiToPiRuntimeComposition` and discard them on shutdown/replacement.
- [x] 3.2 Instrument explicit lifecycle, discovery, router task-state, and IPC bridge transitions through the closed event sink without recording payloads.
- [x] 3.3 Verify diagnostics/reporting failure paths cannot change router admission, task state, discovery, or transport behavior.

## 4. Pi tool integration

- [x] 4.1 Extend `PiAdapter` with the reporting facade and register `p2p_report_issue` through the existing runtime-aware dispatcher.
- [x] 4.2 Define bounded tool parameters and defect-only guidance; render created, existing, unavailable, and failed results without credential or command-output leakage.
- [x] 4.3 Update adapter and default-extension tests for the fifth tool, active-runtime dispatch, diagnostic correlation IDs, and unavailable reporter behavior.

## 5. Integration verification

- [x] 5.1 Add production-runtime integration coverage that reporting gathers current runtime evidence and does not disrupt active communication when GitHub is unavailable.
- [x] 5.2 Run the targeted diagnostics, reporter, adapter, and production-runtime tests.
- [x] 5.3 Run `npm run check` and `openspec validate add-model-driven-pi-to-pi-issue-reporting --strict`.
