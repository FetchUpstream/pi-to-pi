# Exploration result

The new Pi-to-Pi should be designed as a **small, reliable peer-messaging substrate for independent Pi sessions**.

It should not become an orchestrator, task scheduler, subagent framework, worktree manager, or local Slack replacement. Those systems may use Pi-to-Pi, but they should sit above it.

The central abstraction is:

> One running Pi session can discover another running Pi session, send it a correlated request, and receive a correlated reply without either session being the parent of the other.

No application code or OpenSpec artifacts were created during this exploration.

---

## 1. What the original implementation established

IndyDevDan’s implementation demonstrated several valuable ideas:

- Each Pi process owns an addressable local endpoint.
- Peers discover one another without a central orchestrator.
- Agents have names, purposes, models, projects and presence information.
- A message can trigger a turn in another independent Pi session.
- Responses return asynchronously to the originating session.
- Local transport uses Unix sockets on POSIX and named pipes on Windows.
- A filesystem registry groups agents by project.

That conceptual model should be retained.

The existing flow is approximately:

```text
┌───────────────┐        local socket         ┌───────────────┐
│ Pi: planner   │ ──────────────────────────▶ │ Pi: coder     │
│               │                              │               │
│ coms_send     │ ◀────────────────────────── │ agent_end     │
└───────────────┘        response socket       └───────────────┘

```

The problem is not the concept. The problem is that discovery, transport, protocol, request state, Pi lifecycle handling, response inference, UI and logging are all fused into one roughly 1,600-line extension.

Giovani’s package retains essentially the same architecture while updating imports and adding package documentation, prompts and a small theme shim.

---

# 2. The main defect: replies are inferred rather than correlated

The current implementation handles an inbound prompt by:

1. Storing it in an inbound map.
2. Assigning it to a global `currentInbound`.
3. Injecting it into Pi as a follow-up message.
4. Waiting for any `agent_end`.
5. Choosing the newest unfulfilled inbound request.
6. Scanning the complete session branch for the most recent assistant message.
7. Sending that assistant message as the reply.

Conceptually:

```text
Inbound request A ─┐
Inbound request B ─┼─▶ global currentInbound
User prompt C ─────┘

agent_end
    │
    ▼
"Choose latest unfulfilled request"
    │
    ▼
"Choose latest assistant text in entire session"
    │
    ▼
Send it as a reply

```

This is unsafe once anything overlaps.

Examples:

- Two peers send requests close together.
- A user sends a prompt while a peer request is pending.
- An agent receives request A, then asks peer B a sub-question.
- Pi retries after an error.
- Pi automatically compacts and retries.
- Several follow-up messages are queued.
- A run terminates without producing a new assistant message.
- A peer request should remain open across multiple turns.

Modern Pi explicitly distinguishes `agent_end` from `agent_settled`. `agent_end` only means a low-level run ended; Pi may still retry, compact and retry, or continue with queued follow-ups. `agent_settled` is the point at which Pi has no automatic continuation remaining. ([GitHub](https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/docs/extensions.md "https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/docs/extensions.md"))

Therefore, the new implementation must satisfy this invariant:

> A reply must name the request it completes. It must never be inferred from whichever assistant message happened to be last.

This is the architectural centre of the redesign.

---

# 3. Other problems that should not be carried forward

## Request state

The sender currently sends the prompt and waits for the receiver’s acknowledgement before registering its own pending-reply entry. That creates a small race in which an unusually fast response could arrive before the pending entry exists.

Completed and timed-out entries are retained indefinitely. The implementation deliberately avoids deleting them so that `coms_get` can retrieve them, but it provides no later retention or garbage-collection policy. A late response can also overwrite timeout state.

The proposed `response_schema` is not actually validated as a JSON Schema. The implementation only attempts to parse the assistant text as JSON.

## Identity and discovery

Registry files are addressed by agent name, while the name uniqueness check and registry write are separate operations. Two agents starting simultaneously can choose the same name and contend for the same registry path.

Names and project identifiers also become filesystem path components without a clear validation contract. An old process can remove a registry record that has since been replaced by a newer process with the same name.

