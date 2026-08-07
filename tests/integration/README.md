# Integration tests

This directory is reserved for composed Pi-to-Pi components and future real-Pi integration tests.
It may reuse the generic support barrel at `../support/index.js` for isolated workspaces, bounded
waits, managed child processes, JSON-lines parsing, and cleanup, without importing final protocol
code merely to control a fixture.

The current mandatory process suite is a Node harness in `tests/process/`: it uses standalone
fixtures from `tests/fixtures/`, not interactive or real Pi processes. Its lifecycle controls cover
readiness, command delivery, bounded timeout, abrupt termination, diagnostics, and cleanup only.

## Future real-Pi boundary

A later integration change may add tests that launch or coordinate real Pi processes and exercise
composed protocol, registry, transport, routing, or Pi behavior. Those tests are distinct from the
portable Node fixture suite, may have different environment requirements, and must not be treated as
required by the baseline process harness. They should retain the same explicit workspace ownership
and bounded cleanup/diagnostic expectations where the generic support applies.
