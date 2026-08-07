/**
 * Runtime-scoped discovery leases.
 *
 * A lease owns presence for one runtime identity and one current endpoint.  The
 * renewal callback is deliberately supplied by the registry/transport owner;
 * this module does not choose a binding, probe peers, or persist application
 * records.  Renewal calls are serialized so a slow callback cannot publish an
 * older endpoint after a newer one.
 */

import { isSessionRuntimeIdentity, isUuidV4 } from '../identity.js';
import type { RuntimeId, SessionId, UtcTimestamp } from '../protocol/messages.js';
import type { SessionRuntimeIdentity } from '../identity.js';
/** Default live-presence window and self-renewal cadence. */
export const DEFAULT_LEASE_TTL_MS = 90_000;
export const DEFAULT_LEASE_RENEWAL_INTERVAL_MS = 30_000;

/** Compatibility aliases used by discovery callers. */
export const DEFAULT_TTL_MS = DEFAULT_LEASE_TTL_MS;
export const DEFAULT_RENEWAL_INTERVAL_MS = DEFAULT_LEASE_RENEWAL_INTERVAL_MS;

/** An opaque address owned by one runtime.  Framing and authentication stay in the binding. */
export interface RoutingEndpointDescriptor {
  readonly address: string;
  readonly kind?: string;
  readonly transport?: string;
  readonly runtimeId?: RuntimeId;
}

export type RoutingEndpoint = string | RoutingEndpointDescriptor;
export type CurrentRoutingEndpoint = RoutingEndpoint;
export type EndpointDescriptor = RoutingEndpointDescriptor;

export type LeaseState = 'idle' | 'active' | 'expired' | 'stopped';
export type LeaseLifecycleState = LeaseState;

export type LeaseClock = () => number;
export type LeaseTimer = ReturnType<typeof setInterval>;
export type LeaseAwaitable<Value> = Value | PromiseLike<Value>;

export interface LeaseScheduler {
  readonly setInterval: (handler: () => void, delayMs: number) => LeaseTimer;
  readonly clearInterval: (timer: LeaseTimer) => void;
}

/** Result optionally returned by an owner callback when the routing endpoint changes. */
export interface LeaseRenewalResult {
  readonly endpoint?: RoutingEndpoint;
  readonly identity?: LeaseOwnerIdentity;
}

export type LeaseRenewal = () => void | LeaseRenewalResult | PromiseLike<void | LeaseRenewalResult>;
export type LeaseEndpointUpdate = (endpoint: RoutingEndpoint) => void;
export type LeaseErrorHandler = (error: unknown) => void;

/** The identity that is allowed to renew one lease. */
export interface LeaseOwnerIdentity {
  readonly sessionId: SessionId;
  readonly runtimeId: RuntimeId;
}

/** Public lease state; no binding credential or application content is retained. */
export interface LeaseSnapshot {
  readonly state: LeaseState;
  readonly running: boolean;
  readonly stopped: boolean;
  readonly sessionId?: SessionId;
  readonly runtimeId?: RuntimeId;
  readonly endpoint?: RoutingEndpoint;
  readonly ttlMs: number;
  readonly renewalIntervalMs: number;
  readonly issuedAt: number | null;
  readonly lastRenewedAt: number | null;
  readonly expiresAt: number | null;
  readonly leaseExpiresAt: UtcTimestamp | null;
  readonly lastError: unknown | null;
}
export type LeaseAdvertisement = LeaseSnapshot;
export type RuntimeLeaseAdvertisement = LeaseSnapshot;

export interface SerializedLeaseOptions {
  /** The sole owner operation invoked for every renewal. */
  readonly renew: LeaseRenewal;
  /** Optional identity/endpoint metadata used by discovery advertisements. */
  readonly identity?: LeaseOwnerIdentity;
  readonly endpoint?: RoutingEndpoint;
  readonly ttlMs?: number;
  readonly renewalIntervalMs?: number;
  readonly onError?: LeaseErrorHandler;
  /** Called synchronously when the lease stops or expires. */
  readonly onStop?: () => void;
  /** Persist endpoint changes through the owning registry/binding. */
  readonly onEndpointUpdate?: LeaseEndpointUpdate;
  readonly scheduler?: LeaseScheduler;
  readonly now?: LeaseClock;
}

type LeaseConstructionOptions = Omit<SerializedLeaseOptions, 'renew'>;

export class LeaseConfigurationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'LeaseConfigurationError';
  }
}

export class LeaseStoppedError extends Error {
  public constructor() {
    super('lease renewal has been stopped');
    this.name = 'LeaseStoppedError';
  }
}

export class LeaseExpiredError extends Error {
  public constructor() {
    super('lease has expired and requires a replacement runtime identity');
    this.name = 'LeaseExpiredError';
  }
}

const defaultScheduler: LeaseScheduler = {
  setInterval: (handler, delayMs) => setInterval(handler, delayMs),
  clearInterval: (timer) => clearInterval(timer),
};

/** Maximum delay accepted by Node's timer APIs without 32-bit overflow. */
export const MAX_LEASE_TIMER_DELAY_MS = 2_147_483_647;

const MAX_ENDPOINT_KEYS = 4;
const MAX_ENDPOINT_BYTES = 64 * 1024;
function duration(value: number | undefined, fallback: number, label: string): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result <= 0) {
    throw new LeaseConfigurationError(`${label} must be a positive safe integer`);
  }
  return result;
}

function validateRenewalTiming(ttlMs: number, renewalIntervalMs: number): void {
  if (renewalIntervalMs >= ttlMs) {
    throw new LeaseConfigurationError('renewalIntervalMs must be less than ttlMs');
  }
}

