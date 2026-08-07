## Context

The repository is a TypeScript Pi extension scaffold. The identity, room, configuration, registry, and lease modules are placeholders, while `SPEC.md` establishes a direct local peer-to-peer architecture. The installed Pi API already provides a persisted session UUID (`ctx.sessionManager.getSessionId()`), session lifecycle events, session-name accessors, and a `session_info_changed` event.

The contract must support reloads without confusing the old endpoint with its replacement, isolate unrelated workspaces, make duplicate human names safe, and avoid using user-controlled values as filesystem path components. The design is local and same-user; it does not attempt to provide a security boundary against code already running as that user.

## Goals / Non-Goals

**Goals:**

- Distinguish Pi's logical session identity from the P2P runtime endpoint identity.
- Produce normalized, human-readable names with a four-character runtime hash suffix.
- Keep the full runtime UUID as the authoritative machine address.
- Resolve an explicit P2P project before Git and working-directory defaults.
- Make Git worktrees of one repository share a room while unrelated repositories remain isolated by default.
- Make registry leases robust to normal shutdown, crashes, reloads, and stale files.
- Define deterministic pure functions and lifecycle seams that can be unit- and process-tested.

**Non-Goals:**

- Implementing Pi's native `/reload`, `/resume`, `/new`, or `/fork` commands.
- Implementing peer transport, Agent Cards, request routing, or Pi-facing tools.
- Creating a broker, daemon, database, remote network transport, or orchestration model.
- Guaranteeing mathematical uniqueness from a four-character display suffix.
- Treating a project label as a filesystem path or granting cross-room access.

## Decisions

### Use Pi's native session UUID for logical session identity

`ctx.sessionManager.getSessionId()` is already persisted in the Pi session header. It remains stable when an extension runtime reloads and identifies the selected session when Pi resumes it. Pi creates a new value for `/new` and `/fork`; the extension only observes these native lifecycle transitions. A custom `appendEntry()` identity would duplicate Pi state and could be copied through a fork unless special override logic were added.

The extension SHALL read the session ID at `session_start`, never generate or persist a replacement logical session ID. Session ID is metadata and grouping information, not the route target.

### Generate a runtime UUID per started extension runtime

At each `session_start`, the extension creates a fresh `crypto.randomUUID()` runtime ID. It is not created during module evaluation, because Pi may load an extension factory without starting a session. It is never restored from session entries and is replaced on reload, resume, new-session, fork, process restart, or any other new runtime.

The runtime ID owns the registry record, endpoint, lease, and canonical peer address. Shutdown is idempotent and only affects the current runtime ID.

### Namespace and precedence P2P options

The extension registers `--p2p-name` and `--p2p-project` rather than generic flags that could conflict with another package. These are process-level configuration values. `--p2p-name`, when present, is the network-name override; otherwise the extension uses Pi's current session name. `--p2p-project`, when present, is an explicit project-room label and has priority over automatic room derivation.

Pi's native `/name` and `session_info_changed` remain authoritative only when no P2P name override is configured. A name change updates the display field without changing session ID, runtime ID, room, or endpoint.

### Normalize names into canonical labels

Name input is NFKC-normalized, lowercased, and validated by rejecting Unicode control and format characters (`Cc`/`Cf`). Unicode letters and numbers are retained; whitespace, punctuation, and symbols become hyphens. Repeated hyphens and leading/trailing hyphens are removed. The normalized base is bounded to 48 Unicode code points. An explicitly supplied value that becomes empty is rejected; when no name is supplied, the fallback base is `agent`.

The published network name is `<base>-<suffix>`. The suffix is the first four lowercase Crockford-base32 characters of the SHA-256 digest of the runtime UUID. It changes with the runtime, not with a session-name rename. The suffix improves usability but is not the security or routing identity; four-character collisions remain safe because resolution can return full runtime addresses.

### Use exact runtime addresses and explicit ambiguity errors

