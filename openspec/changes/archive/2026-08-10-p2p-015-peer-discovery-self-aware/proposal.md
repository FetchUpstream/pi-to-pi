## Why

`p2p_peers` currently exposes full Agent Card-shaped JSON, including transport internals, defaults, and repeated protocol metadata. The model cannot reliably distinguish its own runtime from remote peers, and discovery output consumes unnecessary context as peer count grows. Issue #33 requires a self-aware, routing-oriented presentation while preserving the existing discovery and routing authority.

## What Changes

- Make `p2p_peers` explicitly identify the active runtime using the router's canonical runtime ID.
- Exclude the local runtime from the normal remote peer list.
- Present compact, routing-relevant peer information: display name, published target, meaningful state, queue depth, and useful model identity.
- Use collision-resistant published network names as normal `p2p_send` targets.
- Omit endpoint paths, transport metadata, lease fields, protocol capabilities, nulls, and uninformative defaults from normal model-facing output.
- Preserve full runtime IDs for ambiguity resolution and diagnostic routing paths.
- Keep Agent Card discovery, exact-room isolation, runtime-ID routing, and existing ambiguity semantics unchanged.
- Add coverage for self filtering, compact formatting, load/state presentation, target round-tripping, ambiguity, and many-peer output size.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `pi-peer-communication`: Change the model-facing `p2p_peers` contract from a full Agent Card projection to a self-aware, compact discovery view while retaining safe target resolution and full identities where disambiguation requires them.

## Impact

- `src/pi/adapter.ts`: add the compact discovery projection and model-facing formatter/tool result.
- `tests/unit/pi-adapter.test.ts` and `tests/integration/production-runtime.test.ts`: update existing expectations and add issue-specific scenarios.
- `openspec/specs/pi-peer-communication/spec.md`: update the discovery-tool requirements and scenarios.
- No changes to Agent Card persistence, room derivation, local IPC, protocol envelopes, router task correlation, or transport behavior.
