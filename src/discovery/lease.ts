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
  /** Generation assigned by an owning registry to the committed endpoint state. */
  readonly endpointGeneration?: number;
  /** Authoritative lease timing returned by an owning registry. */
  readonly issuedAt?: number;
  readonly lastRenewedAt?: number;
  readonly expiresAt?: number;
}

export type LeaseRenewal = () => void | LeaseRenewalResult | PromiseLike<void | LeaseRenewalResult>;
export type LeaseEndpointUpdate = (endpoint: RoutingEndpoint) => void | LeaseRenewalResult;
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

const BUILTIN_DATE = Date;
const BUILTIN_DATE_GET_TIME = Date.prototype.getTime;
const BUILTIN_DATE_TO_ISO_STRING = Date.prototype.toISOString;

function dateMilliseconds(value: unknown): number | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }
  try {
    return BUILTIN_DATE_GET_TIME.call(value);
  } catch {
    return undefined;
  }
}

function asTimestamp(value: number): UtcTimestamp {
  const date = new BUILTIN_DATE(value);
  let milliseconds: number;
  try {
    milliseconds = BUILTIN_DATE_GET_TIME.call(date);
  } catch {
    throw new LeaseConfigurationError('lease expiry is outside the supported Date range');
  }
  if (!Number.isFinite(milliseconds)) {
    throw new LeaseConfigurationError('lease expiry is outside the supported Date range');
  }
  try {
    return BUILTIN_DATE_TO_ISO_STRING.call(date) as UtcTimestamp;
  } catch {
    throw new LeaseConfigurationError('lease expiry is outside the supported Date range');
  }
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

const RENEWAL_RESULT_FIELDS = [
  'endpoint',
  'identity',
  'endpointGeneration',
  'issuedAt',
  'lastRenewedAt',
  'expiresAt',
] as const;

function normalizeRenewalResult(value: unknown): LeaseRenewalResult | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }
  const result: Record<string, unknown> = {};
  let present = false;
  for (const key of RENEWAL_RESULT_FIELDS) {
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, key);
    } catch {
      throw new LeaseConfigurationError('lease renewal result cannot be inspected safely');
    }
    if (descriptor === undefined) {
      continue;
    }
    present = true;
    if (!('value' in descriptor)) {
      throw new LeaseConfigurationError('lease renewal result cannot contain accessors');
    }
    result[key] = descriptor.value;
  }
  return present ? (result as LeaseRenewalResult) : undefined;
}

interface RenewalMetadata {
  readonly endpointGeneration?: number;
  readonly issuedAt?: number;
  readonly lastRenewedAt?: number;
  readonly expiresAt?: number;
}

function normalizeRenewalMetadata(result: LeaseRenewalResult | undefined): RenewalMetadata {
  if (result === undefined) {
    return {};
  }
  const metadata: RenewalMetadata = {
    ...(result.endpointGeneration === undefined
      ? {}
      : { endpointGeneration: result.endpointGeneration }),
    ...(result.issuedAt === undefined ? {} : { issuedAt: result.issuedAt }),
    ...(result.lastRenewedAt === undefined ? {} : { lastRenewedAt: result.lastRenewedAt }),
    ...(result.expiresAt === undefined ? {} : { expiresAt: result.expiresAt }),
  };
  if (
    metadata.endpointGeneration !== undefined &&
    (!Number.isSafeInteger(metadata.endpointGeneration) || metadata.endpointGeneration < 0)
  ) {
    throw new LeaseConfigurationError('lease renewal endpoint generation must be non-negative');
  }
  for (const [label, value] of [
    ['issuedAt', metadata.issuedAt],
    ['lastRenewedAt', metadata.lastRenewedAt],
    ['expiresAt', metadata.expiresAt],
  ] as const) {
    if (value !== undefined && !Number.isFinite(value)) {
      throw new LeaseConfigurationError(`lease renewal ${label} must be finite`);
    }
  }
  if (
    metadata.issuedAt !== undefined &&
    metadata.lastRenewedAt !== undefined &&
    metadata.issuedAt > metadata.lastRenewedAt
  ) {
    throw new LeaseConfigurationError('lease renewal issuedAt must not exceed lastRenewedAt');
  }
  if (
    metadata.lastRenewedAt !== undefined &&
    metadata.expiresAt !== undefined &&
    metadata.expiresAt <= metadata.lastRenewedAt
  ) {
    throw new LeaseConfigurationError('lease renewal expiresAt must exceed lastRenewedAt');
  }
  return metadata;
}

