## Purpose

The agent-card registry defines versioned, private, room-scoped presence cards and leases for Pi runtimes.

## Requirements

### Requirement: The Agent Card registry SHALL be the single discovery authority

New discovery publication, renewal, listing, and owner-removal operations SHALL use the versioned `AgentCard` schema and the existing private Agent Card filesystem tree. They SHALL NOT create a parallel `RuntimeRecord` file or silently translate a legacy record into a live Agent Card. The legacy registry may remain as a compatibility seam until P2P-013 rewires its consumers, but it is not part of this registry's authority.

#### Scenario: Agent Card registry publishes the canonical record
- **WHEN** a runtime publishes presence through the new discovery registry
- **THEN** the registry writes one validated Agent Card at `rooms/<storageKey>/agents/<runtimeInstanceId>.json`

#### Scenario: Legacy records are not dual-published
- **WHEN** the Agent Card registry renews or removes a runtime
- **THEN** it operates only on that runtime's Agent Card and does not create or update a `RuntimeRecord`

### Requirement: Agent Cards SHALL be versioned and identity-safe

The registry SHALL publish a JSON Agent Card with a supported `protocolVersion`, a stable Pi `sessionId`, a fresh per-runtime `runtimeInstanceId`, an effective `displayName`, the canonical `roomId`, protocol `capabilities`, `state`, an `endpoint` descriptor, `runtimeStartedAt`, and `leaseExpiresAt`. Optional metadata SHALL use explicit nullability or empty collections rather than fabricated values. The filename and payload runtime identity SHALL match. When an integration uses P2P-008's `runtimeId` vocabulary, the discovery adapter SHALL map it to the same full canonical UUID as `runtimeInstanceId`; it SHALL NOT shorten, regenerate, or otherwise reinterpret the identity.

The card SHALL represent an unset Pi session name with a non-secret runtime-derived fallback display name. `model` SHALL be `{ provider, id }` or `null`. `contextUsage` SHALL be an object or `null`; its `tokens` and `percent` members MAY be `null` when Pi reports them as unknown. The registry SHALL NOT include prompts, responses, API credentials, or capability secrets. `endpoint.runtimeInstanceId` SHALL equal the card and filename runtime identity.

#### Scenario: Card records current Pi identity and metadata
- **WHEN** a runtime publishes a card after `session_start` with a session ID, full runtime ID, model, capabilities, and queue state
- **THEN** the card contains those values with a supported protocol version, the filename equals the runtime instance ID, and the endpoint repeats the same runtime identity

#### Scenario: Card represents unavailable model or context usage
- **WHEN** Pi has no active model or `ctx.getContextUsage()` is unavailable after compaction
- **THEN** the card uses `model: null` and/or `contextUsage: null` instead of reporting zero or inventing a value

#### Scenario: Reload creates a distinct runtime identity
- **WHEN** Pi reloads the extension while continuing the same logical session
- **THEN** the new card keeps the session ID, uses a new full runtime instance ID, and does not overwrite the old runtime's record

#### Scenario: Mismatched endpoint identity is rejected
- **WHEN** a card's endpoint declares a runtime identity different from the card or its destination filename
- **THEN** publication and discovery reject the card as invalid

### Requirement: The registry SHALL use a private, deterministic, room-scoped layout

The registry SHALL resolve a per-user runtime root from `PI_TO_PI_RUNTIME_DIR`, a valid POSIX `XDG_RUNTIME_DIR` child, Windows per-user LocalAppData, or a private per-user temporary fallback in that order. It SHALL fail closed when it cannot establish a private root. Within that root it SHALL store records at `rooms/<storageKey>/agents/<runtimeInstanceId>.json`, where `storageKey` is supplied by the room identity module and is safe as a filesystem component.

The registry SHALL never use display names, raw room input, process IDs, session IDs, or endpoint addresses as record filenames. It SHALL not use Pi's persistent config or session directory as the default registry root.

#### Scenario: POSIX runtime directory is selected
- **WHEN** `XDG_RUNTIME_DIR` is absolute, owned by the current user, and private
- **THEN** the registry uses `<XDG_RUNTIME_DIR>/pi-to-pi` and creates its room and agent directories beneath it

#### Scenario: Windows uses a per-user location
- **WHEN** the process runs on Windows and a usable per-user LocalAppData location exists
- **THEN** the registry uses `%LOCALAPPDATA%\\pi-to-pi\\runtime` with current-user ACL protection

#### Scenario: Room storage identity is supplied by room derivation
- **WHEN** the room module provides `roomId` and `storageKey`
- **THEN** the registry uses the storage key as the path component and records the canonical room ID in each card without independently hashing raw input

### Requirement: Card publication SHALL be atomic and instance-owned

A runtime SHALL write a complete card to a unique temporary file in the destination agent directory and replace the final card with a same-directory atomic rename. Renewal SHALL be serialized per runtime. A runtime SHALL publish, renew, or remove only the card whose filename contains its own runtime instance ID. Temporary files SHALL not be returned as peer cards.

#### Scenario: Concurrent runtimes publish without overwriting
- **WHEN** two runtimes in the same room publish at the same time
- **THEN** each runtime has a distinct final card and neither publication replaces the other runtime's card

#### Scenario: Reader observes only complete cards
- **WHEN** a reader scans while a runtime is writing a temporary card
- **THEN** the reader either sees the previous complete card or the new complete card, never a partial JSON document

#### Scenario: Old runtime cannot remove a replacement
- **WHEN** an old runtime shuts down after a different runtime has published a different instance record
- **THEN** the old runtime removes at most its own exact record and leaves the replacement record unchanged

### Requirement: Leases SHALL provide bounded presence and safe cleanup