The current workaround for Pi owning `--name` was to introduce a separate `--cname` flag. Current Pi exposes the actual session name through `pi.getSessionName()` and emits `session_info_changed` when it changes, so a second name should no longer be necessary. ([GitHub](https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/docs/extensions.md "https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/docs/extensions.md"))

## Presence

Each agent rewrites its registry entry every 30 seconds, while every agent also pings every other discovered agent every 10 seconds. This tends toward all-to-all traffic:

```text
2 peers   →   2 ping directions
10 peers  →  90 ping directions
50 peers  →  2,450 ping directions

```

The local send/read operations do not have a complete connection-and-read deadline. A half-open endpoint can therefore interfere with discovery refresh.

Presence should come primarily from each agent renewing its own lease, not from every peer continuously interrogating every other peer.

## Trust

The current sender includes a callback endpoint in the envelope, and the receiver trusts it. There is no strong binding between:

- the claimed sender;
- the sender’s registry record;
- the callback endpoint;
- the project room;
- the response received later.

This is not necessarily a high-security defect in a single-user local tool, because Pi extensions already run with the user’s full system permissions. Official Pi documentation explicitly warns that installed extensions can execute arbitrary code with those permissions. ([GitHub](https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/docs/extensions.md "https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/docs/extensions.md"))

It is nevertheless necessary to prevent accidental cross-project communication, stale endpoint confusion, malformed frames and replies from the wrong peer.

## Lifecycle

The original extension installs its own process signal handlers in addition to Pi’s session lifecycle hooks. With hot reloads, repeated extension instances can leave process-level listeners behind.

Current Pi documents `session_start` and idempotent `session_shutdown` as the correct boundaries for sockets, timers and other long-lived resources. It emits shutdown around reloads, session replacement, forks and process termination. ([GitHub](https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/docs/extensions.md "https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/docs/extensions.md"))

## Testing

The extracted package defines packaging and release scripts but no test script in its package manifest.

A communication layer cannot be made reliable through manual two-terminal testing alone. Concurrency, stale state, duplicate delivery and lifecycle behaviour need automated process-level tests.

---

# 4. Product boundary

## Pi-to-Pi v1 should provide

- Same-machine Pi session discovery.
- Direct peer-to-peer request and notification delivery.
- Explicitly correlated replies.
- Concurrent inbound and outbound requests.
- Namespaced rooms.
- Clear peer identity and capability descriptions.
- Timeouts, expiry, deduplication and bounded queues.
- Graceful behaviour when a peer exits or reloads.
- Human-readable status in Pi.
- A transport boundary that permits a remote adapter later.

## Pi-to-Pi v1 should not provide

- Agent spawning.
- Parent-child relationships.
- Task decomposition.
- Worktree creation or branch management.
- Shared file locking.
- “Only one writer” enforcement.
- Model selection or agent assignment.
- A central broker or daemon.
- Remote Internet communication.
- Offline message delivery.
- Full A2A compatibility.
- Shared conversation memory.

This boundary is important:

```text
                    ORCHESTRATION LAYER
     ┌───────────────────────────────────────────┐
     │ roles, plans, tasks, worktrees, approvals │
     └─────────────────────┬─────────────────────┘
                           │ uses
                           ▼
                    PI-TO-PI LAYER
     ┌───────────────────────────────────────────┐
     │ discovery, messages, replies, task state  │
     └─────────────────────┬─────────────────────┘
                           │ uses
                           ▼
                    LOCAL TRANSPORT
     ┌───────────────────────────────────────────┐
     │ Unix sockets / Windows named pipes        │
     └───────────────────────────────────────────┘

```

Pi-to-Pi should not know what a “lead developer,” “reviewer” or “implementation task” means. Those are application-level concepts carried in messages or agent descriptions.

---

# 5. Proposed architecture

