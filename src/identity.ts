import { randomUUID } from 'node:crypto';

import { DEFAULT_REQUEST_TTL_MS, DEDUPE_RETENTION_GRACE_MS } from './config.js';
import { asRuntimeId, asSessionId, type RuntimeId, type SessionId } from './protocol/messages.js';
import { isRoomId, roomStorageKey, type RoomId } from './room.js';

export type { RuntimeId, SessionId } from './protocol/messages.js';

/**
 * Identity carried by protocol envelopes and discovery records.
 *
 * A session can have more than one runtime over its lifetime (for example,
 * after `/reload`). The runtime ID is therefore the endpoint identity; the
 * session ID is only the stable logical-session identity.
 */
export interface SessionRuntimeIdentity {
  readonly sessionId: SessionId;
  readonly runtimeId: RuntimeId;
}

/** Alias used by callers that refer to the pair as a runtime identity. */
export type RuntimeIdentity = SessionRuntimeIdentity;

/** A native Pi session-manager shape, kept local so this module has no Pi dependency. */
export interface SessionManagerLike {
  getSessionId(): string;
}

/** Factory seam for deterministic lifecycle tests. */
export type RuntimeIdFactory = () => string;

/** A full machine-actionable runtime address, scoped to an exact room. */
export interface RuntimeAddress {
  readonly runtimeId: RuntimeId;
  readonly roomId: RoomId;
}

/** Error raised when an identity input is empty or contains unsafe control data. */
export class IdentityInputError extends TypeError {
  constructor(message: string) {
    super(message);
    this.name = 'IdentityInputError';
  }
}

const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const CONTROL_CHARACTER_PATTERN = /\p{C}/u;
const MAX_RUNTIME_ID_HISTORY_ENTRIES = 4_096;
const DEFAULT_RUNTIME_ID_RETENTION_MS = DEFAULT_REQUEST_TTL_MS + DEDUPE_RETENTION_GRACE_MS;
function finiteNow(now: () => number): number {
  const value = now();
  if (!Number.isFinite(value)) {
    throw new RangeError('runtime identity clock must return a finite number');
  }
  return value;
}

function validateRuntimeIdRetention(value: number | undefined): number {
  const retention = value ?? DEFAULT_RUNTIME_ID_RETENTION_MS;
  if (
    retention !== Infinity &&
    (!Number.isSafeInteger(retention) || retention < DEFAULT_RUNTIME_ID_RETENTION_MS)
  ) {
    throw new RangeError(
      `runtimeIdRetentionMs must be Infinity or a safe integer of at least ${DEFAULT_RUNTIME_ID_RETENTION_MS}`,
    );
  }
  return retention;
}

function retainedUntil(nowMs: number, retentionMs: number): number {
  if (retentionMs === Infinity) {
    return Infinity;
  }
  const deadline = nowMs + retentionMs;
  if (!Number.isSafeInteger(deadline)) {
    throw new RangeError('runtime identity retention deadline must be a safe timestamp');
  }
  return deadline;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function requireIdentifier(value: string, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new IdentityInputError(`${field} must be a non-empty string`);
  }

  if (CONTROL_CHARACTER_PATTERN.test(value)) {
    throw new IdentityInputError(`${field} must not contain control characters`);
  }

  return value;
}

function requireSessionId(value: string): SessionId {
  return asSessionId(requireIdentifier(value, 'sessionId'));
}

function requireRuntimeId(value: string): RuntimeId {
  return asRuntimeId(requireIdentifier(value, 'runtimeId'));
}

export function isSafeIdentifier(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && !CONTROL_CHARACTER_PATTERN.test(value);
}

/** Return whether a value has the UUIDv4 representation used by runtime IDs. */
export function isUuidV4(value: unknown): value is RuntimeId {
  return typeof value === 'string' && UUID_V4_PATTERN.test(value);
}

/** Validate and create one runtime ID using the supplied (or cryptographic) factory. */
export function createRuntimeId(factory: RuntimeIdFactory = randomUUID): RuntimeId {
  return requireRuntimeId(factory());
}

/**
 * Create the identity for one started extension runtime.
 *
 * `sessionId` must be read from Pi's native session manager at `session_start`.
 * Calling this function again with the same session ID intentionally preserves
 * the logical identity while generating a new runtime ID.
 */
export function createRuntimeIdentity(
  sessionId: string,
  runtimeIdFactory: RuntimeIdFactory = randomUUID,
): SessionRuntimeIdentity {
  const stableSessionId = requireSessionId(sessionId);
  const runtimeId = createRuntimeId(runtimeIdFactory);

  return Object.freeze({ sessionId: stableSessionId, runtimeId });
}

