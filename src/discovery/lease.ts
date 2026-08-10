/**
 * Lease timing and renewal primitives for the runtime registry.
 *
 * A lease is owned by exactly one runtime.  The timer only invokes the supplied
 * owner callback; it never probes or removes another runtime's record.  Keeping
 * this boundary independent from the filesystem makes clock and timer behavior
 * deterministic in unit tests and lets lifecycle integration stop it safely.
 */

/** The canonical renewal interval shared by all discovery contracts. */
export const DEFAULT_LEASE_RENEWAL_INTERVAL_MS = 30_000;
/** The canonical time-to-live shared by all discovery contracts. */
export const DEFAULT_LEASE_TTL_MS = 90_000;

/** Compatibility aliases for callers that use the shorter names. */
export const DEFAULT_RENEWAL_INTERVAL_MS = DEFAULT_LEASE_RENEWAL_INTERVAL_MS;
export const DEFAULT_TTL_MS = DEFAULT_LEASE_TTL_MS;
export const LEASE_RENEWAL_INTERVAL_MS = DEFAULT_LEASE_RENEWAL_INTERVAL_MS;
export const LEASE_TTL_MS = DEFAULT_LEASE_TTL_MS;

export type LeaseTimestamp = number | Date | string;
export type LeaseClock = () => number;
export type LeaseRenewal = () => void | Promise<void>;
export type LeaseTimer = ReturnType<typeof setInterval>;
export type LeaseErrorHandler = (error: unknown) => void;

export interface LeaseScheduler {
  readonly setInterval: (handler: () => void, delayMs: number) => LeaseTimer;
  readonly clearInterval: (timer: LeaseTimer) => void;
}

export interface SerializedLeaseOptions {
  /** The sole owner operation to invoke for each renewal. */
  readonly renew: LeaseRenewal;
  readonly ttlMs?: number;
  readonly renewalIntervalMs?: number;
  readonly onError?: LeaseErrorHandler;
  readonly scheduler?: LeaseScheduler;
  readonly now?: LeaseClock;
}

type LeaseConstructionOptions = Omit<SerializedLeaseOptions, 'renew'>;

export interface LeaseSnapshot {
  readonly running: boolean;
  readonly stopped: boolean;
  readonly ttlMs: number;
  readonly renewalIntervalMs: number;
  readonly lastRenewedAt: number | null;
  readonly lastError: unknown | null;
}

export class LeaseConfigurationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'LeaseConfigurationError';
  }
}

