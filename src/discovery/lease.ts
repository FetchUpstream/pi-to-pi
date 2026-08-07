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

function duration(value: number | undefined, fallback: number, label: string): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result <= 0) {
    throw new LeaseConfigurationError(`${label} must be a positive safe integer`);
  }
  return result;
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
  validateEndpoint(endpoint, runtimeId);
  if (typeof endpoint === 'string') {
    return endpoint;
  }
  return Object.freeze({
    address: endpoint.address,
    ...(endpoint.kind === undefined ? {} : { kind: endpoint.kind }),
    ...(endpoint.transport === undefined ? {} : { transport: endpoint.transport }),
    ...(endpoint.runtimeId === undefined ? {} : { runtimeId: endpoint.runtimeId }),
  });
}

function isRenewalResult(value: unknown): value is LeaseRenewalResult {
  return (
    typeof value === 'object' && value !== null && ('endpoint' in value || 'identity' in value)
  );
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
    if (this.inFlightRenewal !== undefined) {
      return this.inFlightRenewal;
    }
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

      const result = await this.renewal();

      // A callback may have been in flight while the lease was explicitly
      // stopped/expired.  Such a callback is stale and must not mutate or
      // resurrect this lease (including the first renewal with no deadline).
      const stateAfterCallback = this.lifecycle as LeaseState;
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
      const stateBeforeCommit = this.lifecycle as LeaseState;
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
      }
      if (nextIdentity !== undefined) {
        if (this.ownerIdentity !== undefined && !sameIdentity(this.ownerIdentity, nextIdentity)) {
          throw new LeaseConfigurationError('lease owner identity cannot be replaced');
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
    });
    this.inFlightRenewal = operation;
    void operation.then(
      () => {
        if (this.inFlightRenewal === operation) {
          this.inFlightRenewal = undefined;
        }
      },
      (error: unknown) => {
        if (this.inFlightRenewal === operation) {
          this.inFlightRenewal = undefined;
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

    this.state = 'active';
    this.timer = this.scheduler.setInterval(() => {
      void this.renew().catch((error: unknown) => {
        this.lastError = error;
        this.onError?.(error);
      });
    }, this.renewalIntervalMs);
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
      this.state = 'stopped';
      if (!wasExpired) {
        this.invalidateLifecycle();
      }
      if (this.timer !== undefined) {
        this.scheduler.clearInterval(this.timer);
        this.timer = undefined;
      }
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
    const now = clockValue(this.now);
    if (this.expiresAt !== null && now >= this.expiresAt) {
      this.markExpired();
      throw new LeaseExpiredError();
    }
    const endpointCopy = cloneEndpoint(endpoint, this.ownerIdentity?.runtimeId);
    // Persist through the owning registry before changing this lease's local
    // snapshot.  A failed publication therefore cannot create divergent state.
    this.onEndpointUpdate?.(endpointCopy);
    this.endpointGeneration += 1;
    // Publish the defensive copy immediately for callers that need the current
    // endpoint synchronously.  The generation check prevents an in-flight
    // callback from overwriting this newer endpoint.
    this.currentEndpoint = endpointCopy;
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
    return {
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
      lastError: this.lastError,
    };
  }

  /** Lifecycle-friendly aliases. */
  public dispose(): Promise<void> {
    return this.stop();
  }

  public close(): Promise<void> {
    return this.stop();
  }

  private markExpired(): void {
    if (this.state === 'stopped' || this.state === 'expired') {
      return;
    }
    this.state = 'expired';
    this.invalidateLifecycle();
    if (this.timer !== undefined) {
      this.scheduler.clearInterval(this.timer);
      this.timer = undefined;
    }
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

function validateEndpoint(endpoint: RoutingEndpoint, runtimeId?: RuntimeId): void {
  if (typeof endpoint === 'string') {
    if (
      endpoint.trim().length === 0 ||
      endpoint.length > MAX_ENDPOINT_LENGTH ||
      CONTROL_CHARACTER_PATTERN.test(endpoint)
    ) {
      throw new LeaseConfigurationError('routing endpoint must be bounded non-empty text');
    }
    return;
  }
  if (typeof endpoint !== 'object' || endpoint === null || Array.isArray(endpoint)) {
    throw new LeaseConfigurationError('routing endpoint must be an opaque string or descriptor');
  }
  if (
    typeof endpoint.address !== 'string' ||
    endpoint.address.trim().length === 0 ||
    endpoint.address.length > MAX_ENDPOINT_LENGTH ||
    CONTROL_CHARACTER_PATTERN.test(endpoint.address)
  ) {
    throw new LeaseConfigurationError('routing endpoint address must be bounded non-empty text');
  }
  if (
    endpoint.kind !== undefined &&
    (typeof endpoint.kind !== 'string' ||
      endpoint.kind.trim().length === 0 ||
      endpoint.kind.length > MAX_ENDPOINT_LENGTH ||
      CONTROL_CHARACTER_PATTERN.test(endpoint.kind))
  ) {
    throw new LeaseConfigurationError('routing endpoint kind must be bounded non-empty text');
  }
  if (
    endpoint.transport !== undefined &&
    (typeof endpoint.transport !== 'string' ||
      endpoint.transport.trim().length === 0 ||
      endpoint.transport.length > MAX_ENDPOINT_LENGTH ||
      CONTROL_CHARACTER_PATTERN.test(endpoint.transport))
  ) {
    throw new LeaseConfigurationError('routing endpoint transport must be bounded non-empty text');
  }
  if (
    endpoint.kind !== undefined &&
    endpoint.transport !== undefined &&
    endpoint.kind !== endpoint.transport
  ) {
    throw new LeaseConfigurationError('routing endpoint kind and transport must agree');
  }
  if (endpoint.runtimeId !== undefined) {
    if (!isUuidV4(endpoint.runtimeId)) {
      throw new LeaseConfigurationError('routing endpoint runtimeId must be canonical');
    }
    if (runtimeId !== undefined && endpoint.runtimeId !== runtimeId) {
      throw new LeaseConfigurationError('routing endpoint is not owned by the lease runtime');
    }
  }
  for (const key of Object.keys(endpoint)) {
    if (FORBIDDEN_ENDPOINT_KEYS.has(key)) {
      throw new LeaseConfigurationError('routing endpoint cannot carry credentials');
    }
  }
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
