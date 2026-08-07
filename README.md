# Pi-to-Pi

Pi-to-Pi is an independent community extension for direct communication between
independent [Pi](https://github.com/earendil-works/pi) sessions.

This repository contains the package and test foundation for the project. Peer
messaging, discovery, transport, and orchestration are intentionally not
implemented yet.

## Install

The package can be installed as a Pi package from this repository:

```bash
pi install git:github.com/FetchUpstream/pi-to-pi
```

The current scaffold only verifies that the extension can load and participate
in Pi's session lifecycle without starting background resources.

## Attribution and independence

The Pi-to-Pi communication concept was originated by **IndyDevDan**. This is an
independent community implementation and does not copy the original
implementation.

Pi-to-Pi is not an official Pi project or a replacement for an orchestration
framework. It will not introduce a broker, daemon, database, or remote
networking dependency for the local extension.
