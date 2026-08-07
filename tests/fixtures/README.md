# Protocol fixtures

These JSON files are transport-neutral v1 envelope examples:

- `v1-message-request.json` is an initial task-bearing request. Its `operationId` and `requestId` are intentionally equal.
- `v1-message-reply.json` is the later terminal reply. It uses a new `operationId` and references the original `requestId`.

The reply is validated with the original request deadline as out-of-band context, as required by the v1 validator. Fixtures contain no binding credentials or transport framing. A transport adapter must deliver these envelopes unchanged, authenticate the binding separately, and return correlated operation responses.
