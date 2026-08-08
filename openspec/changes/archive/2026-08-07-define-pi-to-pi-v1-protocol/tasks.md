## 1. Contract review

- [x] 1.1 Review the envelope, operation, and response-correlation requirements against the issue #3 acceptance criteria, including concurrent and nested requests.
- [x] 1.2 Confirm the `runtimeId` wire mapping to the existing `runtimeInstanceId` discovery-card field and keep Agent Card version `1` distinct from wire version `1.0`.
- [x] 1.3 Review task transitions, terminal immutability, cooperative cancellation, absolute expiry, queue limits, and runtime-reload behavior for deterministic edge cases.
- [x] 1.4 Review content/schema, compatibility, deduplication, authentication, room isolation, and error requirements for transport independence and bounded resource use.

## 2. Publish the authoritative contract

- [x] 2.1 Validate that every normative requirement has at least one executable scenario and that the request/reply examples satisfy the envelope rules.
- [x] 2.2 Sync the approved `pi-to-pi-v1-protocol` capability into `openspec/specs/pi-to-pi-v1-protocol/spec.md` when this change is accepted or archived.
- [x] 2.3 Update repository protocol documentation to point implementation issues at the canonical v1 specification without duplicating or contradicting its requirements.
- [x] 2.4 Run OpenSpec validation and record the clean repository/specification verification.

## 3. Handoff to implementation waves

- [x] 3.1 Produce an implementation map for the protocol-engine issue covering protocol types, validation, task store, deduplication, queue policy, and router boundaries without changing source code in this issue.
- [x] 3.2 Confirm the protocol-engine work remains transport- and Pi-UI-independent and can use fake bindings for conformance tests.
- [x] 3.3 Confirm Pi lifecycle/tools and concrete transport/end-to-end wiring remain in their dependent issues and do not duplicate foundation contracts.