function clockValue(clock: LeaseClock): number {
  const value = clock();
  if (!Number.isFinite(value)) {
    throw new LeaseConfigurationError('lease clock must return a finite timestamp');
  }
  return value;
}

function asTimestamp(value: number): UtcTimestamp {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new LeaseConfigurationError('lease expiry is outside the supported Date range');
  }
  return date.toISOString() as UtcTimestamp;
}

function sameIdentity(left: LeaseOwnerIdentity, right: LeaseOwnerIdentity): boolean {
  return left.sessionId === right.sessionId && left.runtimeId === right.runtimeId;
}

const MAX_ENDPOINT_LENGTH = 16_384;

const FORBIDDEN_ENDPOINT_KEYS = new Set([
  'apiKey',
  'apiToken',
  'capabilitySecret',
  'capabilityToken',
  'credentials',
  'password',
  'secret',
  'token',
]);

function cloneOwnerIdentity(value: LeaseOwnerIdentity): LeaseOwnerIdentity {
  if (!isIdentity(value)) {
    throw new LeaseConfigurationError('identity must contain canonical sessionId and runtimeId');
  }
  return Object.freeze({
    sessionId: value.sessionId,
    runtimeId: value.runtimeId,
  });
}

function cloneEndpoint(endpoint: RoutingEndpoint, runtimeId?: RuntimeId): RoutingEndpoint {
  const normalized = validateEndpoint(endpoint, runtimeId);
  if (typeof normalized === 'string') {
    return normalized;
  }
  return Object.freeze({
    address: normalized.address,
    ...(normalized.kind === undefined ? {} : { kind: normalized.kind }),
    ...(normalized.transport === undefined ? {} : { transport: normalized.transport }),
    ...(normalized.runtimeId === undefined ? {} : { runtimeId: normalized.runtimeId }),
  });
}

function isRenewalResult(value: unknown): value is LeaseRenewalResult {
  return (
    typeof value === 'object' && value !== null && ('endpoint' in value || 'identity' in value)
  );
}

const MAX_SNAPSHOT_DEPTH = 32;
const MAX_SNAPSHOT_NODES = 4_096;
const MAX_SNAPSHOT_ENTRIES = 256;
const MAX_SNAPSHOT_STRING_LENGTH = 2_048;
const MAX_SNAPSHOT_KEY_LENGTH = 256;
const MAX_SNAPSHOT_KEY_BYTES = 8 * 1024;
const MAX_SNAPSHOT_BYTES = 64 * 1024;
const SNAPSHOT_TRUNCATED = '[truncated]';
const SNAPSHOT_ACCESSOR = '[accessor]';
const SNAPSHOT_UNREADABLE = '[unreadable]';
const SNAPSHOT_MISSING = '[missing]';
const SNAPSHOT_UNSUPPORTED = '[unsupported]';
const SNAPSHOT_UNREADABLE_SENTINEL = Symbol('unreadable-snapshot-value');

interface SnapshotBudget {
  nodes: number;
  entries: number;
  keyBytes: number;
  bytes: number;
  truncated: boolean;
}

interface SnapshotDescriptorResult {
  readonly descriptor: PropertyDescriptor | undefined;
  readonly unreadable: boolean;
}

function addSnapshotBytes(budget: SnapshotBudget, bytes: number): boolean {
  if (!Number.isSafeInteger(bytes) || bytes < 0 || budget.bytes > MAX_SNAPSHOT_BYTES - bytes) {
    budget.truncated = true;
    return false;
  }
  budget.bytes += bytes;
  return true;
}

function snapshotMarker(budget: SnapshotBudget, marker: string): string {
  addSnapshotBytes(budget, Buffer.byteLength(marker, 'utf8'));
  return marker;
}

function snapshotString(
  value: string,
  budget: SnapshotBudget,
  maxLength = MAX_SNAPSHOT_STRING_LENGTH,
): string {
  const bounded = value.length > maxLength ? `${value.slice(0, maxLength)}…` : value;
  if (!addSnapshotBytes(budget, Buffer.byteLength(bounded, 'utf8') + 2)) {
    return SNAPSHOT_TRUNCATED;
  }
  return bounded;
}

function snapshotKey(value: string, budget: SnapshotBudget): string | undefined {
  if (value.length > MAX_SNAPSHOT_KEY_LENGTH) {
    budget.truncated = true;
    return undefined;
  }
  const bytes = Buffer.byteLength(value, 'utf8');
  if (bytes > MAX_SNAPSHOT_KEY_BYTES || budget.keyBytes > MAX_SNAPSHOT_KEY_BYTES - bytes) {
    budget.truncated = true;
    return undefined;
  }
  budget.keyBytes += bytes;
  if (!addSnapshotBytes(budget, bytes + 3)) {
    return undefined;
  }
  return value;
}

function diagnosticDescriptor(value: object, key: string): SnapshotDescriptorResult {
  try {
    return { descriptor: Object.getOwnPropertyDescriptor(value, key), unreadable: false };
  } catch {
    return { descriptor: undefined, unreadable: true };
  }
}

function diagnosticPrototype(value: object): object | null | typeof SNAPSHOT_UNREADABLE_SENTINEL {
  try {
    return Object.getPrototypeOf(value);
  } catch {
    return SNAPSHOT_UNREADABLE_SENTINEL;
  }
}

function diagnosticIsArray(value: object): boolean | typeof SNAPSHOT_UNREADABLE_SENTINEL {
  try {
    return Array.isArray(value);
  } catch {
    return SNAPSHOT_UNREADABLE_SENTINEL;
  }
}