function renewalTimes(
  metadata: RenewalMetadata,
  fallbackRenewedAt: number,
  ttlMs: number,
  currentIssuedAt: number | null,
): { readonly issuedAt: number; readonly lastRenewedAt: number; readonly expiresAt: number } {
  const lastRenewedAt = metadata.lastRenewedAt ?? fallbackRenewedAt;
  const expiresAt = metadata.expiresAt ?? lastRenewedAt + ttlMs;
  if (
    !Number.isFinite(lastRenewedAt) ||
    !Number.isFinite(expiresAt) ||
    expiresAt <= lastRenewedAt
  ) {
    throw new LeaseConfigurationError('lease renewal timing is invalid');
  }
  const issuedAt = metadata.issuedAt ?? currentIssuedAt ?? lastRenewedAt;
  if (!Number.isFinite(issuedAt) || issuedAt > lastRenewedAt) {
    throw new LeaseConfigurationError('lease renewal issuedAt is invalid');
  }
  return { issuedAt, lastRenewedAt, expiresAt };
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
  return dateMilliseconds(value) !== undefined;
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
        const milliseconds = BUILTIN_DATE_GET_TIME.call(value);
        return Number.isFinite(milliseconds)
          ? snapshotString(BUILTIN_DATE_TO_ISO_STRING.call(value), budget)
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
  private endpointGenerationAuthority: 'local' | 'registry' = 'local';
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
          const lifecycleGeneration = this.lifecycleGeneration;
          const now = clockValue(this.now);
          this.assertLifecycle(lifecycleGeneration);
          if (now >= this.expiresAt) {
            this.markExpired();
            return Promise.reject(new LeaseExpiredError());
          }
        } catch (error: unknown) {
          // A shared renewal attempt owns its error notification.  In particular,
          // expiry may reject the attempt while this concurrent preflight observes
          // the same lifecycle transition; reporting here would duplicate it.
          return Promise.reject(error);
        }
      }
      return this.inFlightRenewal;
    }
    const lifecycleGeneration = this.lifecycleGeneration;
    try {
      const now = clockValue(this.now);
      this.assertLifecycle(lifecycleGeneration);
      if (this.expiresAt !== null && now >= this.expiresAt) {
        this.markExpired();
        return Promise.reject(new LeaseExpiredError());
      }
      if (this.expiresAt === null) {
        this.expiresAt = now + this.ttlMs;
        this.armExpiryTimer(this.expiresAt);
      } else {
        this.armExpiryTimer(this.expiresAt);
      }
    } catch (error: unknown) {
      this.reportError(error);
      return Promise.reject(error);
    }
    let operationErrorReported = false;
    const reportOperationError = (error: unknown): void => {
      if (operationErrorReported) {
        return;
      }
      operationErrorReported = true;
      this.reportError(error);
    };
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
      const endpointGenerationAtStart = this.endpointGeneration;
      const endpointAuthorityAtStart = this.endpointGenerationAuthority;
      const now = clockValue(this.now);
      this.assertLifecycle(lifecycleGeneration);
      if (this.expiresAt !== null && now >= this.expiresAt) {
        this.markExpired();
        throw new LeaseExpiredError();
      }
      const renewalResult = Promise.resolve().then(() => this.renewal());
      const rawResult = await Promise.race([renewalResult, expiry]);
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
      const result = normalizeRenewalResult(rawResult);
      const metadata = normalizeRenewalMetadata(result);
      let nextIdentity: LeaseOwnerIdentity | undefined;
      let nextEndpoint: RoutingEndpoint | undefined;
      if (result?.identity !== undefined) {
        nextIdentity = cloneOwnerIdentity(result.identity);
        if (ownerAtStart !== undefined && !sameIdentity(ownerAtStart, nextIdentity)) {
          throw new LeaseConfigurationError('lease owner identity cannot be replaced');
        }
      }
      const effectiveRuntimeId = (ownerAtStart ?? nextIdentity)?.runtimeId;
      const hasFreshRegistryGeneration =
        metadata.endpointGeneration !== undefined &&
        metadata.endpointGeneration >= this.endpointGeneration;
      if (result?.endpoint !== undefined) {
        const endpointIsCurrent =
          metadata.endpointGeneration !== undefined
            ? hasFreshRegistryGeneration
            : this.endpointGeneration === endpointGenerationAtStart &&
              this.endpointGenerationAuthority === endpointAuthorityAtStart;
        if (endpointIsCurrent) {
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
      if (
        metadata.endpointGeneration !== undefined &&
        metadata.endpointGeneration < this.endpointGeneration
      ) {
        // The registry has already committed a newer endpoint/lease state;
        // retain that winning local snapshot instead of replaying stale data.
        return;
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
      }
      const committedOwner = this.ownerIdentity ?? nextIdentity;
      const renewedAt = clockValue(this.now);
      this.assertLifecycle(lifecycleGeneration);
      if (this.ownerIdentity !== undefined && ownerAtStart !== undefined) {
        if (!sameIdentity(this.ownerIdentity, ownerAtStart)) {
          throw new LeaseConfigurationError('lease owner identity changed during renewal');
        }
      } else if (this.ownerIdentity !== ownerAtStart) {
        throw new LeaseConfigurationError('lease owner identity changed during renewal');
      }
      if (
        metadata.endpointGeneration !== undefined &&
        metadata.endpointGeneration < this.endpointGeneration
      ) {
        // The registry has already committed a newer endpoint/lease state;
        // retain that winning local snapshot instead of replaying stale data.
        return;
      }
      if (
        metadata.endpointGeneration === undefined &&
        (this.endpointGeneration !== endpointGenerationAtStart ||
          this.endpointGenerationAuthority !== endpointAuthorityAtStart)
      ) {
        // A reentrant endpoint update won the race.  Keep its endpoint and
        // commit only the renewal metadata from this callback.
        nextEndpoint = undefined;
      }
      const commitMetadata = metadata;
      const times = renewalTimes(commitMetadata, renewedAt, this.ttlMs, this.issuedAt);
      if (this.expiresAt !== null && renewedAt >= this.expiresAt) {
        this.markExpired();
        throw new LeaseExpiredError();
      }
      if (times.expiresAt <= renewedAt) {
        this.markExpired();
        throw new LeaseExpiredError();
      }
      // No callback is allowed between this final lifecycle/ownership check
      // and the active endpoint/renewal-state writes below.
      this.assertLifecycle(lifecycleGeneration);
      if (this.ownerIdentity !== undefined && ownerAtStart !== undefined) {
        if (!sameIdentity(this.ownerIdentity, ownerAtStart)) {
          throw new LeaseConfigurationError('lease owner identity changed during renewal');
        }
      } else if (this.ownerIdentity !== ownerAtStart) {
        throw new LeaseConfigurationError('lease owner identity changed during renewal');
      }
      if (
        metadata.endpointGeneration !== undefined &&
        metadata.endpointGeneration < this.endpointGeneration
      ) {
        return;
      }
      if (commitMetadata.endpointGeneration !== undefined) {
        this.endpointGeneration = commitMetadata.endpointGeneration;
        this.endpointGenerationAuthority = 'registry';
      } else if (nextEndpoint !== undefined) {
        this.endpointGeneration += 1;
        this.endpointGenerationAuthority = 'local';
      }
      this.ownerIdentity ??= committedOwner;
      if (nextEndpoint !== undefined) {
        this.currentEndpoint = nextEndpoint;
      }
      this.issuedAt = times.issuedAt;
      this.lastRenewedAt = times.lastRenewedAt;
      this.expiresAt = times.expiresAt;
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
        reportOperationError(error);
        try {
          if (this.expiresAt !== null && clockValue(this.now) >= this.expiresAt) {
            this.markExpired();
          }
        } catch (handlerError: unknown) {
          this.reportError(handlerError);
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
    const lifecycleGeneration = this.lifecycleGeneration;
    let renewalTimer: LeaseTimer | undefined;
    try {
      const startedAt = clockValue(this.now);
      this.assertLifecycle(lifecycleGeneration);
      if (this.expiresAt !== null && startedAt >= this.expiresAt) {
        this.markExpired();
        throw new LeaseExpiredError();
      }
      // Establish an independent local deadline before the initial callback is
      // invoked.  A hung callback must not leave this lease immortal.
      this.expiresAt ??= startedAt + this.ttlMs;
      this.state = 'active';
      this.armExpiryTimer(this.expiresAt);
      renewalTimer = this.scheduler.setInterval(
        () => {
          if (this.state !== 'active') {
            return;
          }
          try {
            const timerGeneration = this.lifecycleGeneration;
            const now = clockValue(this.now);
            const timerState: LeaseState = this.state;
            if (this.lifecycleGeneration !== timerGeneration || timerState !== 'active') {
              return;
            }
            if (this.expiresAt !== null && now >= this.expiresAt) {
              this.markExpired();
              return;
            }
          } catch (error: unknown) {
            this.reportError(error);
            void this.stop();
            return;
          }
          // renew() and its serialized rejection observer own error reporting;
          // this catch only prevents a preflight rejection from becoming unhandled.
          void this.renew().catch(() => undefined);
        },
        Math.min(this.renewalIntervalMs, this.ttlMs, MAX_LEASE_TIMER_DELAY_MS),
      );
      const setupState: LeaseState = this.state;
      if (setupState !== 'active' || this.lifecycleGeneration !== lifecycleGeneration) {
        try {
          this.scheduler.clearInterval(renewalTimer);
        } catch (error: unknown) {
          this.reportError(error);
        }
        this.assertLifecycle(lifecycleGeneration);
        throw new LeaseStoppedError();
      }
      this.timer = renewalTimer;
      const unrefTimer = renewalTimer as LeaseTimer & { unref?: () => void };
      unrefTimer.unref?.();
      const postUnrefState: LeaseState = this.state;
      if (postUnrefState !== 'active' || this.lifecycleGeneration !== lifecycleGeneration) {
        this.assertLifecycle(lifecycleGeneration);
        throw new LeaseStoppedError();
      }
      this.startPromise = this.renew().catch(async (error: unknown) => {
        await this.stop();
        throw error;
      });
      return this.startPromise;
    } catch (error: unknown) {
      if (renewalTimer !== undefined && this.timer === renewalTimer) {
        this.timer = undefined;
        try {
          this.scheduler.clearInterval(renewalTimer);
        } catch (clearError: unknown) {
          this.reportError(clearError);
        }
      }
      const cleanupState: LeaseState = this.state;
      if (cleanupState === 'active') {
        void this.stop();
      }
      this.reportError(error);
      return Promise.reject(error);
    }
  }

  /** Stop timer work without waiting for a potentially hung owner renewal. */
  public stop(): Promise<void> {
    if (this.state === 'stopped') {
      return Promise.resolve();
    }
    const wasExpired = this.state === 'expired';
    if (!wasExpired) {
      this.state = 'stopped';
      this.rejectInFlight(new LeaseStoppedError());
      this.invalidateLifecycle();
    }
    const timer = this.timer;
    this.timer = undefined;
    if (timer !== undefined) {
      try {
        this.scheduler.clearInterval(timer);
      } catch (error: unknown) {
        this.reportError(error);
      }
    }
    this.clearExpiryTimer();
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
    const endpointGenerationAtStart = this.endpointGeneration;
    const endpointAuthorityAtStart = this.endpointGenerationAuthority;
    const ownerAtStart = this.ownerIdentity;
    const nowBeforeCallback = clockValue(this.now);
    this.assertLifecycle(lifecycleGeneration);
    if (this.expiresAt !== null && nowBeforeCallback >= this.expiresAt) {
      this.markExpired();
      throw new LeaseExpiredError();
    }
    if (this.ownerIdentity !== undefined && ownerAtStart !== undefined) {
      if (!sameIdentity(this.ownerIdentity, ownerAtStart)) {
        throw new LeaseConfigurationError('lease owner changed before endpoint update');
      }
    } else if (this.ownerIdentity !== ownerAtStart) {
      throw new LeaseConfigurationError('lease owner changed before endpoint update');
    }
    if (
      this.endpointGeneration !== endpointGenerationAtStart ||
      this.endpointGenerationAuthority !== endpointAuthorityAtStart
    ) {
      throw new LeaseConfigurationError('endpoint update became stale before callback');
    }
    const endpointCopy = cloneEndpoint(endpoint, ownerAtStart?.runtimeId);
    // Endpoint validation may inspect a caller-controlled object.  Recheck every
    // lease fence after that inspection and immediately before reflection so a
    // reentrant stop/expire/endpoint update cannot invoke a stale callback.
    const nowImmediatelyBeforeCallback = clockValue(this.now);
    this.assertLifecycle(lifecycleGeneration);
    if (nowImmediatelyBeforeCallback >= (this.expiresAt ?? Number.POSITIVE_INFINITY)) {
      this.markExpired();
      throw new LeaseExpiredError();
    }
    if (this.ownerIdentity !== undefined && ownerAtStart !== undefined) {
      if (!sameIdentity(this.ownerIdentity, ownerAtStart)) {
        throw new LeaseConfigurationError('lease owner changed before endpoint callback');
      }
    } else if (this.ownerIdentity !== ownerAtStart) {
      throw new LeaseConfigurationError('lease owner changed before endpoint callback');
    }
    if (
      this.endpointGeneration !== endpointGenerationAtStart ||
      this.endpointGenerationAuthority !== endpointAuthorityAtStart
    ) {
      throw new LeaseConfigurationError('endpoint update became stale before callback');
    }
    // Persist through the owning registry before changing this lease's local
    // snapshot.  A failed publication therefore cannot create divergent state.
    const callbackResult = this.onEndpointUpdate?.(endpointCopy);
    const result = normalizeRenewalResult(callbackResult);
    const metadata = normalizeRenewalMetadata(result);
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
    let nextIdentity: LeaseOwnerIdentity | undefined;
    if (result?.identity !== undefined) {
      nextIdentity = cloneOwnerIdentity(result.identity);
      if (ownerAtStart !== undefined && !sameIdentity(ownerAtStart, nextIdentity)) {
        throw new LeaseConfigurationError('lease owner identity cannot be replaced');
      }
    }
    if (this.ownerIdentity !== undefined && ownerAtStart !== undefined) {
      if (!sameIdentity(this.ownerIdentity, ownerAtStart)) {
        throw new LeaseConfigurationError('lease owner changed during endpoint update');
      }
    } else if (this.ownerIdentity !== ownerAtStart) {
      throw new LeaseConfigurationError('lease owner changed during endpoint update');
    }
    if (nextIdentity !== undefined) {
      if (this.ownerIdentity !== undefined && !sameIdentity(this.ownerIdentity, nextIdentity)) {
        throw new LeaseConfigurationError('lease owner cannot be replaced during endpoint update');
      }
    }
    const committedOwner = this.ownerIdentity ?? nextIdentity;
    const returnedEndpoint = result?.endpoint;
    const returnedRuntimeId = committedOwner?.runtimeId;
    let committedEndpoint: RoutingEndpoint;
    if (metadata.endpointGeneration !== undefined) {
      if (metadata.endpointGeneration < this.endpointGeneration) {
        throw new LeaseConfigurationError('endpoint update became stale during callback');
      }
      committedEndpoint = cloneEndpoint(returnedEndpoint ?? endpointCopy, returnedRuntimeId);
    } else {
      if (
        this.endpointGeneration !== endpointGenerationAtStart ||
        this.endpointGenerationAuthority !== endpointAuthorityAtStart
      ) {
        throw new LeaseConfigurationError('endpoint update became stale during callback');
      }
      committedEndpoint = cloneEndpoint(returnedEndpoint ?? endpointCopy, returnedRuntimeId);
    }
    const renewedAt = clockValue(this.now);
    this.assertLifecycle(lifecycleGeneration);
    if (this.ownerIdentity !== undefined && ownerAtStart !== undefined) {
      if (!sameIdentity(this.ownerIdentity, ownerAtStart)) {
        throw new LeaseConfigurationError('lease owner changed during endpoint update');
      }
    } else if (this.ownerIdentity !== ownerAtStart) {
      throw new LeaseConfigurationError('lease owner changed during endpoint update');
    }
    if (metadata.endpointGeneration !== undefined) {
      if (metadata.endpointGeneration < this.endpointGeneration) {
        throw new LeaseConfigurationError('endpoint update became stale during callback');
      }
    } else if (
      this.endpointGeneration !== endpointGenerationAtStart ||
      this.endpointGenerationAuthority !== endpointAuthorityAtStart
    ) {
      throw new LeaseConfigurationError('endpoint update became stale during callback');
    }
    const times = renewalTimes(metadata, renewedAt, this.ttlMs, this.issuedAt);
    // The callback cannot extend the deadline that was current when this
    // endpoint update began.  Check it again immediately before committing.
    if (this.expiresAt !== null && renewedAt >= this.expiresAt) {
      this.markExpired();
      throw new LeaseExpiredError();
    }
    if (times.expiresAt <= renewedAt) {
      this.markExpired();
      throw new LeaseExpiredError();
    }
    // No callback is allowed between this final lifecycle/ownership check
    // and the endpoint/renewal-state writes below.
    this.assertLifecycle(lifecycleGeneration);
    if (this.ownerIdentity !== undefined && ownerAtStart !== undefined) {
      if (!sameIdentity(this.ownerIdentity, ownerAtStart)) {
        throw new LeaseConfigurationError('lease owner changed during endpoint update');
      }
    } else if (this.ownerIdentity !== ownerAtStart) {
      throw new LeaseConfigurationError('lease owner changed during endpoint update');
    }
    if (metadata.endpointGeneration !== undefined) {
      this.endpointGeneration = metadata.endpointGeneration;
      this.endpointGenerationAuthority = 'registry';
    } else {
      this.endpointGeneration += 1;
      this.endpointGenerationAuthority = 'local';
    }
    this.ownerIdentity ??= committedOwner;
    this.currentEndpoint = committedEndpoint;
    this.issuedAt = times.issuedAt;
    this.lastRenewedAt = times.lastRenewedAt;
    this.expiresAt = times.expiresAt;
    this.state = 'active';
    this.armExpiryTimer(this.expiresAt);
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

  private reportError(error: unknown): void {
    let diagnostic: unknown;
    try {
      diagnostic = sanitizeSnapshotValue(error);
    } catch {
      diagnostic = SNAPSHOT_UNREADABLE;
    }
    this.lastError = diagnostic;
    try {
      this.onError?.(error);
    } catch {
      // Error observers are isolated from lease lifecycle cleanup; only the
      // bounded diagnostic snapshot above is retained by the lease.
    }
  }
  private assertLifecycle(generation: number): void {
    const state: LeaseState = this.state;
    if (state === 'stopped') {
      throw new LeaseStoppedError();
    }
    if (state === 'expired') {
      throw new LeaseExpiredError();
    }
    if (this.lifecycleGeneration !== generation) {
      throw new LeaseStoppedError();
    }
  }
  private armExpiryTimer(deadline: number): void {
    if (this.state === 'stopped' || this.state === 'expired') {
      return;
    }
    if (!Number.isFinite(deadline)) {
      const error = new LeaseConfigurationError('lease expiry must be finite');
      void this.stop();
      throw error;
    }
    const lifecycleGeneration = this.lifecycleGeneration;
    const previousTimer = this.expiryTimer;
    const previousDeadline = this.expiryTimerDeadline;
    const handler = (): void => {
      if (this.expiryTimerDeadline !== deadline) {
        return;
      }
      const activeTimer = this.expiryTimer;
      this.expiryTimer = undefined;
      this.expiryTimerDeadline = null;
      if (activeTimer !== undefined) {
        try {
          this.scheduler.clearInterval(activeTimer);
        } catch (error: unknown) {
          this.reportError(error);
        }
      }
      try {
        const handlerGeneration = this.lifecycleGeneration;
        const now = clockValue(this.now);
        const handlerState: LeaseState = this.state;
        if (
          this.lifecycleGeneration !== handlerGeneration ||
          handlerState === 'stopped' ||
          handlerState === 'expired'
        ) {
          return;
        }
        if (now >= deadline) {
          this.markExpired();
        } else {
          this.armExpiryTimer(deadline);
        }
      } catch (error: unknown) {
        const handlerFailureState = this.state as LeaseState;
        if (handlerFailureState !== 'stopped' && handlerFailureState !== 'expired') {
          void this.stop();
        }
        this.reportError(error);
      }
    };
    let replacement: LeaseTimer | undefined;
    try {
      const setupGeneration = this.lifecycleGeneration;
      const now = clockValue(this.now);
      const setupState = this.state as LeaseState;
      if (
        this.lifecycleGeneration !== setupGeneration ||
        setupState === 'stopped' ||
        setupState === 'expired'
      ) {
        this.assertLifecycle(lifecycleGeneration);
        throw new LeaseStoppedError();
      }
      replacement = this.scheduler.setInterval(
        handler,
        Math.max(1, Math.min(MAX_LEASE_TIMER_DELAY_MS, deadline - now)),
      );
      const unrefTimer = replacement as LeaseTimer & { unref?: () => void };
      unrefTimer.unref?.();
      const postUnrefState = this.state as LeaseState;
      if (
        this.lifecycleGeneration !== lifecycleGeneration ||
        postUnrefState === 'stopped' ||
        postUnrefState === 'expired'
      ) {
        this.assertLifecycle(lifecycleGeneration);
        throw new LeaseStoppedError();
      }
      if (this.expiryTimer !== previousTimer || this.expiryTimerDeadline !== previousDeadline) {
        try {
          this.scheduler.clearInterval(replacement);
        } catch (clearError: unknown) {
          this.reportError(clearError);
        }
        if (this.expiryTimer !== undefined && this.expiryTimerDeadline !== null) {
          return;
        }
        throw new LeaseStoppedError();
      }
    } catch (error: unknown) {
      if (replacement !== undefined) {
        try {
          this.scheduler.clearInterval(replacement);
        } catch (clearError: unknown) {
          this.reportError(clearError);
        }
      }
      const failureState = this.state as LeaseState;
      if (failureState !== 'stopped' && failureState !== 'expired') {
        void this.stop();
      }
      throw error;
    }
    // Install the replacement before clearing the old timer.  A scheduler
    // failure therefore never leaves a live lease without its prior timer.
    this.expiryTimer = replacement;
    this.expiryTimerDeadline = deadline;
    if (previousTimer !== undefined && previousTimer !== replacement) {
      try {
        this.scheduler.clearInterval(previousTimer);
      } catch (error: unknown) {
        this.reportError(error);
      }
    }
  }
  private clearExpiryTimer(): void {
    const timer = this.expiryTimer;
    this.expiryTimer = undefined;
    this.expiryTimerDeadline = null;
    if (timer !== undefined) {
      try {
        this.scheduler.clearInterval(timer);
      } catch (error: unknown) {
        this.reportError(error);
      }
    }
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
    const timer = this.timer;
    this.timer = undefined;
    if (timer !== undefined) {
      try {
        this.scheduler.clearInterval(timer);
      } catch (error: unknown) {
        this.reportError(error);
      }
    }
    this.clearExpiryTimer();
  }

  private invalidateLifecycle(): void {
    // Invalidate before invoking user code so a callback that is still
    // resolving cannot commit stale endpoint or lease state.
    this.lifecycleGeneration += 1;
    try {
      this.onStop?.();
    } catch (error: unknown) {
      this.reportError(error);
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
  if (typeof endpoint !== 'object' || endpoint === null) {
    throw new LeaseConfigurationError('routing endpoint must be an opaque string or descriptor');
  }
  let isArray: boolean;
  let prototype: object | null;
  let keys: string[];
  let symbols: symbol[];
  try {
    isArray = Array.isArray(endpoint);
    prototype = Object.getPrototypeOf(endpoint);
    keys = Object.getOwnPropertyNames(endpoint);
    symbols = Object.getOwnPropertySymbols(endpoint);
  } catch {
    throw new LeaseConfigurationError('routing endpoint descriptor cannot be inspected safely');
  }
  if (isArray) {
    throw new LeaseConfigurationError('routing endpoint must be an opaque string or descriptor');
  }
  if (prototype !== Object.prototype && prototype !== null) {
    throw new LeaseConfigurationError('routing endpoint descriptor must be a plain object');
  }
  if (symbols.length > 0 || keys.length > MAX_ENDPOINT_KEYS) {
    throw new LeaseConfigurationError('routing endpoint descriptor has too many fields');
  }
  const allowedKeys = new Set(['address', 'kind', 'transport', 'runtimeId']);
  const descriptors = new Map<string, PropertyDescriptor>();
  for (const key of keys) {
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(endpoint, key);
    } catch {
      throw new LeaseConfigurationError('routing endpoint descriptor cannot be inspected safely');
    }
    if (descriptor === undefined || !('value' in descriptor) || !descriptor.enumerable) {
      throw new LeaseConfigurationError(
        'routing endpoint descriptor cannot contain accessors or hidden fields',
      );
    }
    descriptors.set(key, descriptor);
    if (!allowedKeys.has(key)) {
      throw new LeaseConfigurationError(
        FORBIDDEN_ENDPOINT_KEYS.has(key)
          ? 'routing endpoint cannot carry credentials'
          : 'routing endpoint contains an unknown field',
      );
    }
  }
  const ownValue = (key: string): unknown => descriptors.get(key)?.value;
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
  const now =
    options.now === undefined
      ? Date.now()
      : typeof options.now === 'number'
        ? options.now
        : dateMilliseconds(options.now);
  if (typeof now !== 'number' || !Number.isFinite(now)) {
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
