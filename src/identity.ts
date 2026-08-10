import * as crypto from 'node:crypto';

import {
  asRoomId,
  normalizeProjectLabel,
  type NormalizedProjectLabel,
  type RoomId,
} from './room.js';

declare const sessionIdBrand: unique symbol;
declare const runtimeIdBrand: unique symbol;

/** Stable logical identity supplied by Pi's session manager. */
export type SessionId = string & { readonly [sessionIdBrand]: 'SessionId' };

/** Ephemeral identity of one started Pi-to-Pi runtime. */
export type RuntimeId = string & { readonly [runtimeIdBrand]: 'RuntimeId' };

/** Canonical, already-normalized network display base. */
export type NormalizedName = NormalizedProjectLabel;

/** Runtime identity combines Pi's logical session with one ephemeral runtime. */
export interface RuntimeIdentity {
  readonly sessionId: SessionId;
  readonly runtimeId: RuntimeId;
}

/**
 * Machine-actionable peer address.
 *
 * Display names are intentionally absent: the full runtime UUID and exact room
 * are required to route a protocol operation.
 */
export interface CanonicalPeerAddress {
  readonly runtimeId: RuntimeId;
  readonly roomId: RoomId;
}

/** Brand Pi's native session identifier grammar. */
export function asSessionId(value: unknown): SessionId {
  if (!isSessionId(value)) {
    throw new Error('Invalid session ID: expected Pi native session ID grammar');
  }
  return value as SessionId;
}

/** Mirrors Pi's installed `assertValidSessionId` grammar. */
const PI_NATIVE_SESSION_ID_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/u;

/** Return whether a value matches Pi's native session-ID grammar. */
export function isSessionId(value: unknown): value is string {
  return typeof value === 'string' && PI_NATIVE_SESSION_ID_PATTERN.test(value);
}

/** Brand a canonical lowercase full UUID runtime identifier. */
export function asRuntimeId(value: unknown): RuntimeId {
  if (!isUuid(value)) {
    throw new Error('Invalid runtime ID: expected a canonical lowercase full UUID');
  }
  return value as RuntimeId;
}

/** Return whether a value has canonical lowercase full UUID text syntax. */
export function isUuid(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value)
  );
}

/** Return whether a value is a canonical lowercase UUID version 4. */
export function isUuidV4(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value)
  );
}

/** Bounded identifier grammar used at protocol boundaries for session/runtime labels. */
export function isSafeIdentifier(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/u.test(value);
}
/** Normalize and brand a canonical network display base. */
export function asNormalizedName(value: string): NormalizedName {
  return normalizeProjectLabel(value) as NormalizedName;
}

/** Create a fresh runtime identity from Pi's native session manager value. */
export function createRuntimeIdentity(sessionId: string): RuntimeIdentity {
  return createRuntimeIdentityWithFactory(sessionId, createRuntimeId);
}

function createRuntimeIdentityWithFactory(
  sessionId: string,
  runtimeIdFactory: () => RuntimeId,
): RuntimeIdentity {
  return Object.freeze({
    sessionId: asSessionId(sessionId),
    runtimeId: runtimeIdFactory(),
  });
}

/** Generate one runtime UUID at the lifecycle boundary. */
export function createRuntimeId(): RuntimeId {
  return asRuntimeId(crypto.randomUUID());
}

/**
 * Adapt an external schema's `runtimeInstanceId` field to the canonical runtime
 * identity. This validates the full UUID without introducing another identity type.
 */
export function adaptExternalRuntimeIdentity(value: {
  readonly sessionId: unknown;
  readonly runtimeInstanceId: unknown;
}): RuntimeIdentity {
  return Object.freeze({
    sessionId: asSessionId(value.sessionId),
    runtimeId: asRuntimeId(value.runtimeInstanceId),
  });
}

/** Adapt an external runtime/room pair to the canonical machine address. */
export function adaptExternalPeerAddress(value: {
  readonly runtimeInstanceId: unknown;
  readonly roomId: unknown;
}): CanonicalPeerAddress {
  if (typeof value.roomId !== 'string') {
    throw new Error('Invalid room ID: expected a string');
  }
  return Object.freeze({
    runtimeId: asRuntimeId(value.runtimeInstanceId),
    roomId: asRoomId(value.roomId),
  });
}

/** Create an exact-room canonical peer address. */
export function createCanonicalPeerAddress(
  runtimeId: RuntimeId | string,
  roomId: RoomId | string,
): CanonicalPeerAddress {
  return Object.freeze({ runtimeId: asRuntimeId(runtimeId), roomId: asRoomId(roomId) });
}

/** Stateful seam used by the Pi lifecycle wiring and lifecycle tests. */
export interface RuntimeLifecycle {
  start(sessionId: string): RuntimeIdentity;
  shutdown(runtimeId: RuntimeId | string): void;
  current(): RuntimeIdentity | undefined;
}

/**
 * Create an in-memory runtime lifecycle controller.
 *
 * It owns no sockets, timers, watchers, or session resources. Those resources
 * can be attached by later registry/transport waves without changing the
 * identity boundary.
 */
export function createRuntimeLifecycle(): RuntimeLifecycle {
  return createRuntimeLifecycleWithFactory(createRuntimeId);
}

/** Deterministic lifecycle seam for focused tests; not a production override. */
export function createRuntimeLifecycleForTesting(runtimeIdFactory: () => string): RuntimeLifecycle {
  return createRuntimeLifecycleWithFactory(() => asRuntimeId(runtimeIdFactory()));
}

function createRuntimeLifecycleWithFactory(runtimeIdFactory: () => RuntimeId): RuntimeLifecycle {
  let active: RuntimeIdentity | undefined;

  return {
    start(sessionId: string): RuntimeIdentity {
      active = createRuntimeIdentityWithFactory(sessionId, runtimeIdFactory);
      return active;
    },
    shutdown(runtimeId: RuntimeId | string): void {
      const canonicalRuntimeId = asRuntimeId(runtimeId);
      if (active?.runtimeId === canonicalRuntimeId) {
        active = undefined;
      }
    },
    current(): RuntimeIdentity | undefined {
      return active;
    },
  };
}
