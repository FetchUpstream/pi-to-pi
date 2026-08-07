/**
 * Runtime-scoped discovery leases.
 *
 * A lease owns presence for one runtime identity and one current endpoint.  The
 * renewal callback is deliberately supplied by the registry/transport owner;
 * this module does not choose a binding, probe peers, or persist application
 * records.  Renewal calls are serialized so a slow callback cannot publish an
 * older endpoint after a newer one.
 */

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
  public identity: LeaseOwnerIdentity | undefined;

  private readonly renewal: LeaseRenewal;
  private readonly onError: LeaseErrorHandler | undefined;
  private readonly scheduler: LeaseScheduler;
  private readonly now: LeaseClock;
  private pending: Promise<void> = Promise.resolve();
  private timer: LeaseTimer | undefined;
  private state: LeaseState = 'idle';
  private startPromise: Promise<void> | undefined;
  private currentEndpoint: RoutingEndpoint | undefined;
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
      if (!isIdentity(options.identity)) {
        throw new LeaseConfigurationError('identity must contain sessionId and runtimeId');
      }
      this.identity = Object.freeze({
        sessionId: options.identity.sessionId,
        runtimeId: options.identity.runtimeId,
      });
    }

    this.renewal = options.renew;
    this.ttlMs = duration(options.ttlMs, DEFAULT_LEASE_TTL_MS, 'ttlMs');
    this.renewalIntervalMs = duration(
      options.renewalIntervalMs,
      DEFAULT_LEASE_RENEWAL_INTERVAL_MS,
      'renewalIntervalMs',
    );
    this.onError = options.onError;
    this.scheduler = options.scheduler ?? defaultScheduler;
    this.now = options.now ?? Date.now;
    if (options.endpoint !== undefined) {
      validateEndpoint(options.endpoint);
    }
    this.currentEndpoint = options.endpoint;
  }

  /** Queue one owner renewal behind all earlier owner renewals. */
  public renew(): Promise<void> {
    const operation = this.pending.then(async () => {
      if (this.state === 'stopped') {
        throw new LeaseStoppedError();
      }
      const now = clockValue(this.now);
      if (this.state === 'expired' || (this.expiresAt !== null && now >= this.expiresAt)) {
        this.markExpired();
        throw new LeaseExpiredError();
      }

      const result = await this.renewal();
      if (this.stopped) {
        throw new LeaseStoppedError();
      }
      if (isRenewalResult(result)) {
        if (result.identity !== undefined) {
          if (this.identity !== undefined && !sameIdentity(this.identity, result.identity)) {
            throw new LeaseConfigurationError('lease owner identity cannot be replaced');
          }
          this.identity ??= Object.freeze({
            sessionId: result.identity.sessionId,
            runtimeId: result.identity.runtimeId,
          });
        }
        if (result.endpoint !== undefined) {
          this.currentEndpoint = result.endpoint;
        }
      }
      const renewedAt = clockValue(this.now);
      if (this.expiresAt !== null && renewedAt >= this.expiresAt) {
        this.markExpired();
        throw new LeaseExpiredError();
      }
      this.issuedAt ??= renewedAt;
      this.lastRenewedAt = renewedAt;
      this.expiresAt = renewedAt + this.ttlMs;
      this.state = 'active';
    });

    // A failed renewal must not poison later owner renewals.  The caller still
    // observes this operation's rejection, while the queue continues safely.
    this.pending = operation.then(
      () => undefined,
      (error: unknown) => {
        this.lastError = error;
        if (this.expiresAt !== null && clockValue(this.now) >= this.expiresAt) {
          this.markExpired();
        }
        return undefined;
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

  /** Stop timer work and wait for one in-flight owner renewal. */
  public async stop(): Promise<void> {
    if (this.state !== 'stopped') {
      this.state = 'stopped';
      if (this.timer !== undefined) {
        this.scheduler.clearInterval(this.timer);
        this.timer = undefined;
      }
    }
    await this.pending;
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
    return this.currentEndpoint;
  }

  public updateEndpoint(endpoint: RoutingEndpoint): void {
    validateEndpoint(endpoint);
    if (this.state === 'stopped' || this.state === 'expired') {
      throw new LeaseExpiredError();
    }
    this.currentEndpoint = endpoint;
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
    return this.identity !== undefined && sameIdentity(this.identity, identity);
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
      ...(this.identity === undefined ? {} : { sessionId: this.identity.sessionId }),
      ...(this.identity === undefined ? {} : { runtimeId: this.identity.runtimeId }),
      ...(this.currentEndpoint === undefined ? {} : { endpoint: this.currentEndpoint }),
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
    this.state = 'expired';
    if (this.timer !== undefined) {
      this.scheduler.clearInterval(this.timer);
      this.timer = undefined;
    }
  }
}

function isIdentity(value: LeaseOwnerIdentity): value is SessionRuntimeIdentity {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof value.sessionId === 'string' &&
    value.sessionId.length > 0 &&
    typeof value.runtimeId === 'string' &&
    value.runtimeId.length > 0
  );
}

function validateEndpoint(endpoint: RoutingEndpoint): void {
  if (typeof endpoint === 'string') {
    if (endpoint.trim().length === 0) {
      throw new LeaseConfigurationError('routing endpoint must not be empty');
    }
    return;
  }
  if (typeof endpoint !== 'object' || endpoint === null || Array.isArray(endpoint)) {
    throw new LeaseConfigurationError('routing endpoint must be an opaque string or descriptor');
  }
  if (typeof endpoint.address !== 'string' || endpoint.address.trim().length === 0) {
    throw new LeaseConfigurationError('routing endpoint address must not be empty');
  }
  if (endpoint.kind !== undefined && endpoint.transport !== undefined) {
    if (endpoint.kind !== endpoint.transport) {
      throw new LeaseConfigurationError('routing endpoint kind and transport must agree');
    }
  }
  if (endpoint.kind === undefined && endpoint.transport === undefined) {
    throw new LeaseConfigurationError('routing endpoint must identify its transport kind');
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