The registry SHALL use a renewable lease with a canonical default TTL of 90 seconds and a canonical default renewal interval of 30 seconds. The lease module SHALL be the only source of these defaults and of expiry calculations. Agent Cards SHALL serialize `runtimeStartedAt` and `leaseExpiresAt` as valid ISO-8601 timestamps, while internal comparisons MAY use parsed epoch milliseconds. A card whose lease has expired SHALL not be returned as live. Shutdown SHALL attempt best-effort removal, but readers SHALL rely on expiry for crashed or forcibly terminated runtimes. Expired records SHALL become cleanup-eligible only after the expiry time plus two TTLs, and abandoned temporary files SHALL use the same TTL-derived age. Cleanup SHALL re-read and validate a candidate immediately before removal.

The registry SHALL obtain presence from self-renewal and SHALL NOT perform periodic all-to-all peer heartbeat probing. Endpoint probing MAY occur only for an explicit diagnostic or transport operation.

#### Scenario: Healthy runtime remains discoverable
- **WHEN** a runtime renews its own card before the lease expires
- **THEN** discovery returns the card with a later ISO lease expiry and does not require a peer heartbeat

#### Scenario: Crashed runtime expires
- **WHEN** a runtime stops renewing and its ISO lease expiry passes
- **THEN** discovery omits the card even if its JSON file remains on disk

#### Scenario: Grace-period cleanup removes stale state
- **WHEN** a card remains expired for at least two additional TTLs and still identifies the same runtime instance
- **THEN** cleanup MAY remove that exact record without affecting other cards

#### Scenario: Cleanup observes a renewed card
- **WHEN** a runtime renews a card while cleanup is considering its expired file
- **THEN** cleanup re-reads the card and does not remove the renewed, unexpired card

#### Scenario: Lease defaults remain consistent
- **WHEN** a caller constructs a lease timer, publishes a card, or cleans abandoned temporary files without explicit durations
- **THEN** all operations use 90 seconds for the TTL and 30 seconds for renewal, with no module-specific alternative

### Requirement: Discovery SHALL validate records independently and remain discovery-only

A room listing SHALL validate each candidate's JSON syntax, schema, protocol version, room ID, runtime identity, endpoint descriptor, enum values, timestamps, queue depth, size bounds, and lease state. The discovery boundary SHALL adapt a valid Agent Card to P2P-008's lookup shape by mapping `runtimeInstanceId` to full `runtimeId`, mapping the resolved room exactly, and deriving the published network name from `displayName` and that same runtime ID. Malformed, incompatible, cross-room, identity-mismatched, or expired candidates SHALL be ignored without preventing valid peers from being returned. Registry files SHALL contain presence metadata only and SHALL never carry message bodies or task state.

#### Scenario: One malformed file does not hide valid peers
- **WHEN** a room contains one malformed file and one valid unexpired card
- **THEN** discovery ignores the malformed file and returns the valid card through the lookup adapter

#### Scenario: Cross-room card is rejected
- **WHEN** a card under one room directory declares a different canonical room ID
- **THEN** discovery rejects that card and does not adapt or route it into the current room

#### Scenario: Agent Card identity maps to a peer address
- **WHEN** a valid card is listed for the current room
- **THEN** the adapter exposes its full runtime instance UUID as the machine-actionable peer runtime ID and preserves the card's exact room

#### Scenario: Registry remains metadata-only
- **WHEN** a runtime publishes or renews its card
- **THEN** the stored record contains no request, response, prompt, or task body

### Requirement: Registry resources SHALL follow Pi lifecycle and platform protection rules

The extension SHALL start registry timers and publication during `session_start`, SHALL stop them during an idempotent `session_shutdown`, and SHALL not start long-lived registry resources from the extension factory. POSIX registry directories SHALL use mode `0700` and card files SHALL use mode `0600`. Windows SHALL use ACL-based current-user protection rather than relying on POSIX mode bits.

#### Scenario: Shutdown is idempotent
- **WHEN** Pi emits `session_shutdown` more than once or shutdown cleanup races with expiry cleanup
- **THEN** registry resources are closed safely and no duplicate timers or destructive cross-instance removals occur

#### Scenario: Private permissions are applied
- **WHEN** the registry creates its runtime tree and a card file on POSIX
- **THEN** directories are private to the user and card files are readable/writable only by the user

#### Scenario: Reload closes the old runtime
- **WHEN** Pi reloads the extension
- **THEN** the old registry timer and endpoint resources stop before the new runtime instance registers

### Requirement: Active production cards SHALL reflect one ready runtime
A production runtime SHALL publish one canonical Agent Card only after its native endpoint and inbound request handler are ready. That card and `peer.describe` SHALL represent the same session ID, runtime instance ID, exact room, endpoint kind/address, effective protocol capabilities, and maximum message size. The advertised maximum SHALL not exceed the effective minimum of router/protocol and transport payload limits.

#### Scenario: Published endpoint and capability limit are usable
- **WHEN** a runtime becomes discoverable through the production lifecycle
- **THEN** its card identifies its bound endpoint and advertises a maximum message size no greater than the active transport and router limits

### Requirement: Production card metadata SHALL follow live Pi and router state
The active runtime SHALL update its canonical Agent Card for display-name changes, available model/provider, busy/idle/draining state, available context usage, and inbound queue depth without changing runtime identity. These presence updates SHALL NOT terminalize Pi-to-Pi tasks or create a second discovery card.

#### Scenario: Runtime becomes busy and is renamed
- **WHEN** Pi reports agent activity and later a session information name change
- **THEN** the same live Agent Card updates its state and display name while retaining its runtime instance ID and endpoint