export class LeaseStoppedError extends Error {
  public constructor() {
    super('Lease renewal has been stopped');
    this.name = 'LeaseStoppedError';
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

function finiteTimestamp(value: number, label: string): number {
  if (!Number.isFinite(value) || !Number.isSafeInteger(value) || value < 0) {
    throw new LeaseConfigurationError(`${label} must be a non-negative safe integer timestamp`);
  }
  return value;
}

/** Parse a serialized or in-memory lease timestamp to epoch milliseconds. */
export function parseLeaseTimestamp(value: LeaseTimestamp, label = 'lease timestamp'): number {
  const parsed =
    value instanceof Date ? value.getTime() : typeof value === 'string' ? Date.parse(value) : value;
  return finiteTimestamp(parsed, label);
}

/** Serialize an in-memory lease timestamp as canonical ISO-8601 UTC text. */
export function serializeLeaseTimestamp(value: LeaseTimestamp, label = 'lease timestamp'): string {
  const parsed = parseLeaseTimestamp(value, label);
  try {
    return new Date(parsed).toISOString();
  } catch {
    throw new LeaseConfigurationError(`${label} is outside the supported ISO timestamp range`);
  }
}

/** Calculate and serialize a lease expiry using the canonical policy. */
export function leaseExpirationIso(options?: {
  readonly now?: number | Date;
  readonly ttlMs?: number;
}): string {
  return serializeLeaseTimestamp(leaseExpiration(options), 'lease expiration');
}

function clockValue(clock: LeaseClock): number {
  return finiteTimestamp(clock(), 'lease clock');
}

/**
 * Calculate an absolute lease expiry from an injectable clock and duration.
 *
 * The object overload is convenient for callers publishing records, while the
 * positional overload keeps the pure helper pleasant to use in tests.
 */
export function leaseExpiration(options?: {
  readonly now?: number | Date;
  readonly ttlMs?: number;
}): number;
export function leaseExpiration(now: number | Date, ttlMs?: number): number;
export function leaseExpiration(
  optionsOrNow: number | Date | { readonly now?: number | Date; readonly ttlMs?: number } = {},
  positionalTtlMs?: number,
): number {
  const positional = typeof optionsOrNow === 'number' || optionsOrNow instanceof Date;
  const nowInput = positional ? optionsOrNow : optionsOrNow.now;
  const now =
    nowInput === undefined ? Date.now() : nowInput instanceof Date ? nowInput.getTime() : nowInput;
  if (!Number.isFinite(now) || !Number.isSafeInteger(now) || now < 0) {
    throw new LeaseConfigurationError('lease timestamp must be a non-negative safe integer');
  }

  const ttlMs = duration(
    positional ? positionalTtlMs : optionsOrNow.ttlMs,
    DEFAULT_LEASE_TTL_MS,
    'ttlMs',
  );
  const expiry = now + ttlMs;
  if (!Number.isSafeInteger(expiry)) {
    throw new LeaseConfigurationError('lease expiration is outside the supported timestamp range');
  }
  return expiry;
}

/** Alias used by record-publishing callers. */
export const leaseExpiresAt = leaseExpiration;

/** Return whether an in-memory or serialized expiry has passed at the supplied clock value. */
export function isLeaseExpired(leaseExpiresAt: LeaseTimestamp, now = Date.now()): boolean {
  if (!Number.isFinite(now)) {
    return true;
  }
  try {
    return parseLeaseTimestamp(leaseExpiresAt) <= now;
  } catch {
    return true;
  }
}

/** Keep only records whose lease expiry is still in the future. */
export function filterUnexpiredRecords<T extends { readonly leaseExpiresAt: LeaseTimestamp }>(
  records: readonly T[],
  now = Date.now(),
): T[] {
  return records.filter((record) => !isLeaseExpired(record.leaseExpiresAt, now));
}

/** Descriptive alias for discovery code. */
export const filterLiveRecords = filterUnexpiredRecords;

/**
 * A serialized, idempotently stoppable lease timer.
 *
 * `renew()` is available before `start()` for an initial publication.  Renewal
 * callbacks are queued, so a slow filesystem write can never overlap a later
 * write for the same runtime.  `stop()` waits for the final in-flight callback.
 */
export class SerializedLease {
  public readonly ttlMs: number;
  public readonly renewalIntervalMs: number;

  private readonly renewal: LeaseRenewal;
  private readonly onError: LeaseErrorHandler | undefined;
  private readonly scheduler: LeaseScheduler;
  private readonly now: LeaseClock;
  private pending: Promise<void> = Promise.resolve();
  private timer: LeaseTimer | undefined;
  private state: 'idle' | 'running' | 'stopped' = 'idle';
  private startPromise: Promise<void> | undefined;
  private lastRenewedAt: number | null = null;
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
  }

  /** Queue one owner renewal behind all earlier owner renewals. */
  public renew(): Promise<void> {
    const operation = this.pending.then(async () => {
      if (this.state === 'stopped') {
        throw new LeaseStoppedError();
      }
      await this.renewal();
      this.lastRenewedAt = clockValue(this.now);
    });

    // A failed callback must not permanently poison subsequent renewals.  The
    // caller still receives the original rejection through `operation`.
    this.pending = operation.then(
      () => undefined,
      (error: unknown) => {
        this.lastError = error;
        return undefined;
      },
    );
    return operation;
  }

  /** Start periodic renewal and perform one immediate owner renewal. */
  public start(): Promise<void> {
    if (this.state === 'stopped') {
      return Promise.reject(new LeaseStoppedError());
    }
    if (this.startPromise) {
      return this.startPromise;
    }

    this.state = 'running';
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

  /** Stop future timer work and wait for any in-flight owner renewal. */
  public async stop(): Promise<void> {
    if (this.state === 'stopped') {
      await this.pending;
      return;
    }

    this.state = 'stopped';
    if (this.timer !== undefined) {
      this.scheduler.clearInterval(this.timer);
      this.timer = undefined;
    }
    await this.pending;
  }

  public get running(): boolean {
    return this.state === 'running';
  }

  public get stopped(): boolean {
    return this.state === 'stopped';
  }

  public isRunning(): boolean {
    return this.running;
  }

  public isStopped(): boolean {
    return this.stopped;
  }

  public snapshot(): LeaseSnapshot {
    return {
      running: this.running,
      stopped: this.stopped,
      ttlMs: this.ttlMs,
      renewalIntervalMs: this.renewalIntervalMs,
      lastRenewedAt: this.lastRenewedAt,
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
}

/** Descriptive aliases for integration code. */
export class RenewableLease extends SerializedLease {}
export class Lease extends SerializedLease {}
export class LeaseManager extends SerializedLease {}

export function createSerializedLease(options: SerializedLeaseOptions): SerializedLease {
  return new SerializedLease(options);
}

export const createRenewableLease = createSerializedLease;
export const createLease = createSerializedLease;