/** Explicitly named alias for callers that prefer the pair's full name. */
export const createSessionRuntimeIdentity = createRuntimeIdentity;

/** Create a runtime identity from a Pi-like native session manager. */
export function createRuntimeIdentityFromSessionManager(
  sessionManager: SessionManagerLike,
  runtimeIdFactory: RuntimeIdFactory = randomUUID,
): SessionRuntimeIdentity {
  return createRuntimeIdentity(sessionManager.getSessionId(), runtimeIdFactory);
}

/** Type guard for values received from discovery or a protocol boundary. */
export function isSessionRuntimeIdentity(value: unknown): value is SessionRuntimeIdentity {
  if (!isPlainObject(value) || !hasOwn(value, 'sessionId') || !hasOwn(value, 'runtimeId')) {
    return false;
  }

  const candidate = value as { sessionId: unknown; runtimeId: unknown };
  return isSafeIdentifier(candidate.sessionId) && isSafeIdentifier(candidate.runtimeId);
}
function runtimeIdForAddress(runtime: RuntimeId | SessionRuntimeIdentity): RuntimeId {
  if (typeof runtime === 'string') {
    return requireRuntimeId(runtime);
  }
  if (!isPlainObject(runtime) || !hasOwn(runtime, 'runtimeId')) {
    throw new IdentityInputError('runtime identity must be a plain object with an own runtimeId');
  }
  return requireRuntimeId(runtime.runtimeId);
}

/** Create an exact runtime address; the runtime UUID and room are both required for routing. */
export function createRuntimeAddress(
  runtime: RuntimeId | SessionRuntimeIdentity,
  roomId: RoomId,
): RuntimeAddress {
  const runtimeId = runtimeIdForAddress(runtime);
  return Object.freeze({
    runtimeId,
    roomId: roomStorageKey(roomId),
  });
}

/** Type guard for an exact runtime address. */
export function isRuntimeAddress(value: unknown): value is RuntimeAddress {
  if (!isPlainObject(value) || !hasOwn(value, 'runtimeId') || !hasOwn(value, 'roomId')) {
    return false;
  }

  const candidate = value as { runtimeId: unknown; roomId: unknown };
  return isSafeIdentifier(candidate.runtimeId) && isRoomId(candidate.roomId);
}

/** Exact comparison for machine-actionable runtime addresses. */
export function runtimeAddressesEqual(left: RuntimeAddress, right: RuntimeAddress): boolean {
  const leftRoomId = roomStorageKey(left.roomId);
  const rightRoomId = roomStorageKey(right.roomId);
  const leftRuntimeId = requireRuntimeId(left.runtimeId);
  const rightRuntimeId = requireRuntimeId(right.runtimeId);

  return leftRuntimeId === rightRuntimeId && leftRoomId === rightRoomId;
}

/** Alias emphasizing that a runtime address is the peer address. */
export const peerAddressesEqual = runtimeAddressesEqual;

/**
 * Owns the identity of the currently live runtime.
 *
 * Every `start`/`reload` call creates a fresh runtime ID. Shutdown accepts an
 * optional runtime ID so a delayed shutdown from an old runtime cannot clear a
 * replacement runtime's identity. Shutdown is idempotent for the current
 * runtime and for an already stopped lifecycle.
 */
export class RuntimeIdentityLifecycle {
  private readonly runtimeIdFactory: RuntimeIdFactory;
  private readonly now: () => number;
  private readonly runtimeIdRetentionMs: number;
  private readonly issuedRuntimeIds = new Map<RuntimeId, number>();
  private currentIdentity: SessionRuntimeIdentity | undefined;

  constructor(options: RuntimeIdentityLifecycleOptions | RuntimeIdFactory = {}) {
    const lifecycleOptions: RuntimeIdentityLifecycleOptions =
      typeof options === 'function' ? { runtimeIdFactory: options } : options;
    this.runtimeIdFactory = lifecycleOptions.runtimeIdFactory ?? randomUUID;
    this.now = lifecycleOptions.now ?? (() => Date.now());
    this.runtimeIdRetentionMs = validateRuntimeIdRetention(lifecycleOptions.runtimeIdRetentionMs);
  }

  get current(): SessionRuntimeIdentity | undefined {
    return this.currentIdentity;
  }

  get state(): 'active' | 'stopped' {
    return this.currentIdentity === undefined ? 'stopped' : 'active';
  }