A peer record and protocol target carry the full runtime UUID. A human-facing network name is a lookup key only. A lookup that finds multiple live records for the same normalized name MUST return all candidate runtime addresses and MUST NOT pick one or silently rename either peer. A display suffix collision is handled the same way. Cross-room records are never considered during lookup.

### Derive an opaque versioned room ID

Room resolution is evaluated once for each runtime using this order:

1. normalized `--p2p-project` label;
2. canonical Git common directory;
3. canonical working directory.

The explicit project is a label, not a path. For automatic derivation, the extension invokes Git without a shell using the current working directory and obtains an absolute `--git-common-dir`; it canonicalizes the result with filesystem realpath. If Git is unavailable or the directory is not a Git repository, it canonicalizes the working directory instead.

The room ID is `r1-` followed by 128 bits of SHA-256 over a source discriminator and normalized input, for example `explicit\0frontend`, `git\0<common-dir>`, or `cwd\0<directory>`. Only the validated opaque room ID is used in registry paths. The source discriminator prevents an explicit label from accidentally sharing an ID with a path. Same-repository worktrees therefore hash the same Git common directory; unrelated repositories and non-Git directories do not share a global default room.

A runtime belongs to exactly one room. Discovery, target resolution, and protocol validation require exact room equality; there is no implicit cross-room fallback.

### Use lease-based stale-record cleanup

Records are keyed by runtime UUID under a per-user registry room directory. A record contains the runtime ID, room ID, normalized network name, endpoint, and `leaseExpiresAt`. Writes use a unique temporary file and atomic rename.

A live runtime renews approximately every 10 seconds with a 30-second lease. Normal `session_shutdown` removes only its exact record. If the process crashes, peers ignore records after expiry and may garbage-collect them. A definitive missing-endpoint failure may remove the exact still-matching record; a mere timeout does not immediately delete an unexpired peer. Replacement runtimes always use new UUIDs and new endpoint names, so stale records cannot be overwritten or mistaken for replacements.

### Alternatives considered

- **Extension-persisted session ID:** rejected because Pi already persists the correct identity and fork copying would require extra repair logic.
- **Session-ID-derived name suffix:** rejected because old and replacement runtimes would share a visible address during stale-record windows.
- **Global `default` room:** rejected because unrelated repositories would discover one another accidentally.
- **Raw project/path directory names:** rejected because traversal, platform-specific characters, and long socket paths would become filesystem concerns.
- **All-to-all liveness polling:** rejected; leases provide presence, while bounded probes are reserved for uncertain target failures.

## Risks / Trade-offs

- **Four-character suffix collisions** → Keep full runtime UUIDs in all machine-actionable fields and return candidate addresses on ambiguous lookup.
- **Runtime names change after reload** → This makes stale replacement instances visibly distinct; the full session ID remains stable for grouping.
- **Name normalization merges distinct inputs** → Treat the normalized result as the contract and report ambiguity rather than auto-renaming.
- **A process crashes before cleanup** → Lease expiry is authoritative; cleanup is opportunistic and exact-record only.
- **A repository is moved or accessed through a different canonical path** → Its automatic room changes; users can select an explicit project when they need a stable shared namespace.
- **Git is unavailable or a directory is not a repository** → Fall back deterministically to the canonical working directory, which intentionally does not merge Git worktrees.
- **Unicode display labels are harder to render or type** → Machine routing does not parse display labels; runtime UUID addresses remain available.

## Migration Plan

There is no existing identity or registry data to migrate. The first implementation will create versioned `r1-` room directories and runtime-keyed records. Future incompatible identity or room changes must use a new room/version prefix rather than interpreting old records under new rules. Rollback consists of stopping the new runtime and removing only its own records; no persistent Pi session data is rewritten.

## Open Questions

No product-level questions remain from the exploration. Exact constants, filesystem permissions, and the concrete registry/transport interfaces can be implemented against these contracts and covered by tests.