function diagnosticIsError(value: object): boolean {
  try {
    return value instanceof Error;
  } catch {
    return false;
  }
}

function diagnosticIsDate(value: object): boolean {
  try {
    return value instanceof Date;
  } catch {
    return false;
  }
}

function diagnosticErrorField(
  value: object,
  key: 'name' | 'message',
): { readonly kind: 'value' | 'accessor' | 'missing' | 'unreadable'; readonly value?: unknown } {
  let current: object | null = value;
  const seen = new Set<object>();
  for (let depth = 0; current !== null && depth < 8; depth += 1) {
    if (seen.has(current)) {
      return { kind: 'unreadable' };
    }
    seen.add(current);
    const result = diagnosticDescriptor(current, key);
    if (result.unreadable) {
      return { kind: 'unreadable' };
    }
    if (result.descriptor !== undefined) {
      return 'value' in result.descriptor
        ? { kind: 'value', value: result.descriptor.value }
        : { kind: 'accessor' };
    }
    const prototype = diagnosticPrototype(current);
    if (prototype === SNAPSHOT_UNREADABLE_SENTINEL) {
      return { kind: 'unreadable' };
    }
    current = prototype;
  }
  return { kind: 'missing' };
}

function diagnosticEntryAvailable(budget: SnapshotBudget): boolean {
  if (budget.entries >= MAX_SNAPSHOT_ENTRIES) {
    budget.truncated = true;
    return false;
  }
  budget.entries += 1;
  return true;
}

function sanitizeSnapshotValue(
  value: unknown,
  depth = 0,
  seen = new Set<object>(),
  budget: SnapshotBudget = { nodes: 0, entries: 0, keyBytes: 0, bytes: 0, truncated: false },
): unknown {
  if (depth >= MAX_SNAPSHOT_DEPTH) {
    budget.truncated = true;
    return snapshotMarker(budget, SNAPSHOT_TRUNCATED);
  }
  budget.nodes += 1;
  if (budget.nodes > MAX_SNAPSHOT_NODES) {
    budget.truncated = true;
    return snapshotMarker(budget, SNAPSHOT_TRUNCATED);
  }
  if (value === null || value === undefined) {
    addSnapshotBytes(budget, value === null ? 4 : 1);
    return value;
  }
  if (typeof value === 'string') {
    return snapshotString(value, budget);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      return snapshotString(String(value), budget);
    }
    addSnapshotBytes(budget, 16);
    return value;
  }
  if (typeof value === 'boolean') {
    addSnapshotBytes(budget, value ? 4 : 5);
    return value;
  }
  if (typeof value === 'bigint') {
    try {
      return snapshotString(value.toString(), budget);
    } catch {
      return snapshotMarker(budget, SNAPSHOT_UNREADABLE);
    }
  }
  if (typeof value === 'function' || typeof value === 'symbol') {
    return snapshotMarker(budget, SNAPSHOT_UNSUPPORTED);
  }
  if (typeof value !== 'object') {
    return snapshotMarker(budget, SNAPSHOT_UNSUPPORTED);
  }
  if (seen.has(value)) {
    return snapshotMarker(budget, '[circular]');
  }
  seen.add(value);
  try {
    if (diagnosticIsError(value)) {
      const name = diagnosticErrorField(value, 'name');
      const message = diagnosticErrorField(value, 'message');
      const copy = {
        name: sanitizeSnapshotValue(
          name.kind === 'value'
            ? name.value
            : name.kind === 'accessor'
              ? SNAPSHOT_ACCESSOR
              : name.kind === 'missing'
                ? SNAPSHOT_MISSING
                : SNAPSHOT_UNREADABLE,
          depth + 1,
          seen,
          budget,
        ),
        message: sanitizeSnapshotValue(
          message.kind === 'value'
            ? message.value
            : message.kind === 'accessor'
              ? SNAPSHOT_ACCESSOR
              : message.kind === 'missing'
                ? SNAPSHOT_MISSING
                : SNAPSHOT_UNREADABLE,
          depth + 1,
          seen,
          budget,
        ),
      };
      addSnapshotBytes(budget, 8);
      return Object.freeze(copy);
    }
    if (diagnosticIsDate(value)) {
      try {
        const milliseconds = Date.prototype.getTime.call(value);
        return Number.isFinite(milliseconds)
          ? snapshotString(Date.prototype.toISOString.call(value), budget)
          : snapshotMarker(budget, '[invalid date]');
      } catch {
        return snapshotMarker(budget, SNAPSHOT_UNREADABLE);
      }
    }
    const arrayState = diagnosticIsArray(value);
    if (arrayState === SNAPSHOT_UNREADABLE_SENTINEL) {
      return snapshotMarker(budget, SNAPSHOT_UNREADABLE);
    }
    if (arrayState) {
      const lengthResult = diagnosticDescriptor(value, 'length');
      const length =
        lengthResult.descriptor !== undefined && 'value' in lengthResult.descriptor
          ? lengthResult.descriptor.value
          : undefined;
      if (
        lengthResult.unreadable ||
        typeof length !== 'number' ||
        !Number.isSafeInteger(length) ||
        length < 0
      ) {
        return snapshotMarker(budget, SNAPSHOT_UNREADABLE);
      }
      const entryCount = Math.min(length, MAX_SNAPSHOT_ENTRIES);
      const copy: unknown[] = [];
      addSnapshotBytes(budget, 2);
      for (let index = 0; index < entryCount; index += 1) {
        if (!diagnosticEntryAvailable(budget)) {
          break;
        }
        const entryResult = diagnosticDescriptor(value, String(index));
        let child: unknown;
        if (entryResult.unreadable) {
          child = snapshotMarker(budget, SNAPSHOT_UNREADABLE);
        } else if (entryResult.descriptor === undefined) {
          child = snapshotMarker(budget, SNAPSHOT_MISSING);
        } else if (!('value' in entryResult.descriptor)) {
          child = snapshotMarker(budget, SNAPSHOT_ACCESSOR);
        } else {
          child = sanitizeSnapshotValue(entryResult.descriptor.value, depth + 1, seen, budget);
        }
        copy.push(child);
      }
      if (length > entryCount || budget.truncated) {
        copy.push(snapshotMarker(budget, SNAPSHOT_TRUNCATED));
      }
      return Object.freeze(copy);
    }
    const prototype = diagnosticPrototype(value);
    if (
      prototype === SNAPSHOT_UNREADABLE_SENTINEL ||
      (prototype !== Object.prototype && prototype !== null)
    ) {
      return snapshotMarker(budget, SNAPSHOT_UNSUPPORTED);
    }
    const copy: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    addSnapshotBytes(budget, 2);
    let inspectedKeys = 0;
    let truncated = false;
    try {
      for (const key in value) {
        inspectedKeys += 1;
        if (inspectedKeys > MAX_SNAPSHOT_ENTRIES) {
          truncated = true;
          break;
        }
        const descriptorResult = diagnosticDescriptor(value, key);
        if (descriptorResult.unreadable) {
          truncated = true;
          break;
        }
        if (descriptorResult.descriptor === undefined) {
          continue;
        }
        if (!descriptorResult.descriptor.enumerable) {
          truncated = true;
          break;
        }
        if (!diagnosticEntryAvailable(budget)) {
          truncated = true;
          break;
        }
        const safeKey = snapshotKey(key, budget);
        if (safeKey === undefined) {
          truncated = true;
          break;
        }
        const child =
          'value' in descriptorResult.descriptor
            ? sanitizeSnapshotValue(descriptorResult.descriptor.value, depth + 1, seen, budget)
            : snapshotMarker(budget, SNAPSHOT_ACCESSOR);
        copy[safeKey] = child;
        if (budget.truncated) {
          truncated = true;
          break;
        }
      }
    } catch {
      truncated = true;
    }
    if (truncated || budget.truncated) {
      copy['[truncated]'] = true;
    }
    return Object.freeze(copy);
  } finally {
    seen.delete(value);
  }
}

