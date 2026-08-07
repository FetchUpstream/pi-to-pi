# Unit tests

Unit tests cover the pure v1 protocol validators, task-state store, runtime-scoped deduplication and routing boundary. The routing tests use direct inbound hooks for deterministic authorization, correlation and error behavior.

Run them with:

```bash
npm test -- --run tests/unit
```
