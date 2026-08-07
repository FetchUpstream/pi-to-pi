# Local IPC spike fixtures

This directory contains throwaway, transport-only fixtures for the local IPC
spike. It intentionally has no imports from `src/transport` (or any Pi
message/task module); later spike tasks can add raw `node:net` candidates beside
the endpoint fixture without changing production code.

Run the focused endpoint checks with:

```sh
node -e "const [major, minor] = process.versions.node.split('.').map(Number); if (major < 22 || (major === 22 && minor < 19)) { console.error('Node >=22.19.0 required; found ' + process.version); process.exit(1); }"
npm test -- tests/fixtures/local-ipc/endpoint.test.ts
```

The endpoint fixture generates short POSIX socket paths or Windows named-pipe
namespace values, and validates POSIX paths by UTF-8 byte length before they are
handed to Node's path-based IPC APIs.