/**
 * A serialized, idempotently stoppable self-renewing lease.
 *
 * A lease is bound to its runtime identity for its entire lifetime.  Once it
 * expires or is stopped it cannot be revived; callers must register a fresh
 * runtime identity instead of silently handing state to a replacement.
 */
export class SerializedLease {
  public readonly ttlMs: number;
  public readonly renewalIntervalMs: number;
  private ownerIdentity: LeaseOwnerIdentity | undefined;

  private readonly renewal: LeaseRenewal;
  private readonly onError: LeaseErrorHandler | undefined;
  private readonly onStop: (() => void) | undefined;
  private readonly onEndpointUpdate: LeaseEndpointUpdate | undefined;
  private readonly scheduler: LeaseScheduler;
  private readonly now: LeaseClock;
  private inFlightRenewal: Promise<void> | undefined;
  private timer: LeaseTimer | undefined;
  private expiryTimer: LeaseTimer | undefined;
  private expiryTimerDeadline: number | null = null;
  private renewalExpiryReject: ((error: unknown) => void) | undefined;
  private state: LeaseState = 'idle';
  private startPromise: Promise<void> | undefined;
  private currentEndpoint: RoutingEndpoint | undefined;
  private lifecycleGeneration = 0;
  private endpointGeneration = 0;
  private issuedAt: number | null = null;
  private lastRenewedAt: number | null = null;
  private expiresAt: number | null = null;
  private lastError: unknown | null = null;

  public constructor(options: SerializedLeaseOptions);
  public constructor(renew: LeaseRenewal, options?: LeaseConstructionOptions);
  public constructor(
    optionsOrRenew: SerializedLeaseOptions | LeaseRenewal,
    constructionOptions: LeaseConstructionOptions = {},
  ) {
    const options: SerializedLeaseOptions =
      typeof optionsOrRenew === 'function'
        ? { ...constructionOptions, renew: optionsOrRenew }
        : optionsOrRenew;

    if (typeof options.renew !== 'function') {
      throw new LeaseConfigurationError('renew must be a function');
    }
    if (options.identity !== undefined) {
      this.ownerIdentity = cloneOwnerIdentity(options.identity);
    }

    this.renewal = options.renew;
    this.ttlMs = duration(options.ttlMs, DEFAULT_LEASE_TTL_MS, 'ttlMs');
    this.renewalIntervalMs = duration(
      options.renewalIntervalMs,
      DEFAULT_LEASE_RENEWAL_INTERVAL_MS,
      'renewalIntervalMs',
    );
    validateRenewalTiming(this.ttlMs, this.renewalIntervalMs);
    this.onError = options.onError;
    this.onStop = options.onStop;
    this.onEndpointUpdate = options.onEndpointUpdate;
    this.scheduler = options.scheduler ?? defaultScheduler;
    this.now = options.now ?? Date.now;
    this.currentEndpoint =
      options.endpoint === undefined
        ? undefined
        : cloneEndpoint(options.endpoint, this.ownerIdentity?.runtimeId);
  }

  public get identity(): LeaseOwnerIdentity | undefined {
    return this.ownerIdentity;
  }

