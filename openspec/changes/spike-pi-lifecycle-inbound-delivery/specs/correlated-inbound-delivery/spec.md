## ADDED Requirements

### Requirement: Register request ownership before delivery

The adapter SHALL register an accepted inbound request in request-scoped state
before sending its custom message to Pi. The request ID SHALL be carried in the
custom message `details` and SHALL remain opaque to Pi's transcript handling.

#### Scenario: Idle inbound request is accepted

- **WHEN** an inbound request with ID `request-a` is accepted while Pi is idle
- **THEN** request state for `request-a` exists before the custom message is sent
  and the message `details` contain `requestId: "request-a"`

#### Scenario: Custom message is persisted without duplicated metadata body

- **WHEN** Pi receives the custom message
- **THEN** message events and the persisted custom-message entry retain its
  details, while request correlation remains owned by the adapter

### Requirement: Support explicit idle and busy delivery modes

The adapter SHALL use `triggerTurn: true` for an idle inbound request and SHALL
select `deliverAs: "steer"` or `deliverAs: "followUp"` for a busy agent according
to the requested delivery policy.

#### Scenario: Idle delivery starts a turn

- **WHEN** an inbound custom message is sent with `triggerTurn: true` while Pi is
  idle
- **THEN** Pi persists the custom message, starts an agent turn, and exposes the
  same request ID in message events and session entries

#### Scenario: Busy steering precedes follow-up

- **WHEN** request `request-steer` is delivered as `steer` and request
  `request-follow` is delivered as `followUp` while Pi is busy
- **THEN** the steering message is processed before the follow-up message and
  each message retains its own request ID

### Requirement: Correlate replies by explicit request ID

The adapter SHALL expose reply handling that requires a request ID and SHALL
transition only the matching request state. It MUST NOT select a request or
reply by global current-inbound state, arrival recency, or the latest assistant
message.

#### Scenario: Two queued requests complete independently

- **WHEN** requests `request-a` and `request-b` are both accepted and replies are
  produced with explicit IDs
- **THEN** `p2p_reply("request-a", ...)` completes only `request-a` and
  `p2p_reply("request-b", ...)` completes only `request-b`

#### Scenario: Unknown request ID is rejected

- **WHEN** a reply is submitted for an ID with no accepted request state
- **THEN** the adapter rejects or records the reply as unmatched and does not
  complete another request

#### Scenario: Agent run ends before automatic continuation

- **WHEN** `agent_end` occurs before a retry, compaction, or queued continuation
  has settled
- **THEN** the adapter does not emit a request reply merely because an assistant
  message is currently the newest transcript message
