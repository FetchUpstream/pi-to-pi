# HTTP-over-local-IPC comparison fixture

This directory contains the throwaway HTTP candidate for the local-IPC spike. It
uses only Node built-ins (`node:http`, `node:net`, and `node:fs`) and imports
only the shared endpoint/deadline fixtures; it does not import `src/` or any Pi
message/task module.

Run the focused candidate checks with:

```sh
node -e "const [major, minor] = process.versions.node.split('.').map(Number); if (major < 22 || (major === 22 && minor < 19)) { console.error('Node >=22.19.0 required; found ' + process.version); process.exit(1); }"
node --version
npx vitest run tests/fixtures/local-ipc-http/http-candidate.test.ts --reporter=verbose
```

`http-candidate.ts` binds `http.createServer()` to the generated Unix socket or
Windows named-pipe endpoint and sends one `POST /` request with
`http.request({ socketPath })`. The client sets `agent: false` and both sides
send `Connection: close`, so each operation has one connection. Request and
response body limits, absolute connect/write/read deadlines, abort cleanup,
parser errors, split input, truncation, and concurrent requests are covered by
the focused test.

The current evidence run is Linux. POSIX Unix-socket behavior is exercised
there; macOS and Windows require a native run. Windows endpoint generation and
HTTP `socketPath` wiring are tested as an explicit capability observation, but a
Linux run does not claim that Node's HTTP layer works with a named pipe. See the
isolated comparison report under `openspec/changes/choose-local-ipc-framing/`.