  /** Start one owner renewal; overlapping calls share the in-flight attempt. */
  public renew(): Promise<void> {
    if (this.state === 'stopped') {
      return Promise.reject(new LeaseStoppedError());
    }
    if (this.state === 'expired') {
      return Promise.reject(new LeaseExpiredError());
    }
    if (this.inFlightRenewal !== undefined) {
      if (this.expiresAt !== null) {
        try {
          if (clockValue(this.now) >= this.expiresAt) {
            this.markExpired();
            return Promise.reject(new LeaseExpiredError());
          }
        } catch (error: unknown) {
          return Promise.reject(error);
        }
      }
      return this.inFlightRenewal;
    }
    try {
      const now = clockValue(this.now);
      if (this.expiresAt === null) {
        this.expiresAt = now + this.ttlMs;
        this.armExpiryTimer(this.expiresAt);
      } else if (now >= this.expiresAt) {
        this.markExpired();
        return Promise.reject(new LeaseExpiredError());
      } else {
        this.armExpiryTimer(this.expiresAt);
      }
    } catch (error: unknown) {
      return Promise.reject(error);
    }
    let rejectOnExpiry: (error: unknown) => void = () => undefined;
    const expiry = new Promise<never>((_resolve, reject) => {
      rejectOnExpiry = reject;
    });
    this.renewalExpiryReject = rejectOnExpiry;
    const operation = Promise.resolve().then(async () => {
      if (this.state === 'stopped') {
        throw new LeaseStoppedError();
      }
      const lifecycleGeneration = this.lifecycleGeneration;
      const ownerAtStart = this.ownerIdentity;
      const endpointGeneration = this.endpointGeneration;
      const now = clockValue(this.now);
      if (this.state === 'expired' || (this.expiresAt !== null && now >= this.expiresAt)) {
        this.markExpired();
        throw new LeaseExpiredError();
      }
      const renewalResult = Promise.resolve().then(() => this.renewal());
      const result = await Promise.race([renewalResult, expiry]);
      // A callback may have been in flight while the lease was explicitly
      // stopped/expired.  Such a callback is stale and must not mutate or
      // resurrect this lease (including the first renewal with no deadline).
      const stateAfterCallback = this.lifecycle;
      if (stateAfterCallback === 'stopped') {
        throw new LeaseStoppedError();
      }
      if (stateAfterCallback === 'expired') {
        throw new LeaseExpiredError();
      }
      if (this.lifecycleGeneration !== lifecycleGeneration) {
        throw new LeaseStoppedError();
      }
      const renewedAt = clockValue(this.now);
      if (this.expiresAt !== null && renewedAt >= this.expiresAt) {
        this.markExpired();
        throw new LeaseExpiredError();
      }
      let nextIdentity: LeaseOwnerIdentity | undefined;
      let nextEndpoint: RoutingEndpoint | undefined;
      if (isRenewalResult(result)) {
        if (result.identity !== undefined) {
          nextIdentity = cloneOwnerIdentity(result.identity);
          if (ownerAtStart !== undefined && !sameIdentity(ownerAtStart, nextIdentity)) {
            throw new LeaseConfigurationError('lease owner identity cannot be replaced');
          }
        }
        const effectiveRuntimeId = (ownerAtStart ?? nextIdentity)?.runtimeId;
        if (result.endpoint !== undefined) {
          nextEndpoint = cloneEndpoint(result.endpoint, effectiveRuntimeId);
        }
      }
      const stateBeforeCommit = this.lifecycle;
      if (stateBeforeCommit === 'stopped') {
        throw new LeaseStoppedError();
      }
      if (stateBeforeCommit === 'expired') {
        throw new LeaseExpiredError();
      }
      if (this.lifecycleGeneration !== lifecycleGeneration) {
        throw new LeaseStoppedError();
      }
      // The owner is immutable after the first accepted identity, and the
      // callback generation must still be current immediately before commit.
      if (this.ownerIdentity !== undefined && ownerAtStart !== undefined) {
        if (!sameIdentity(this.ownerIdentity, ownerAtStart)) {
          throw new LeaseConfigurationError('lease owner identity changed during renewal');
        }
      } else if (this.ownerIdentity !== ownerAtStart) {
        throw new LeaseConfigurationError('lease owner identity changed during renewal');
      }
      if (nextIdentity !== undefined) {
        if (this.ownerIdentity !== undefined && !sameIdentity(this.ownerIdentity, nextIdentity)) {
          throw new LeaseConfigurationError('lease owner identity cannot be replaced');
        }
        // An endpoint supplied before the callback revealed its identity is
        // still untrusted until it is checked against that identity.
        if (this.currentEndpoint !== undefined) {
          cloneEndpoint(this.currentEndpoint, nextIdentity.runtimeId);
        }
        this.ownerIdentity ??= nextIdentity;
      }
      if (nextEndpoint !== undefined && endpointGeneration === this.endpointGeneration) {
        this.currentEndpoint = nextEndpoint;
      }
      this.issuedAt ??= renewedAt;
      this.lastRenewedAt = renewedAt;
      this.expiresAt = renewedAt + this.ttlMs;
      this.state = 'active';
      this.armExpiryTimer(this.expiresAt);
    });
    this.inFlightRenewal = operation;
    void operation.then(
      () => {
        if (this.inFlightRenewal === operation) {
          this.inFlightRenewal = undefined;
          this.renewalExpiryReject = undefined;
        }
      },
      (error: unknown) => {
        if (this.inFlightRenewal === operation) {
          this.inFlightRenewal = undefined;
          this.renewalExpiryReject = undefined;
        }
        this.lastError = error;
        try {
          if (this.expiresAt !== null && clockValue(this.now) >= this.expiresAt) {
            this.markExpired();
          }
        } catch (handlerError: unknown) {
          this.lastError = handlerError;
        }
      },
    );
    return operation;
  }

