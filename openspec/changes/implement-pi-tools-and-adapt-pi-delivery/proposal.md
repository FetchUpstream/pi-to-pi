## Why

The production protocol router and Agent Card discovery boundaries are now available, but Pi sessions have no model-facing communication tools or delivery adapter. Pi needs an explicitly correlated adapter so peer requests and replies remain asynchronous, concurrent-safe, and independent of transcript inference.

## What Changes

- Register `p2p_peers`, `p2p_send`, `p2p_reply`, and `p2p_status` as communication-only Pi tools.
- Add a runtime-scoped Pi adapter that consumes `MessageRouter` and `AgentCardRegistry` production contracts without adding a transport or discovery implementation.
- Deliver inbound router tasks to Pi custom messages through the `TaskExecutor` seam, preserving exact task metadata and requiring explicit `p2p_reply` calls.
- Inject each terminal outbound request result once into its originating Pi session as a correlated follow-up.
- Add compact request/reply rendering, body-free audit metadata where useful, and minimal peer/task status UI.
- Preserve runtime-local router ownership across reload and session replacement; persisted Pi data is audit-only and never restores live tasks.

## Capabilities

### New Capabilities

- `pi-peer-communication`: Pi tools, peer discovery presentation and resolution, explicit router-backed replies, status inspection, and correlated custom-message delivery.

### Modified Capabilities

- `pi-session-lifecycle`: Clarify that Pi lifecycle integration owns runtime-scoped adapter cleanup and presentation only; it never restores or terminalizes live protocol tasks from session history.

## Impact

- Affected source: `src/index.ts`, `src/pi/tools.ts`, `src/pi/messages.ts`, `src/pi/persistence.ts`, `src/pi/ui.ts`, and a new Pi adapter seam.
- Affected integrations: `MessageRouter`, `TaskExecutor`, `AgentCardRegistry`, and Pi extension APIs (`registerTool`, `sendMessage`, custom renderers, lifecycle events).
- P2P-013 remains responsible for concrete transport delivery, endpoint binding/authentication, and replacing the legacy lifecycle registry wiring.
