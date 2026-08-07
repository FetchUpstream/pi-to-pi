# Integration tests

These tests compose the protocol, router, task store, deduplication boundary and a fake transport to exercise two-runtime behavior. They cover admission, queue backpressure, terminal outcomes, notifications, status/cancellation, expiry, authentication, room isolation, invalid replies, unreachable delivery and runtime replacement.

Run them with:

```bash
npm test -- --run tests/integration
```

The fake transport intentionally carries typed envelopes and operation responses without choosing a framing protocol. Real transport bindings must preserve that boundary.