  /** Start the timer and perform one immediate owner renewal. */
  public start(): Promise<void> {
    if (this.state === 'stopped') {
      return Promise.reject(new LeaseStoppedError());
    }
    if (this.state === 'expired') {
      return Promise.reject(new LeaseExpiredError());
    }
    if (this.startPromise) {
      return this.startPromise;
    }

    const startedAt = clockValue(this.now);
    // Establish an independent local deadline before the initial callback is
    // invoked.  A hung callback must not leave this lease immortal.
    this.expiresAt ??= startedAt + this.ttlMs;
    this.state = 'active';
    if (this.expiresAt !== null) {
      this.armExpiryTimer(this.expiresAt);
    }
    this.timer = this.scheduler.setInterval(
      () => {
        if (this.state !== 'active') {
          return;
        }
        try {
          if (this.expiresAt !== null && clockValue(this.now) >= this.expiresAt) {
            this.markExpired();
            return;
          }
        } catch (error: unknown) {
          this.lastError = error;
          this.onError?.(error);
          return;
        }
        void this.renew().catch((error: unknown) => {
          this.lastError = error;
          this.onError?.(error);
        });
      },
      Math.min(this.renewalIntervalMs, this.ttlMs, MAX_LEASE_TIMER_DELAY_MS),
    );
    const timer = this.timer as LeaseTimer & { unref?: () => void };
    timer.unref?.();

    this.startPromise = this.renew().catch(async (error: unknown) => {
      await this.stop();
      throw error;
    });
    return this.startPromise;
  }

  /** Stop timer work without waiting for a potentially hung owner renewal. */
  public stop(): Promise<void> {
    if (this.state !== 'stopped') {
      const wasExpired = this.state === 'expired';
      if (!wasExpired) {
        this.state = 'stopped';
        this.rejectInFlight(new LeaseStoppedError());
        this.invalidateLifecycle();
      }
      if (this.timer !== undefined) {
        this.scheduler.clearInterval(this.timer);
        this.timer = undefined;
      }
      this.clearExpiryTimer();
    }
    return Promise.resolve();
  }

  /** Mark a missed lease deadline without changing the immutable owner identity. */
  public expire(): boolean {
    if (this.state === 'stopped' || this.state === 'expired') {
      return false;
    }
    this.markExpired();
    return true;
  }

  public isExpired(at = this.now()): boolean {
    if (!Number.isFinite(at)) {
      throw new LeaseConfigurationError('lease clock must return a finite timestamp');
    }
    if (this.state !== 'stopped' && this.expiresAt !== null && at >= this.expiresAt) {
      this.markExpired();
    }
    return this.state === 'expired' || (this.expiresAt !== null && at >= this.expiresAt);
  }

  public get endpoint(): RoutingEndpoint | undefined {
    return this.currentEndpoint === undefined
      ? undefined
      : cloneEndpoint(this.currentEndpoint, this.ownerIdentity?.runtimeId);
  }

  public updateEndpoint(endpoint: RoutingEndpoint): void {
    if (this.state === 'stopped' || this.state === 'expired') {
      throw new LeaseExpiredError();
    }
    const lifecycleGeneration = this.lifecycleGeneration;
    const endpointGeneration = this.endpointGeneration;
    const ownerAtStart = this.ownerIdentity;
    const now = clockValue(this.now);
    if (this.expiresAt !== null && now >= this.expiresAt) {
      this.markExpired();
      throw new LeaseExpiredError();
    }
    const endpointCopy = cloneEndpoint(endpoint, ownerAtStart?.runtimeId);
    // Persist through the owning registry before changing this lease's local
    // snapshot.  A failed publication therefore cannot create divergent state.
    this.onEndpointUpdate?.(endpointCopy);
    const stateAfterCallback = this.lifecycle;
    if (stateAfterCallback === 'stopped') {
      throw new LeaseStoppedError();
    }
    if (stateAfterCallback === 'expired') {
      throw new LeaseExpiredError();
    }
    if (this.lifecycleGeneration !== lifecycleGeneration) {
      throw new LeaseStoppedError();
    }
    if (this.endpointGeneration !== endpointGeneration) {
      throw new LeaseConfigurationError('endpoint update became stale during callback');
    }
    if (this.ownerIdentity !== ownerAtStart) {
      throw new LeaseConfigurationError('lease owner changed during endpoint update');
    }
    // Recheck ownership after the callback before committing the endpoint.
    const committedEndpoint = cloneEndpoint(endpointCopy, this.ownerIdentity?.runtimeId);
    this.endpointGeneration += 1;
    this.currentEndpoint = committedEndpoint;
  }

  public get running(): boolean {
    return this.state === 'active';
  }

  public get stopped(): boolean {
    return this.state === 'stopped';
  }

  public get lifecycle(): LeaseState {
    return this.state;
  }

  public isRunning(): boolean {
    return this.running;
  }

  public isStopped(): boolean {
    return this.stopped;
  }

  public owns(identity: LeaseOwnerIdentity): boolean {
    return (
      this.ownerIdentity !== undefined &&
      isIdentity(identity) &&
      sameIdentity(this.ownerIdentity, identity)
    );
  }