  /** Start a runtime for the session ID read from Pi at `session_start`. */
  start(sessionId: string): SessionRuntimeIdentity {
    const stableSessionId = requireSessionId(sessionId);
    const nowMs = finiteNow(this.now);
    this.pruneIssuedRuntimeIds(nowMs);
    let runtimeId = createRuntimeId(this.runtimeIdFactory);

    // A custom test factory may return a duplicate. Do not allow a lifecycle
    // to issue the same endpoint identity twice while its tombstone is retained.
    if (this.issuedRuntimeIds.has(runtimeId)) {
      do {
        runtimeId = createRuntimeId(randomUUID);
      } while (this.issuedRuntimeIds.has(runtimeId));
    }

    if (this.issuedRuntimeIds.size >= MAX_RUNTIME_ID_HISTORY_ENTRIES) {
      throw new IdentityInputError('runtime identity history has reached its bounded capacity');
    }

    const previousIdentity = this.currentIdentity;
    if (previousIdentity !== undefined) {
      this.issuedRuntimeIds.set(
        previousIdentity.runtimeId,
        retainedUntil(nowMs, this.runtimeIdRetentionMs),
      );
    }
    this.issuedRuntimeIds.set(runtimeId, Infinity);
    this.currentIdentity = Object.freeze({ sessionId: stableSessionId, runtimeId });
    return this.currentIdentity;
  }

  private pruneIssuedRuntimeIds(nowMs: number): void {
    for (const [runtimeId, retainedUntil] of this.issuedRuntimeIds) {
      if (retainedUntil <= nowMs) {
        this.issuedRuntimeIds.delete(runtimeId);
      }
    }
  }

  /** Start a runtime using a Pi-like native session manager. */
  startFromSessionManager(sessionManager: SessionManagerLike): SessionRuntimeIdentity {
    return this.start(sessionManager.getSessionId());
  }

  /** Replace the current runtime while retaining its logical session identity. */
  reload(): SessionRuntimeIdentity {
    if (this.currentIdentity === undefined) {
      throw new IdentityInputError('cannot reload before a runtime has started');
    }

    return this.start(this.currentIdentity.sessionId);
  }

  /**
   * Release the current runtime. Passing an old runtime identity after replacement
   * is a no-op and returns false; repeated shutdown is safe and returns true.
   */
  shutdown(runtime?: RuntimeId | SessionRuntimeIdentity): boolean {
    if (this.currentIdentity === undefined) {
      return true;
    }

    const runtimeId = typeof runtime === 'string' ? runtime : runtime?.runtimeId;
    if (runtimeId !== undefined && runtimeId !== this.currentIdentity.runtimeId) {
      return false;
    }
    const nowMs = finiteNow(this.now);
    this.pruneIssuedRuntimeIds(nowMs);
    this.issuedRuntimeIds.set(
      this.currentIdentity.runtimeId,
      retainedUntil(nowMs, this.runtimeIdRetentionMs),
    );
    this.currentIdentity = undefined;
    return true;
  }

  /** Alias used by resource-owning lifecycle adapters. */
  close(runtime?: RuntimeId | SessionRuntimeIdentity): boolean {
    return this.shutdown(runtime);
  }

  /** Return whether an identity belongs to this currently live runtime. */
  isCurrent(identityOrRuntimeId: SessionRuntimeIdentity | RuntimeId): boolean {
    const runtimeId =
      typeof identityOrRuntimeId === 'string' ? identityOrRuntimeId : identityOrRuntimeId.runtimeId;
    return this.currentIdentity?.runtimeId === runtimeId;
  }
}

export interface RuntimeIdentityLifecycleOptions {
  readonly runtimeIdFactory?: RuntimeIdFactory;
  readonly now?: () => number;
  readonly runtimeIdRetentionMs?: number;
}

/** Factory form for consumers that prefer composition over class construction. */
export function createRuntimeIdentityLifecycle(
  options: RuntimeIdentityLifecycleOptions | RuntimeIdFactory = {},
): RuntimeIdentityLifecycle {
  return new RuntimeIdentityLifecycle(options);
}

/** Short alias for lifecycle integrations. */
export const createIdentityLifecycle = createRuntimeIdentityLifecycle;

/** Compare two identities exactly, including the live runtime generation. */
export function runtimeIdentitiesEqual(
  left: SessionRuntimeIdentity,
  right: SessionRuntimeIdentity,
): boolean {
  return left.sessionId === right.sessionId && left.runtimeId === right.runtimeId;
}

/** Alias for callers that use the shorter runtime terminology. */
export const isSameRuntimeIdentity = runtimeIdentitiesEqual;