```text
┌────────────────────────────────────────────────────────────────┐
│                         PI SESSION                             │
│                                                                │
│  ┌──────────────────── Pi Adapter ───────────────────────────┐ │
│  │ tools · custom messages · lifecycle · status · rendering │ │
│  └────────────────────────────┬──────────────────────────────┘ │
│                               │                                │
│  ┌────────────────────────────▼──────────────────────────────┐ │
│  │                    Message Router                         │ │
│  │ request correlation · policy · dedupe · backpressure     │ │
│  └──────────────┬────────────────────────────┬───────────────┘ │
│                 │                            │                 │
│  ┌──────────────▼────────────┐  ┌────────────▼──────────────┐ │
│  │ Task Store               │  │ Protocol                  │ │
│  │ inbound/outbound states  │  │ schemas · errors · IDs    │ │
│  └───────────────────────────┘  └────────────┬──────────────┘ │
│                                             │                 │
│  ┌────────────────────────────┐  ┌───────────▼──────────────┐ │
│  │ Registry / Lease          │  │ Local Transport          │ │
│  │ agent cards only          │  │ UDS or named pipe        │ │
│  └────────────────────────────┘  └──────────────────────────┘ │
└────────────────────────────────────────────────────────────────┘

```

The registry is a directory, not a relay. Message bodies never pass through it.

Every Pi instance owns its endpoint:

```text
                 Registry: discovery only
                  ┌───────────────┐
                  │ agent cards   │
                  │ leases        │
                  └───────┬───────┘
                          │
           ┌──────────────┼──────────────┐
           │              │              │
           ▼              ▼              ▼
     ┌──────────┐    ┌──────────┐   ┌──────────┐
     │ planner  │◀──▶│ coder    │◀─▶│ reviewer │
     │ endpoint │    │ endpoint │   │ endpoint │
     └──────────┘    └──────────┘   └──────────┘

```

There is no permanently connected mesh. A peer opens a short-lived connection to the destination endpoint for each protocol operation.

---

# 6. Identity model

The new design should distinguish four concepts.

## Session identity

A stable identifier for the Pi conversation session. It should survive `/reload` but change for a genuinely new Pi session.

This can be persisted as extension metadata in the Pi session.

## Runtime instance identity

A random UUID created each time the extension runtime starts.

This identifies the exact endpoint and lease owner. It prevents an old runtime from deleting or impersonating the registry entry of a replacement runtime.

## Display name

Use Pi’s built-in session name where available:

```text
pi --name planner
pi --name coder

```

The extension can observe later `/name` changes through `session_info_changed`. Current Pi provides both `pi.getSessionName()` and the rename event. ([GitHub](https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/docs/extensions.md "https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/docs/extensions.md"))

There should be no separate mandatory `--cname`.

An optional namespaced override such as `--p2p-name` can remain available for headless or unusual cases.

## Address

Names are not guaranteed to be unique.

A full address should therefore be something like:

```text
planner@7f2a91
coder@34bb10
reviewer@01d73c

```

The model may use `planner` when only one planner exists. When two peers share that name, `p2p_send` should return an ambiguity error with the candidate addresses. It must not choose one arbitrarily or silently rename a peer to `planner2`.

---

# 7. Rooms and project discovery

The existing global `"default"` project is too permissive. It allows unrelated Pi sessions to discover one another merely because neither specified a project.

The recommended room resolution is:

```text
1. Explicit --p2p-room or project configuration
2. Canonical Git common directory hash
3. Canonical working-directory hash

```

Using the Git common directory rather than the current worktree directory means sessions running in separate worktrees of the same repository naturally discover one another.

Example:

```text
repo main checkout ───────────────┐
worktree feat/auth ───────────────┼─▶ room: parking-a71d…
worktree feat/camera ─────────────┘

unrelated repository ───────────────▶ room: fica-vault-c92e…

```

Cross-room fallback should not exist. A target must be in the current room unless the user deliberately configures a shared room.

---

# 8. Agent cards

Each registry record should be a versioned Agent Card.

A reasonable v1 card contains:

```text
protocol version
session ID
runtime instance ID
display name
purpose
room ID
model and provider
working directory label
semantic role tags, if explicitly configured
protocol capabilities
current state: idle | busy | draining
context usage
inbound queue depth
endpoint
lease expiry
runtime start time

```

The full absolute working directory should not need to be transmitted in every message. A repository/worktree label is usually sufficient.

Capability fields should describe protocol support:

```text
structured replies
cancellation
status updates
maximum message size
supported content types

```

They should not attempt to enumerate every tool available to the model.

---

# 9. Registry and presence

Registry files should be keyed by runtime instance ID:

```text
runtime/
└── rooms/
    └── <room-id>/
        └── agents/
            ├── 018f...a1.json
            ├── 018f...b2.json
            └── 018f...c3.json

```

