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

/** Canonical project label used by explicit room configuration. */
export type ProjectName = NormalizedProjectLabel;

/** Stable logical session identity. */
export interface SessionIdentity {
  readonly sessionId: SessionId;
}

/** Runtime identity and the logical session that owns it. */
export interface RuntimeIdentity extends SessionIdentity {
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

/** Alias used by protocol and discovery consumers. */
export type PeerAddress = CanonicalPeerAddress;

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

/** Alias for name normalization at configuration and naming boundaries. */
export const normalizePeerName = asNormalizedName;

/** Normalize and brand an explicit project label. */
export function asProjectName(value: string): ProjectName {
  return normalizeProjectLabel(value);
}

/** Create a session identity from Pi's native session manager value. */
export function createSessionIdentity(sessionId: string): SessionIdentity {
  return Object.freeze({ sessionId: asSessionId(sessionId) });
}

/** Create a fresh runtime identity. */
export function createRuntimeIdentity(sessionId: string): RuntimeIdentity {
  return createRuntimeIdentityWithFactory(sessionId, createRuntimeId);
}

function createRuntimeIdentityWithFactory(
  sessionId: string,
  runtimeIdFactory: () => RuntimeId,
): RuntimeIdentity {
  return Object.freeze({
    ...createSessionIdentity(sessionId),
    runtimeId: runtimeIdFactory(),
  });
}

/** Generate one runtime UUID at the lifecycle boundary. */
export function createRuntimeId(): RuntimeId {
  return asRuntimeId(crypto.randomUUID());
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
