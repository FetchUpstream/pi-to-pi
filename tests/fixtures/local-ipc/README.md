# Local IPC spike fixtures

This directory contains throwaway, transport-only fixtures for the local IPC
spike. It intentionally has no imports from `src/transport` (or any Pi
message/task module); later spike tasks can add raw `node:net` candidates beside
the endpoint fixture without changing production code.

Run the focused endpoint checks with:

```sh
npm test -- tests/fixtures/local-ipc/endpoint.test.ts
```

The endpoint fixture generates short POSIX socket paths or Windows named-pipe
namespace values, and validates POSIX paths by UTF-8 byte length before they are
handed to Node's path-based IPC APIs.