Each process only renews its own lease.

```text
Agent A ──renew──▶ A.json
Agent B ──renew──▶ B.json
Agent C ──renew──▶ C.json

```

This changes presence traffic from all-to-all polling to one write per agent per lease interval.

A peer list operation can:

1. Read non-expired cards.
2. Discard malformed or incompatible cards.
3. Optionally probe an endpoint only when freshness is uncertain.
4. Remove expired records only when their lease owner is definitely gone.

Important registry rules:

- Unique temporary filename per write.
- Atomic rename.
- Strict validation of room, name and endpoint fields.
- Restrictive file and directory permissions.
- Lease expiry rather than PID alone.
- Short hashed socket paths to avoid Unix socket path-length limits.
- The old runtime may remove only its exact instance record.

---

# 10. Transport decision

The extension should remain TypeScript and use Node’s built-in local IPC. Pi extensions are TypeScript modules, and current Pi explicitly supports Node built-ins in extensions. ([GitHub](https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/docs/extensions.md "https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/docs/extensions.md"))

No Rust sidecar, Bun server or permanent daemon is justified for the local version.

The transport should expose an interface:

```text
bind(endpoint, handler)
request(endpoint, operation, timeout)
close()

```

Two wire implementations are worth testing before finalising the design.


| Option                                   | Advantages                                                       | Cost                                                          |
| ---------------------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------- |
| Length-prefixed JSON over `node:net`     | Small, direct, works naturally with Unix sockets and named pipes | We own framing and RPC semantics                              |
| HTTP plus JSON-RPC over the local socket | Standard framing, status codes and tooling                       | Windows named-pipe behaviour needs a focused validation spike |


My preference is **JSON-RPC-style operations over a length-prefixed local stream** unless the HTTP-over-named-pipe spike proves completely reliable on Linux, macOS and Windows.

The important part is not HTTP versus raw `net`. It is that the protocol and transport remain separate.

The original network version created a new client, a separate hub, a separate tool namespace and duplicated protocol types between client and server. A future remote transport should instead reuse the same message router, task model and Pi tools.

---

# 11. Protocol model

The wire protocol should be versioned from its first release.

Every operation should carry:

```text
protocolVersion
operationId
sender session ID
sender runtime instance ID
recipient runtime instance ID
room ID
createdAt
expiresAt
traceId
parentOperationId, when applicable

```

Core operations:

```text
peer.describe
message.request
message.notify
message.reply
task.status
task.cancel

```

## Requests and notifications

A notification is fire-and-forget:

```text
message.notify

```

A request expects one terminal outcome:

```text
message.request
    ├─ completed
    ├─ failed
    ├─ rejected
    ├─ cancelled
    └─ expired

```

## Task state

```text
                  ┌──────────▶ rejected
                  │
created ─▶ accepted ─▶ queued ─▶ working ─▶ completed
                  │                 │
                  ├──────────▶ expired
                  ├──────────▶ cancelled
                  └──────────▶ failed

```

Not all states must appear in the initial UI, but the internal distinctions prevent vague `"pending"` behaviour.

## Content

V1 should support:

- Text content.
- Structured JSON content.
- Optional expected response schema.

File attachments and arbitrary filesystem references should be deferred until access boundaries are designed.

## Structured responses

When a sender supplies an expected schema:

1. The receiving model must see a concise representation of that contract in the inbound prompt.
2. The exact schema remains in hidden request metadata.
3. `p2p_reply` validates the supplied value against the stored schema.
4. Invalid responses are rejected locally so the receiving model can correct them.

This is materially different from merely calling `JSON.parse()`.

## Delivery behaviour

The sender should persist its outbound task metadata before transmitting.

The receiver should:

1. Validate the envelope.
2. Validate room and destination.
3. Check duplicate operation IDs.
4. Check queue capacity and expiry.
5. Record acceptance.
6. Return an acknowledgement.
7. Inject the request into Pi.

Retries use the same operation ID. The receiver returns the existing acknowledgement for a duplicate rather than executing the request twice.

V1 should make a modest and honest guarantee:

> Accepted requests are deduplicated and tracked while the destination session is running. Pi-to-Pi v1 does not provide offline delivery after the destination process has exited.

---

