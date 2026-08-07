# Pi-to-Pi

Pi-to-Pi is an independent community extension for direct communication between
independent [Pi](https://github.com/earendil-works/pi) sessions.

This repository contains the package and implementation foundation for the project. The identity,
configuration, room, peer naming, lookup, registry, and lease modules are implemented; end-to-end
discovery wiring, peer messaging, transport, and orchestration are not implemented yet.

## Install

The package can be installed as a Pi package from this repository:

```bash
pi install git:github.com/FetchUpstream/pi-to-pi
```

The extension registers its namespaced flags and wires identity, configuration, room resolution, registry
publication, and lease renewal into Pi's native session lifecycle without allocating sockets, timers,
watchers, or processes during module evaluation. End-to-end discovery wiring, peer messaging, transport,
and orchestration are not implemented yet.

## Identity, names, and rooms

The identity, configuration, room, naming, lookup, registry, and lease rules below describe the implemented
foundation and its module contracts. `--p2p-name` and `--p2p-project` are registered and resolved
through Pi's lifecycle, while registry publication and lease renewal are also wired into that lifecycle.
Peer transport, Agent Cards, request routing, and Pi-facing tools remain outside this release, as does
end-to-end message delivery.

### Session and runtime identity

Pi-to-Pi distinguishes the logical Pi conversation from the running extension endpoint:

- The logical session ID is Pi's native `ctx.sessionManager.getSessionId()`, read at `session_start`. It remains stable when the extension runtime reloads and identifies a resumed saved session. Pi supplies a new logical session ID for a new or forked session. The extension does not generate or persist a replacement session ID.
- Each started extension runtime creates a fresh `crypto.randomUUID()` runtime ID. A reload, resume, new session, fork, process restart, or other runtime replacement therefore gets a different runtime ID, even when the logical session ID is unchanged.
- The runtime ID owns the endpoint, registry record, lease, and canonical peer address. The session ID is metadata for grouping, not a routing target.

A normal `session_shutdown` releases resources for only the current runtime ID and is safe to handle more than once. A replacement runtime never reuses the old runtime ID.

### Names and addresses

The namespaced `--p2p-name` option is an explicit network-name override:

- When `--p2p-name` is present, its normalized value is used instead of Pi's native session name.
- Without the override, the base comes from Pi's current session name, or falls back to `agent` when no session name exists. Pi's `session_info_changed` name changes update the published base only when no override is configured; they do not change the session ID, runtime ID, room, or endpoint.
- Normalization applies NFKC, lowercases, rejects Unicode control and format characters (`Cc`/`Cf`), retains Unicode letters and numbers, converts runs of whitespace, punctuation, and symbols to `-`, collapses and trims hyphens, and bounds the result to 48 Unicode code points. An explicitly supplied value that becomes empty is rejected.

The published network name is `<base>-<suffix>`, where `<suffix>` is the first four lowercase Crockford-base32 characters of the SHA-256 digest of the runtime UUID. The suffix identifies the runtime generation, so it changes when the runtime is replaced and does not change merely because the Pi session is renamed. Four characters are not a uniqueness guarantee.

The full runtime UUID is the canonical machine-actionable peer address. A network name is only a human-facing lookup key. If a name matches more than one live record, resolution returns all candidate full runtime addresses and reports ambiguity; it does not choose a peer or silently rename one. Exact runtime addressing is still subject to room validation.

### Project rooms and automatic room derivation

The namespaced `--p2p-project` option is an explicit project-room label, not a filesystem path. The label is normalized and validated; Unicode control or format characters (`Cc`/`Cf`) or a value that becomes empty are rejected rather than selecting a global default room. Room resolution is performed once for a runtime using this precedence:

1. The normalized `--p2p-project` label, when supplied.
2. The canonical Git common directory, when the working directory is in a Git repository.
3. The canonical working directory, when Git is unavailable or the directory is not a repository.

Automatic Git discovery uses an argument-safe invocation from the current working directory and canonicalizes the absolute Git common directory with filesystem realpath. Consequently, Git worktrees for one repository share a room, while unrelated repositories do not. The fallback canonical working directory keeps different non-Git directories isolated and makes equivalent path spellings and symlinks converge.

Room IDs are opaque, versioned, and filesystem-safe: `r1-` followed by 128 bits of SHA-256 over a source discriminator and normalized input. The explicit, Git, and working-directory sources are kept distinct, so a project label cannot accidentally share an ID with a path. Peers using the same normalized explicit label derive the same room, while different labels remain isolated. Raw project labels and filesystem paths are never used as registry directory names.

Each runtime belongs to exactly one room. Discovery and target validation require exact room equality; there is no implicit cross-room fallback, and a target from another room is rejected before its endpoint is opened.

### Leases and stale peers

Registry records are keyed by the full runtime UUID in a per-user room directory. A record includes the runtime ID, logical session ID, room ID, normalized network name, endpoint, and lease expiry. Publication uses a unique temporary file followed by an atomic rename.

A live runtime renews its own lease approximately every 10 seconds, with a 30-second lease window. Normal shutdown removes only its exact runtime record and is idempotent. If a process crashes, its record can remain on disk, but lease expiry is authoritative: discovery ignores an expired record and may garbage-collect it. A replacement runtime always has a new runtime UUID and endpoint, so it cannot be mistaken for or overwritten by the stale record.

A definitive missing-endpoint or connection-refused result may remove the exact unchanged record even before expiry. A timeout alone does **not** immediately delete an unexpired record; it remains available until a later renewal or lease expiry. Missing, malformed, or changed records are skipped rather than used to delete another runtime's record.

## Attribution and independence

The Pi-to-Pi communication concept was originated by **IndyDevDan**. This is an
independent community implementation and does not copy the original
implementation.

Pi-to-Pi is not an official Pi project or a replacement for an orchestration
framework. It will not introduce a broker, daemon, database, or remote
networking dependency for the local extension.
