import * as crypto from 'node:crypto';

import { asRoomId, type RoomId } from './room.js';

declare const sessionIdBrand: unique symbol;
declare const runtimeIdBrand: unique symbol;
declare const normalizedNameBrand: unique symbol;
declare const projectNameBrand: unique symbol;

/** Stable logical identity supplied by Pi's session manager. */
export type SessionId = string & { readonly [sessionIdBrand]: 'SessionId' };

/** Ephemeral identity of one started Pi-to-Pi runtime. */
export type RuntimeId = string & { readonly [runtimeIdBrand]: 'RuntimeId' };

/** Canonical, already-normalized network display base. */
export type NormalizedName = string & { readonly [normalizedNameBrand]: 'NormalizedName' };

/** Canonical project label used by explicit room configuration. */
export type ProjectName = string & { readonly [projectNameBrand]: 'ProjectName' };

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

/** Brand a non-empty native session identifier. */
export function asSessionId(value: string): SessionId {
  assertIdentityText(value, 'session ID');
  return value as SessionId;
}

/** Brand a non-empty runtime identifier. Generated IDs are UUIDs. */
export function asRuntimeId(value: string): RuntimeId {
  assertIdentityText(value, 'runtime ID');
  return value as RuntimeId;
}

/** Return whether a value has UUID text syntax. */
export function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
}

/** Brand an already-normalized network name. */
export function asNormalizedName(value: string): NormalizedName {
  const codePoints = Array.from(value);
  if (
    codePoints.length === 0 ||
    codePoints.length > 48 ||
    !/^[\p{L}\p{N}]+(?:-[\p{L}\p{N}]+)*$/u.test(value)
  ) {
    throw new Error(`Invalid normalized peer name: ${JSON.stringify(value)}`);
  }
  return value as NormalizedName;
}

/** Brand an explicit project label after configuration validation. */
export function asProjectName(value: string): ProjectName {
  assertIdentityText(value, 'project name');
  if (hasControlCharacter(value)) {
    throw new Error('Project name must not contain control characters');
  }
  return value as ProjectName;
}

/** Create a session identity from Pi's native session manager value. */
export function createSessionIdentity(sessionId: string): SessionIdentity {
  return Object.freeze({ sessionId: asSessionId(sessionId) });
}

/**
 * Create a fresh runtime identity.
 *
 * The default runtime ID is generated only when this function is called. In
 * particular, importing this module never allocates a runtime identity.
 */
export function createRuntimeIdentity(sessionId: string, runtimeId?: string): RuntimeIdentity {
  return Object.freeze({
    ...createSessionIdentity(sessionId),
    runtimeId: asRuntimeId(runtimeId ?? crypto.randomUUID()),
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
  shutdown(): void;
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
  let active: RuntimeIdentity | undefined;

  return {
    start(sessionId: string): RuntimeIdentity {
      active = createRuntimeIdentity(sessionId);
      return active;
    },
    shutdown(): void {
      active = undefined;
    },
    current(): RuntimeIdentity | undefined {
      return active;
    },
  };
}

function assertIdentityText(value: string, label: string): void {
  if (typeof value !== 'string' || value.length === 0 || hasControlCharacter(value)) {
    throw new Error(`Invalid ${label}`);
  }
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f)) {
      return true;
    }
  }
  return false;
}
