# Raw `node:net` local-IPC candidate

This fixture area contains the bounded raw candidate and its integration/process
checks. It is intentionally independent of `src/transport` and Pi message/task
semantics.

Run the complete fixture evidence matrix on the native runner with:

```sh
node --version
npx vitest run tests/fixtures/local-ipc/endpoint.test.ts tests/fixtures/local-ipc-spike --reporter=verbose
npm run typecheck
npx eslint tests/fixtures/local-ipc tests/fixtures/local-ipc-spike
```

The same suite uses POSIX Unix socket paths on Linux/macOS and named-pipe paths
in the `\\?\\pipe\\` namespace on Windows. The native endpoint test asserts the
active platform's endpoint kind; POSIX stale-socket and Windows named-pipe
process tests record an explicit limitation on non-native runners rather than
silently skipping. Real Windows named-pipe cleanup and real macOS socket
behavior require their respective CI runners.

`RawNetTransport` accepts opaque bounded bytes, uses one four-byte big-endian
length-prefixed request and response per connection, validates optional JSON
payloads before handler invocation, applies absolute connect/write/read
phase deadlines, supports cancellation, and closes owned resources. Binding and
shutdown transitions are serialized; shutdown rejects new requests, force-closes
active sockets after the primary deadline, and confirms the bounded forced drain
before cleaning the endpoint. A complete frame dispatches immediately without
requiring peer EOF, while trailing bytes remain a protocol error. Server responses
force-close one-operation connections after their bytes are flushed, including when
the peer keeps its readable side open. POSIX stale-path cleanup only removes a
default-generated socket after `lstat` confirms a socket and a bounded connection
probe confirms no live listener; it atomically quarantines the entry, verifies its
identity after rename, and restores a replacement without overwriting or unlinking it.