# 12. Pi tool surface

The model-facing API should be smaller and more explicit than the existing four-tool polling API.

## `p2p_peers`

Lists peers in the current room.

Returns:

```text
display name
unique address
purpose
model
state
queue depth
context usage
capabilities

```

## `p2p_send`

Sends either a request or notification.

Important fields:

```text
target
message
kind: request | notification
expected_response, optional
expires_in, optional

```

For a request it returns immediately with:

```text
request ID
target identity
accepted | rejected | busy

```

## `p2p_reply`

Completes one specific inbound request.

```text
request_id
response
outcome: completed | failed | rejected

```

The target is inferred from stored request metadata, not supplied by the model.

## `p2p_status`

Inspects inbound and outbound tasks.

It can support one request ID or a filtered list.

## `p2p_cancel`

A later addition for cooperative cancellation. V1 cancellation should not blindly call `ctx.abort()` because the Pi turn may also contain unrelated work.

---

# 13. Do not provide a blocking `p2p_await` by default

This is one of the most important departures from the old design.

Consider:

```text
A sends request to B
A blocks inside p2p_await

B needs clarification from A
B sends request to A
B blocks inside p2p_await

```

A’s inbound clarification can be queued, but Pi cannot process it because A’s current tool execution is still blocked waiting for B.

```text
A waiting for B
▲             │
│             ▼
clarification from B
│             ▲
└── cannot run because A is still waiting

```

That is a distributed deadlock.

Current Pi provides exactly the mechanism needed to avoid it: custom messages can be delivered as a `followUp`, and `triggerTurn: true` starts a turn when the agent is idle. ([GitHub](https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/docs/extensions.md "https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/docs/extensions.md"))

The normal flow should therefore be:

```text
Planner                         Coder
   │                               │
   │ p2p_send(request)             │
   ├──────────────────────────────▶│
   │ accepted                      │
   ◀───────────────────────────────┤
   │                               │
   │ planner ends its turn         │ coder receives follow-up
   │                               │ coder works
   │                               │ p2p_reply(request_id)
   │◀──────────────────────────────┤
   │ reply injected as follow-up   │
   │ planner automatically resumes │

```

No polling is necessary in the normal path.

The `p2p_send` tool guidance should tell the model:

> When the answer is required before continuing, send the request and end the current response. Pi-to-Pi will resume the session when the reply arrives.

---

# 14. Explicit reply versus automatic reply

There are three possible approaches.

## Automatic reply from final assistant text

This is the current behaviour. It is convenient but cannot safely represent nested or multi-turn work.

Reject this as the correctness mechanism.

## Explicit `p2p_reply`

The receiving agent must call `p2p_reply(request_id, response)`.

Advantages:

- Exact request correlation.
- Supports multiple simultaneous requests.
- Supports nested peer calls.
- Supports explicit failure and rejection.
- Supports structured validation.
- Never mistakes a user-facing response for a peer response.

The cost is that the model must use one more tool.

## Conservative hybrid

A later convenience feature could auto-reply only when all of these are true:

- The run was unambiguously triggered by one Pi-to-Pi request.
- No nested request remains outstanding.
- The model did not already call `p2p_reply`.
- Pi has reached `agent_settled`.
- The response is valid for the expected output contract.

Even then, it should be optional.

For v0.1, **explicit** `p2p_reply` **should be the correctness anchor**. A custom prompt guideline and unresolved-request reminder can make tool use reliable without reintroducing inference.

---

# 15. Inbound and outbound Pi messages

Inbound requests should enter the session as a custom message:

```text
customType: "pi-to-pi.request"
details:
  requestId
  sender
  traceId
  expectedResponse

```

The visible model content should clearly state:

```text
[Pi-to-Pi request 01J... from planner@7f2a91]

Review the proposed database migration and identify unsafe changes.

Reply using p2p_reply with request_id "01J...".

```

Replies should enter the sender session as:

```text
customType: "pi-to-pi.reply"
deliverAs: "followUp"
triggerTurn: true

```

Pi retains custom-message details for extension handling, while the content participates in model context. Pi also supports custom message and entry rendering, so these can appear as compact peer-message cards rather than ordinary user messages. ([GitHub](https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/docs/extensions.md "https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/docs/extensions.md"))

