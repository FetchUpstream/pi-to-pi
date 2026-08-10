## 1. Pi adapter foundations

- [x] 1.1 Define typed Pi custom-message details and body-free audit metadata for inbound requests, outbound terminal results, and task state.
- [x] 1.2 Implement a runtime-scoped, injectable Pi adapter that consumes production `MessageRouter` and `AgentCardRegistry` contracts without creating transport, endpoint, or discovery wiring.
- [x] 1.3 Bind and clear the adapter's active Pi session/runtime state at lifecycle boundaries without reconstructing live router tasks from persisted entries.

## 2. Model-facing tools

- [x] 2.1 Register communication-only `p2p_peers`, `p2p_send`, `p2p_reply`, and `p2p_status` tool definitions from the extension entry point.
- [x] 2.2 Implement `p2p_peers` with live Agent Card listing and collision-safe peer output; resolve send targets only through the production discovery boundary.
- [x] 2.3 Implement `p2p_send` with typed request content, optional expected-response metadata, router admission reporting, asynchronous completion tracking, and router notification routing if notification mode is exposed.
- [x] 2.4 Implement `p2p_reply` and `p2p_status` exclusively through live router snapshots and terminal task APIs, including invalid structured-reply correction behavior.

## 3. Pi delivery and presentation

- [x] 3.1 Implement the router `TaskExecutor` delivery path: preserve request correlation metadata, suppress pre-delivery cancellation, use triggered idle delivery or busy `steer`, and return `void`.
- [x] 3.2 Inject outbound terminal snapshots once per request as correlated Pi `followUp` messages, including completed and non-completed outcomes.
- [x] 3.3 Add compact custom-message renderers and minimal peer/pending-task status presentation; keep persisted audit data body-free and historical only.
- [x] 3.4 Ensure `agent_end` and `agent_settled` do not infer replies, and task cancellation never globally aborts the Pi context.

## 4. Focused verification

- [x] 4.1 Add adapter tests using real `MessageRouter` and `AgentCardRegistry` with fakes only for Pi and external delivery boundaries.
- [x] 4.2 Cover duplicate peer names, admission-before-completion, concurrent exact-ID replies, invalid structured reply correction, and status ownership/state output.
- [x] 4.3 Cover idle/steer/follow-up delivery selection, single terminal injection, cancellation scoping, and reload/replacement task-isolation behavior.
- [x] 4.4 Run the targeted Pi adapter tests and the repository typecheck, lint, format check, and build; resolve resulting failures.
