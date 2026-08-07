## ADDED Requirements

### Requirement: Agent Cards SHALL be versioned and identity-safe
The registry SHALL publish a JSON Agent Card with a supported `protocolVersion`, a stable Pi `sessionId`, a fresh per-runtime `runtimeInstanceId`, an effective `displayName`, the canonical `roomId`, protocol `capabilities`, `state`, an `endpoint` descriptor, `runtimeStartedAt`, and `leaseExpiresAt`. Optional metadata SHALL use explicit nullability or empty collections rather than fabricated values. The filename and payload runtime identity SHALL match.

The card SHALL represent an unset Pi session name with a non-secret runtime-derived fallback display name. `model` SHALL be `{ provider, id }` or `null`. `contextUsage` SHALL be an object or `null`; its `tokens` and `percent` members MAY be `null` when Pi reports them as unknown. The registry SHALL NOT include prompts, responses, API credentials, or capability secrets.

#### Scenario: Card records current Pi identity and metadata
- **WHEN** a runtime publishes a card after `session_start` with a session ID, runtime ID, model, capabilities, and queue state
- **THEN** the card contains those values with a supported protocol version and the filename equals the runtime ID

#### Scenario: Card represents unavailable model or context usage
- **WHEN** Pi has no active model or `ctx.getContextUsage()` is unavailable after compaction
- **THEN** the card uses `model: null` and/or `contextUsage: null` instead of reporting zero or inventing a value

#### Scenario: Reload creates a distinct runtime identity
- **WHEN** Pi reloads the extension while continuing the same logical session
- **THEN** the new card keeps the session ID, uses a new runtime instance ID, and does not overwrite the old runtime's record

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
The registry SHALL use a renewable lease with a default TTL of 90 seconds and a default renewal interval of 30 seconds. A card whose lease has expired SHALL not be returned as live. Shutdown SHALL attempt best-effort removal, but readers SHALL rely on expiry for crashed or forcibly terminated runtimes. Expired records SHALL become cleanup-eligible only after the expiry time plus two TTLs, and cleanup SHALL re-read and validate a candidate immediately before removal.

The registry SHALL obtain presence from self-renewal and SHALL NOT perform periodic all-to-all peer heartbeat probing. Endpoint probing MAY occur only for an explicit diagnostic or transport operation.

#### Scenario: Healthy runtime remains discoverable
- **WHEN** a runtime renews its own card before the lease expires
- **THEN** discovery returns the card with the new lease expiry and does not require a peer heartbeat

#### Scenario: Crashed runtime expires
- **WHEN** a runtime stops renewing and its lease expiry passes
- **THEN** discovery omits the card even if its JSON file remains on disk

#### Scenario: Grace-period cleanup removes stale state
- **WHEN** a card remains expired for at least two additional TTLs and still identifies the same runtime instance
- **THEN** cleanup MAY remove that exact record without affecting other cards

#### Scenario: Cleanup observes a renewed card
- **WHEN** a runtime renews a card while cleanup is considering its expired file
- **THEN** cleanup re-reads the file and does not remove the renewed, unexpired card

### Requirement: Discovery SHALL validate records independently and remain discovery-only
A room listing SHALL validate each candidate's JSON syntax, schema, protocol version, room ID, runtime identity, endpoint descriptor, enum values, timestamps, queue depth, size bounds, and lease state. Malformed, incompatible, cross-room, or expired candidates SHALL be ignored without preventing valid peers from being returned. Registry files SHALL contain presence metadata only and SHALL never carry message bodies or task state.

#### Scenario: One malformed file does not hide valid peers
- **WHEN** a room contains one malformed file and one valid unexpired card
- **THEN** discovery ignores the malformed file and returns the valid card

#### Scenario: Cross-room card is rejected
- **WHEN** a card under one room directory declares a different canonical room ID
- **THEN** discovery rejects that card and does not route it into the current room

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