  public snapshot(): LeaseSnapshot {
    const now = clockValue(this.now);
    if (this.state !== 'stopped' && this.expiresAt !== null && now >= this.expiresAt) {
      this.markExpired();
    }
    const snapshot: LeaseSnapshot = {
      state: this.state,
      running: this.running,
      stopped: this.stopped,
      ...(this.ownerIdentity === undefined ? {} : { sessionId: this.ownerIdentity.sessionId }),
      ...(this.ownerIdentity === undefined ? {} : { runtimeId: this.ownerIdentity.runtimeId }),
      ...(this.currentEndpoint === undefined
        ? {}
        : { endpoint: cloneEndpoint(this.currentEndpoint, this.ownerIdentity?.runtimeId) }),
      ttlMs: this.ttlMs,
      renewalIntervalMs: this.renewalIntervalMs,
      issuedAt: this.issuedAt,
      lastRenewedAt: this.lastRenewedAt,
      expiresAt: this.expiresAt,
      leaseExpiresAt: this.expiresAt === null ? null : asTimestamp(this.expiresAt),
      lastError: this.lastError === null ? null : sanitizeSnapshotValue(this.lastError),
    };
    return Object.freeze(snapshot);
  }

  /** Lifecycle-friendly aliases. */
  public dispose(): Promise<void> {
    return this.stop();
  }

  public close(): Promise<void> {
    return this.stop();
  }

  private armExpiryTimer(deadline: number): void {
    this.clearExpiryTimer();
    if (this.state === 'stopped' || this.state === 'expired') {
      return;
    }
    if (!Number.isFinite(deadline)) {
      throw new LeaseConfigurationError('lease expiry must be finite');
    }
    this.expiryTimerDeadline = deadline;
    const handler = (): void => {
      if (this.expiryTimerDeadline !== deadline) {
        return;
      }
      const activeTimer = this.expiryTimer;
      this.expiryTimer = undefined;
      this.expiryTimerDeadline = null;
      if (activeTimer !== undefined) {
        this.scheduler.clearInterval(activeTimer);
      }
      try {
        if (clockValue(this.now) >= deadline) {
          this.markExpired();
        } else {
          this.armExpiryTimer(deadline);
        }
      } catch (error: unknown) {
        this.lastError = error;
        try {
          this.onError?.(error);
        } catch (handlerError: unknown) {
          this.lastError = handlerError;
        }
      }
    };
    let timer: LeaseTimer;
    try {
      timer = this.scheduler.setInterval(
        handler,
        Math.max(1, Math.min(MAX_LEASE_TIMER_DELAY_MS, deadline - clockValue(this.now))),
      );
    } catch (error: unknown) {
      this.expiryTimerDeadline = null;
      throw error;
    }
    if (
      this.lifecycle === 'stopped' ||
      this.lifecycle === 'expired' ||
      this.expiryTimerDeadline !== deadline
    ) {
      this.scheduler.clearInterval(timer);
      return;
    }
    this.expiryTimer = timer;
    const unrefTimer = timer as LeaseTimer & { unref?: () => void };
    unrefTimer.unref?.();
  }

  private clearExpiryTimer(): void {
    if (this.expiryTimer !== undefined) {
      this.scheduler.clearInterval(this.expiryTimer);
      this.expiryTimer = undefined;
    }
    this.expiryTimerDeadline = null;
  }

  private rejectInFlight(error: unknown): void {
    const reject = this.renewalExpiryReject;
    this.renewalExpiryReject = undefined;
    reject?.(error);
  }

  private markExpired(): void {
    if (this.state === 'stopped' || this.state === 'expired') {
      return;
    }
    this.state = 'expired';
    this.rejectInFlight(new LeaseExpiredError());
    this.invalidateLifecycle();
    if (this.timer !== undefined) {
      this.scheduler.clearInterval(this.timer);
      this.timer = undefined;
    }
    this.clearExpiryTimer();
  }

  private invalidateLifecycle(): void {
    this.lifecycleGeneration += 1;
    try {
      this.onStop?.();
    } catch (error: unknown) {
      this.lastError = error;
      this.onError?.(error);
    }
  }
}

function isIdentity(value: unknown): value is SessionRuntimeIdentity {
  return (
    isSessionRuntimeIdentity(value) && value.sessionId.length <= 512 && isUuidV4(value.runtimeId)
  );
}

const CONTROL_CHARACTER_PATTERN = /\p{C}/u;