---

# 16. Persistence and audit trail

Pi’s `appendEntry()` can persist extension metadata and restore it after reload without placing that metadata into LLM context. ([GitHub](https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/docs/extensions.md "https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/docs/extensions.md"))

Use it for bounded task events such as:

```text
outbound_created
outbound_accepted
inbound_accepted
inbound_started
reply_sent
reply_received
task_expired
task_cancelled

```

Do not log full prompt and response bodies by default.

The session already contains the displayed custom message, so duplicating the body in an audit log is unnecessary.

Recommended retention:

- Keep active tasks.
- Keep recent terminal task metadata.
- Prune old terminal entries from the in-memory index.
- Never allow pending maps to grow without a limit.
- Make verbose body logging an explicit debug option.

---

# 17. Trust model

The realistic v1 threat model is:

> Peers are Pi instances running under the same operating-system user. Pi-to-Pi protects against accidental cross-room traffic, stale instances, malformed messages and unintended peers. It does not claim to isolate the user from malicious code already running as that user.

Recommended controls:

- Socket and registry directories restricted to the current user.
- Exact room matching.
- Random per-runtime capability token.
- Token checked on every protocol operation.
- Sender identity resolved from the registry rather than trusting a supplied callback path.
- Reply accepted only from the request’s expected target instance.
- Strict maximum frame and content sizes.
- Queue limits.
- Request expiry.
- Protocol schema validation.
- Optional allowlist and denylist.
- “Do not disturb” or draining state.
- Inbound content explicitly identified as peer-originated.
- No remote listener or TCP port in local mode.

A future remote transport requires a separate security design involving authenticated identities, encryption and explicit authorization.

---

# 18. UI and operator experience

The original always-visible pool widget is useful for demonstration, but the new extension should be quieter by default.

Footer status:

```text
↔ planner · 2 peers · 1 pending

```

Slash command:

```text
/p2p
/p2p peers
/p2p tasks
/p2p inspect <request-id>
/p2p room
/p2p policy

```

Optional expanded widget:

```text
PI-TO-PI · room parking-a71d
● coder@34bb10      terra-medium    busy    queue 1
● reviewer@01d73c   sol-medium      idle    queue 0

```

Important events should appear as concise notifications:

```text
Request accepted by coder@34bb10
Reply received from coder@34bb10
Request to reviewer@01d73c expired
Ambiguous target "coder": coder@34bb10, coder@92a8ff

```

There should be no theme shim and no forced terminal title.

---

# 19. Relationship to A2A

Pi-to-Pi should not implement the full Agent2Agent protocol in v1.

