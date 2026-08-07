# Pi-to-Pi

Pi-to-Pi is an independent community extension for direct communication between
independent [Pi](https://github.com/earendil-works/pi) sessions.

This repository implements the transport-independent Pi-to-Pi v1 protocol: explicit request/reply correlation, notifications, peer discovery, bounded admission, task status/cancellation, expiry, authentication and runtime-scoped deduplication.

The protocol core is implemented under `src/protocol/`, routing under `src/router/`, and Pi lifecycle/tool integration under `src/pi/`. Transport adapters carry typed envelopes and operation responses but do not choose a framing protocol.

## Protocol reference

The normative contract is [`openspec/changes/define-pi-to-pi-v1-protocol/specs/pi-to-pi-v1-protocol/spec.md`](openspec/changes/define-pi-to-pi-v1-protocol/specs/pi-to-pi-v1-protocol/spec.md). It defines `peer.describe`, `message.request`, `message.reply`, `message.notify`, `task.status`, and `task.cancel`. Wire examples are in [`tests/fixtures/`](tests/fixtures/).

The v1 boundary does not provide offline delivery, runtime task handoff, streaming, attachments, or a broker. A transport binding is responsible for endpoint delivery and authentication metadata; application credentials are not protocol content.

## Install

The package can be installed as a Pi package from this repository:

```bash
pi install git:github.com/FetchUpstream/pi-to-pi
```

## Attribution and independence

The Pi-to-Pi communication concept was originated by **IndyDevDan**. This is an
independent community implementation and does not copy the original
implementation.

Pi-to-Pi is not an official Pi project or a replacement for an orchestration
framework. It will not introduce a broker, daemon, database, or remote
networking dependency for the local extension.