function validateEndpoint(endpoint: RoutingEndpoint, runtimeId?: RuntimeId): RoutingEndpoint {
  if (typeof endpoint === 'string') {
    if (
      endpoint.trim().length === 0 ||
      endpoint.length > MAX_ENDPOINT_LENGTH ||
      Buffer.byteLength(endpoint, 'utf8') > MAX_ENDPOINT_BYTES ||
      CONTROL_CHARACTER_PATTERN.test(endpoint)
    ) {
      throw new LeaseConfigurationError('routing endpoint must be bounded non-empty text');
    }
    return endpoint;
  }
  if (typeof endpoint !== 'object' || endpoint === null || Array.isArray(endpoint)) {
    throw new LeaseConfigurationError('routing endpoint must be an opaque string or descriptor');
  }
  const prototype = Object.getPrototypeOf(endpoint);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new LeaseConfigurationError('routing endpoint descriptor must be a plain object');
  }
  let keyCount = 0;
  let inspectedKeys = 0;
  for (const key in endpoint) {
    inspectedKeys += 1;
    if (inspectedKeys > MAX_ENDPOINT_KEYS) {
      throw new LeaseConfigurationError('routing endpoint descriptor has too many fields');
    }
    if (!Object.prototype.hasOwnProperty.call(endpoint, key)) {
      continue;
    }
    keyCount += 1;
    if (keyCount > MAX_ENDPOINT_KEYS) {
      throw new LeaseConfigurationError('routing endpoint descriptor has too many fields');
    }
    const descriptor = Object.getOwnPropertyDescriptor(endpoint, key);
    if (descriptor === undefined || !('value' in descriptor) || !descriptor.enumerable) {
      throw new LeaseConfigurationError('routing endpoint descriptor cannot contain accessors');
    }
    if (!['address', 'kind', 'transport', 'runtimeId'].includes(key)) {
      throw new LeaseConfigurationError(
        FORBIDDEN_ENDPOINT_KEYS.has(key)
          ? 'routing endpoint cannot carry credentials'
          : 'routing endpoint contains an unknown field',
      );
    }
  }
  const ownValue = (key: string): unknown => {
    const descriptor = Object.getOwnPropertyDescriptor(endpoint, key);
    if (descriptor === undefined) {
      return undefined;
    }
    if (!('value' in descriptor) || !descriptor.enumerable) {
      throw new LeaseConfigurationError(
        'routing endpoint descriptor cannot contain accessors or hidden fields',
      );
    }
    return descriptor.value;
  };
  const address = ownValue('address');
  if (
    typeof address !== 'string' ||
    address.trim().length === 0 ||
    address.length > MAX_ENDPOINT_LENGTH ||
    Buffer.byteLength(address, 'utf8') > MAX_ENDPOINT_BYTES ||
    CONTROL_CHARACTER_PATTERN.test(address)
  ) {
    throw new LeaseConfigurationError('routing endpoint address must be bounded non-empty text');
  }
  const kind = ownValue('kind');
  if (
    kind !== undefined &&
    (typeof kind !== 'string' ||
      kind.trim().length === 0 ||
      kind.length > MAX_ENDPOINT_LENGTH ||
      Buffer.byteLength(kind, 'utf8') > MAX_ENDPOINT_BYTES ||
      CONTROL_CHARACTER_PATTERN.test(kind))
  ) {
    throw new LeaseConfigurationError('routing endpoint kind must be bounded non-empty text');
  }
  const transport = ownValue('transport');
  if (
    transport !== undefined &&
    (typeof transport !== 'string' ||
      transport.trim().length === 0 ||
      transport.length > MAX_ENDPOINT_LENGTH ||
      Buffer.byteLength(transport, 'utf8') > MAX_ENDPOINT_BYTES ||
      CONTROL_CHARACTER_PATTERN.test(transport))
  ) {
    throw new LeaseConfigurationError('routing endpoint transport must be bounded non-empty text');
  }
  if (kind !== undefined && transport !== undefined && kind !== transport) {
    throw new LeaseConfigurationError('routing endpoint kind and transport must agree');
  }
  const endpointRuntimeId = ownValue('runtimeId');
  if (endpointRuntimeId !== undefined) {
    if (!isUuidV4(endpointRuntimeId)) {
      throw new LeaseConfigurationError('routing endpoint runtimeId must be canonical');
    }
    if (runtimeId !== undefined && endpointRuntimeId !== runtimeId) {
      throw new LeaseConfigurationError('routing endpoint is not owned by the lease runtime');
    }
  }
  const normalized: RoutingEndpointDescriptor = {
    address,
    ...(kind === undefined ? {} : { kind }),
    ...(transport === undefined ? {} : { transport }),
    ...(endpointRuntimeId === undefined ? {} : { runtimeId: endpointRuntimeId }),
  };
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(normalized);
  } catch {
    throw new LeaseConfigurationError('routing endpoint is not JSON serializable');
  }
  if (serialized === undefined || Buffer.byteLength(serialized, 'utf8') > MAX_ENDPOINT_BYTES) {
    throw new LeaseConfigurationError('routing endpoint exceeds its size limit');
  }
  return normalized;
}
/** Options for calculating or renewing a lease expiry. */
export interface LeaseExpiryOptions {
  readonly now?: number | Date;
  readonly ttlMs?: number;
}

/** Return an RFC 3339 UTC expiry for a wall-clock timestamp and TTL. */
export function leaseExpiration(options: LeaseExpiryOptions = {}): UtcTimestamp {
  const now = options.now instanceof Date ? options.now.getTime() : (options.now ?? Date.now());
  if (!Number.isFinite(now)) {
    throw new LeaseConfigurationError('lease timestamp must be finite');
  }
  const ttl = duration(options.ttlMs, DEFAULT_LEASE_TTL_MS, 'ttlMs');
  return asTimestamp(now + ttl);
}

export const leaseExpiresAt = leaseExpiration;

/** Return a copy of a lease-bearing metadata object with a fresh expiry. */
export function renewLeaseExpiry<T extends { readonly leaseExpiresAt?: string | null }>(
  value: T,
  options: { readonly now?: number | Date; readonly ttlMs?: number } = {},
): T & { readonly leaseExpiresAt: UtcTimestamp } {
  return {
    ...value,
    leaseExpiresAt: leaseExpiration(options),
  };
}

export const renewAgentCardLease = renewLeaseExpiry;
export const renewCardLease = renewLeaseExpiry;
export const withLeaseExpiry = renewLeaseExpiry;

/** A replacement keeps logical session identity but always changes runtime identity. */
export function isReplacementRuntimeIdentity(
  previous: LeaseOwnerIdentity,
  replacement: LeaseOwnerIdentity,
): boolean {
  return (
    previous.sessionId === replacement.sessionId && previous.runtimeId !== replacement.runtimeId
  );
}

export const isReplacementRuntime = isReplacementRuntimeIdentity;

/** Descriptive aliases for callers that use either lease terminology. */
export class RenewableLease extends SerializedLease {}
export class Lease extends SerializedLease {}
export class LeaseManager extends SerializedLease {}

export function createSerializedLease(options: SerializedLeaseOptions): SerializedLease {
  return new SerializedLease(options);
}

export const createRenewableLease = createSerializedLease;
export const createLease = createSerializedLease;