A2A is designed for interoperability between opaque agent applications and includes discovery, Agent Cards, messages, tasks, streaming, asynchronous notifications, security considerations and multiple protocol bindings. Its specification deliberately separates data model, operations and transport bindings. ([GitHub](https://github.com/a2aproject/A2A/blob/main/docs/specification.md "https://github.com/a2aproject/A2A/blob/main/docs/specification.md"))

That separation is worth borrowing.

A2A also treats a message operation as something that can return either a direct message or an asynchronously processed task, with task retrieval, streaming and cancellation semantics. ([GitHub](https://github.com/a2aproject/A2A/blob/main/docs/specification.md "https://github.com/a2aproject/A2A/blob/main/docs/specification.md"))

Pi-to-Pi should borrow:

- Agent Cards.
- Message and task IDs.
- Explicit task lifecycle.
- Capability discovery.
- Async-first behaviour.
- Cancellation semantics.
- Separation of data model from transport.
- Structured content parts.
- Trace and parent identifiers.

It should not initially inherit:

- HTTP service discovery.
- Enterprise authentication profiles.
- gRPC bindings.
- Streaming artifact protocols.
- Push-notification infrastructure.
- Full cross-vendor interoperability requirements.

The relationship should be:

```text
                 A2A ecosystem
                      │
              optional future adapter
                      │
                      ▼
             Pi-to-Pi core protocol
                      │
          ┌───────────┴───────────┐
          ▼                       ▼
 local socket transport     future remote transport

```

An A2A adapter later could map:

```text
Pi-to-Pi Agent Card  ↔  A2A AgentCard
Pi-to-Pi request     ↔  A2A Message/Task
Pi-to-Pi reply       ↔  A2A Task completion

```

The core should remain Pi-native.

---

# 20. Proposed package boundaries

This is an architectural layout, not an implementation:

```text
src/
├── index.ts                 Pi extension entry point
├── config.ts                namespaced configuration and defaults
├── identity.ts              session and runtime identity
├── room.ts                  room derivation
│
├── protocol/
│   ├── messages.ts          request/reply/notification contracts
│   ├── agent-card.ts
│   ├── task-state.ts
│   ├── errors.ts
│   └── validation.ts
│
├── discovery/
│   ├── registry.ts
│   └── lease.ts
│
├── transport/
│   ├── transport.ts         interface
│   └── local-ipc.ts
│
├── router/
│   ├── router.ts
│   ├── task-store.ts
│   ├── dedupe.ts
│   └── policy.ts
│
└── pi/
    ├── tools.ts
    ├── messages.ts
    ├── lifecycle.ts
    ├── persistence.ts
    └── ui.ts

tests/
├── unit/
├── integration/
├── process/
└── fixtures/

```

The purpose of these boundaries is testability, not abstraction for its own sake. This should remain one package and one installable Pi extension.

---

# 21. Proposed execution plan

```text
M0 Protocol decisions and spikes
        │
        ▼
M1 Package and test foundation
        │
        ├──────────────┐
        ▼              ▼
M2 Discovery       M3 Protocol/task engine
and transport          │
        └──────┬───────┘
               ▼
M4 Pi integration and tools
               │
               ▼
M5 Reliability and security
               │
               ▼
M6 Documentation and v0.1 release

```

## M0 — Design contracts and technical spikes

Settle the uncertain parts before building the extension.

Produce:

- Product scope and non-goals.
- Threat model.
- Agent Card schema.
- Request/reply protocol schema.
- Task state machine.
- Delivery guarantee.
- Room and identity rules.
- Tool contracts.
- Transport decision record.

Run two focused technical investigations:

1. Verify length-prefixed `node:net` and HTTP-over-local-socket behaviour on Unix sockets and Windows named pipes.
2. Verify how custom request details appear across Pi follow-ups, retries, compaction, `agent_end` and `agent_settled`.

Exit condition:

> The protocol can be described independently of Pi UI and independently of the chosen transport.

## M1 — Package and testing foundation

Define:

- TypeScript package structure.
- Pi package manifest.
- Formatting, linting and type checking.
- Unit-test setup.
- Process-test harness.
- Linux, macOS and Windows CI.
- MIT licence.
- Acknowledgement of IndyDevDan’s original concept.
- Independent-project trademark disclaimer.

Exit condition:

> A minimal extension loads and unloads without leaving sockets, timers or listeners, but does not yet communicate.

## M2 — Identity, rooms, registry and transport

Design and implement:

- Stable session identity.
- Ephemeral runtime identity.
- Built-in Pi session-name integration.
- Automatic Git/worktree room derivation.
- Instance-keyed Agent Card registry.
- Lease renewal and expiry.
- Local endpoint creation and cleanup.
- Framed request/response transport.
- Connection and read deadlines.
- Strict frame-size limits.

Critical tests:

- Two peers discover one another.
- Two peers with the same display name remain distinct.
- Two simultaneous starts do not overwrite registry state.
- A crashed peer expires without PID-only assumptions.
- A stale process cannot remove a replacement process’s entry.
- Malformed registry entries are ignored.
- Room traversal and invalid names are rejected.

## M3 — Protocol router and task engine

Design and implement:

- Request, notification, reply and status operations.
- Task state machine.
- Sender and recipient validation.
- Dedupe.
- TTL and expiry.
- Queue limits and busy responses.
- Parent and trace identifiers.
- Structured response validation.
- Bounded terminal-task retention.
- Metadata audit events.

Critical tests:

- Duplicate sends execute once.
- Reply from the wrong peer is rejected.
- Expired requests never enter Pi.
- Multiple concurrent requests remain correctly correlated.
- Replies arriving in a different order complete the correct tasks.
- An unreachable endpoint fails within a bounded time.
- No request map grows indefinitely.

## M4 — Pi integration

Add:

- `p2p_peers`.
- `p2p_send`.
- `p2p_reply`.
- `p2p_status`.
- Custom inbound request messages.
- Custom reply follow-ups.
- Prompt guidance.
- Session-name updates.
- Footer status.
- `/p2p` commands.
- Custom rendering.
- Reload, new-session, resume and fork handling.

Critical tests:

- An unrelated user turn never becomes a peer reply.
- A request can remain open across multiple Pi turns.
- An agent can make a nested peer request and later complete its parent request.
- Replies resume the sender without polling.
- Automatic compaction or retry does not complete a request prematurely.
- Reload closes the old endpoint and registers a new runtime instance.
- Shutdown is idempotent.

## M5 — Reliability and policy hardening

Add:

- Same-user directory permissions.
- Per-runtime capability tokens.
- Allowlist/denylist policy.
- Draining/do-not-disturb state.
- Backpressure.
- Reply retry within TTL.
- Metadata-only audit defaults.
- Diagnostic inspection.
- Failure-injection tests.

Process tests should intentionally:

- Kill the sender after acceptance.
- Kill the receiver before replying.
- Restart a session during a pending request.
- Corrupt registry files.
- Deliver duplicate frames.
- Delay acknowledgements.
- Fill the inbound queue.
- Send oversized and malformed messages.
- Run three or more peers concurrently.

## M6 — v0.1 release

Documentation should cover:

- What Pi-to-Pi is and is not.
- Installation from GitHub.
- Starting named peers.
- Automatic room behaviour.
- Tool examples.
- Nested request behaviour.
- Security model.
- Delivery limitations.
- Troubleshooting stale peers.
- Protocol versioning.
- Attribution and independent-project disclaimer.

Release validation:

- Package dry run.
- Git installation into a clean Pi agent directory.
- Two-real-session smoke test.
- Linux, macOS and Windows CI.
- Tagged release with changelog.
- Compatibility against the declared minimum and current Pi versions.

---

# 22. v0.1 acceptance criteria

The first useful release is complete when all of these are true:

1. Two Pi sessions in the same repository discover one another without manually specifying a project.
2. Sessions in different repositories do not discover one another by default.
3. Worktrees from the same repository join the same room.
4. Duplicate display names are handled without silent renaming or arbitrary routing.
5. One peer can send a request, end its turn, and automatically resume when the reply arrives.
6. The receiver must explicitly complete the correct request.
7. Multiple overlapping requests cannot cross-wire replies.
8. Nested peer requests do not deadlock.
9. Duplicate network delivery does not duplicate Pi execution.
10. An unreachable or crashed peer produces a bounded failure.
11. Reload, resume, new-session and fork flows do not leak endpoints or listeners.
12. Malformed, oversized, expired and cross-room messages are rejected.
13. The registry carries presence metadata only, never message bodies.
14. No daemon, TCP listener or external database is required.
15. Automated integration tests exercise real child processes on all three major desktop platforms.

---

# 23. Decisions that appear settled

The exploration points strongly toward these choices:

- **Language:** TypeScript.
- **Topology:** direct peer-to-peer local IPC.
- **Central service:** none.
- **Discovery:** filesystem Agent Cards with renewable leases.
- **Routing identity:** runtime instance ID, not name.
- **Display identity:** Pi’s built-in session name.
- **Room default:** repository-derived, never global `"default"`.
- **Reply correlation:** explicit request ID.
- **Normal response flow:** asynchronous Pi follow-up, not blocking await.
- **Correctness mechanism:** explicit `p2p_reply`.
- **Persistence:** bounded metadata through Pi session entries.
- **Remote support:** later transport/adapter, not a separate duplicated extension.
- **A2A:** architectural inspiration and possible bridge, not the v1 wire protocol.
- **Scope:** communication only.

The remaining design spikes are narrow:

1. Length-prefixed IPC versus HTTP-over-local-socket.
2. Exact persistence boundary for pending tasks across `/reload`.
3. Whether conservative automatic replies should appear in v0.2.
4. Default first-contact policy versus automatic trust inside an exact local room.

This is sufficiently defined to leave explore mode and create an OpenSpec change named something like `design-modern-pi-to-pi`, containing the proposal, protocol specification, architecture design and phased tasks. The OpenSpec CLI was not available in the current environment, so no proposal files were written.