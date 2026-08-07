/**
 * Runtime-local, retry-safe deduplication for mutating protocol operations.
 *
 * The store deliberately has no persistence or process-global state.  Create a
 * new instance for every live runtime; a replacement runtime therefore starts
 * with an empty deduplication set.
 */

import { createHash } from 'node:crypto';

import { DEFAULT_REQUEST_TTL_MS, DEDUPE_RETENTION_GRACE_MS } from '../config.js';
import { createProtocolError } from '../protocol/errors.js';
import type { ProtocolError } from '../protocol/errors.js';
import type { OperationName, ProtocolEnvelope } from '../protocol/messages.js';

/** Operations whose delivery can cause a mutation and must be deduplicated. */
export const DEDUPE_OPERATION_NAMES = [
  'message.request',
  'message.notify',
  'message.reply',
  'task.cancel',
] as const;

export type DedupeOperationName = (typeof DEDUPE_OPERATION_NAMES)[number];
export type DeduplicatedOperationName = DedupeOperationName;

/** A loose input type is useful at the routing boundary before validation. */
export interface DedupeOperationInput {
  readonly operation: OperationName | string;
  readonly operationId: string;
  readonly sender?: {
    readonly runtimeId: string;
    readonly [key: string]: unknown;
  };
  readonly senderRuntimeId?: string;
  readonly expiresAt?: string | number | Date;
  readonly [key: string]: unknown;
}

export type DedupeOperation = ProtocolEnvelope | DedupeOperationInput;

export function isDedupeOperation(operation: unknown): operation is DedupeOperationName {
  return (
    typeof operation === 'string' &&
    (DEDUPE_OPERATION_NAMES as readonly string[]).includes(operation)
  );
}

export const isDeduplicatedOperation = isDedupeOperation;

/** A stable composite key.  The NUL separator cannot occur in validated IDs. */
export type DedupeKey = string;

export interface DedupeKeyParts {
  readonly senderRuntimeId: string;
  readonly operationId: string;
}

export function makeDedupeKey(senderRuntimeId: string, operationId: string): DedupeKey {
  return `${senderRuntimeId}\u0000${operationId}`;
}

export const createDedupeKey = makeDedupeKey;
export const keyForOperation = makeDedupeKey;

/**
 * The binding may carry credentials alongside the application envelope.  These
 * names are intentionally removed only for fingerprinting; they are never
 * logged or retained by this module.
 */
const CREDENTIAL_FIELD_NAMES = new Set([
  'credential',
  'credentials',
  'accessToken',
  'capabilityToken',
  'authorization',
  'authentication',
]);
const EXPLICIT_BINDING_CREDENTIAL_FIELD_NAMES = new Set([
  'bindingCredential',
  'bindingCredentials',
]);
const BINDING_CONTAINER_NAMES = new Set(['binding', 'bindingMetadata', 'transport']);
const SENDER_FIELD_NAME = 'sender';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Remove binding-only fields without changing the application payload.  Generic
 * credential names are ignored at the operation/sender/binding boundary; the
 * same names inside application metadata remain application data.
 */
function withoutBindingCredentials(
  value: unknown,
  seen: Set<object>,
  root: boolean,
  bindingBoundary = false,
  senderBoundary = false,
): unknown {
  if (value === null || typeof value !== 'object') {
    return value;
  }

  if (seen.has(value)) {
    throw new TypeError('operation fingerprint cannot contain cyclic data');
  }
  seen.add(value);

  try {
    if (Array.isArray(value)) {
      return value.map((item) =>
        withoutBindingCredentials(item, seen, false, bindingBoundary, senderBoundary),
      );
    }

    const result: Record<string, unknown> = {};
    const object = value as Record<string, unknown>;
    for (const key of Object.keys(object)) {
      const isCredentialField =
        EXPLICIT_BINDING_CREDENTIAL_FIELD_NAMES.has(key) ||
        ((root || bindingBoundary || senderBoundary) && CREDENTIAL_FIELD_NAMES.has(key));
      if (isCredentialField) {
        continue;
      }
      if ((root || bindingBoundary) && BINDING_CONTAINER_NAMES.has(key)) {
        continue;
      }

      const child = object[key];
      // Undefined properties are omitted by JSON serialization and therefore
      // cannot be part of the wire fingerprint.
      if (child !== undefined) {
        result[key] = withoutBindingCredentials(
          child,
          seen,
          false,
          bindingBoundary || BINDING_CONTAINER_NAMES.has(key),
          senderBoundary || (root && key === SENDER_FIELD_NAME),
        );
      }
    }
    return result;
  } finally {
    seen.delete(value);
  }
}

/**
 * RFC 8785-style canonical JSON for JSON-compatible values.
 *
 * JavaScript's JSON.stringify number formatting matches the ECMAScript number
 * serialization required by JCS for finite numbers (including -0 -> 0).  Keys
 * are sorted by their UTF-16 code units, arrays retain their order, and no
 * insignificant whitespace is emitted.
 */
export function canonicalizeJson(value: unknown): string {
  const stack = new Set<object>();

  const write = (current: unknown): string => {
    if (current === null) {
      return 'null';
    }

    switch (typeof current) {
      case 'string':
        return JSON.stringify(current);
      case 'boolean':
        return current ? 'true' : 'false';
      case 'number': {
        if (!Number.isFinite(current)) {
          throw new TypeError('canonical JSON cannot contain non-finite numbers');
        }
        return JSON.stringify(current);
      }
      case 'undefined':
        throw new TypeError('canonical JSON cannot contain undefined at the root');
      case 'bigint':
        throw new TypeError('canonical JSON cannot contain bigint values');
      case 'function':
      case 'symbol':
        throw new TypeError('canonical JSON cannot contain non-JSON values');
      case 'object':
        break;
      default:
        throw new TypeError('canonical JSON contains an unsupported value');
    }

    if (stack.has(current)) {
      throw new TypeError('canonical JSON cannot contain cyclic data');
    }
    stack.add(current);

    try {
      if (Array.isArray(current)) {
        return `[${current.map((item) => (item === undefined ? 'null' : write(item))).join(',')}]`;
      }

      const object = current as Record<string, unknown>;
      const keys = Object.keys(object).sort();
      const members: string[] = [];
      for (const key of keys) {
        const member = object[key];
        // Match JSON serialization for optional JS-only properties.  Wire
        // envelopes are JSON and therefore cannot carry undefined members.
        if (member === undefined || typeof member === 'function' || typeof member === 'symbol') {
          continue;
        }
        members.push(`${JSON.stringify(key)}:${write(member)}`);
      }
      return `{${members.join(',')}}`;
    } finally {
      stack.delete(current);
    }
  };

  return write(value);
}

/** Canonical wire data used for operation identity comparisons. */
export function canonicalizeOperation(operation: unknown, bindingCredentials?: unknown): string {
  // Credentials supplied as a separate binding argument are deliberately not
  // incorporated.  Keeping the parameter documents the boundary for callers.
  void bindingCredentials;
  return canonicalizeJson(withoutBindingCredentials(operation, new Set<object>(), true));
}

export const canonicalOperation = canonicalizeOperation;

/** SHA-256 over canonical operation data, represented as lowercase hex. */
export function fingerprintOperation(operation: unknown, bindingCredentials?: unknown): string {
  return createHash('sha256')
    .update(canonicalizeOperation(operation, bindingCredentials), 'utf8')
    .digest('hex');
}

export const operationFingerprint = fingerprintOperation;
export const canonicalOperationFingerprint = fingerprintOperation;
export const getOperationFingerprint = fingerprintOperation;
export const computeOperationFingerprint = fingerprintOperation;

export interface DedupeStoreClock {
  readonly now: () => number;
  readonly setTimeout?: DedupeSetTimeout;
  readonly clearTimeout?: DedupeClearTimeout;
}

export type DedupeSetTimeout = (callback: () => void, delayMs: number) => unknown;
export type DedupeClearTimeout = (handle: unknown) => void;

export interface DedupeStoreOptions {
  /** A monotonic test clock may be supplied; Date.now() is used by default. */
  readonly now?: () => number;
  readonly clock?: (() => number) | DedupeStoreClock;
  readonly setTimeout?: DedupeSetTimeout;
  readonly clearTimeout?: DedupeClearTimeout;
  readonly timer?: {
    readonly setTimeout?: DedupeSetTimeout;
    readonly clearTimeout?: DedupeClearTimeout;
  };
  /** Defaults to the protocol's ten-minute grace period. */
  readonly retentionGraceMs?: number;
  /** Used only for malformed test inputs that omit expiresAt. */
  readonly defaultTtlMs?: number;
  /** Informational owner identity; it is not part of the composite key. */
  readonly runtimeId?: string;
}

export interface DedupeReservation {
  readonly kind: 'reservation';
  readonly key: DedupeKey;
  readonly senderRuntimeId: string;
  readonly operationId: string;
  readonly operation: DedupeOperationName;
  readonly fingerprint: string;
  readonly retainedUntil: number;
}

export type DedupeDecisionKind =
  'new' | 'replay' | 'duplicate' | 'pending' | 'ignored' | 'busy' | 'stored' | 'expired';

export type DedupeDecisionStatus = DedupeDecisionKind;

export interface DedupeRecord<Outcome = unknown, TaskReference = unknown> {
  readonly key: DedupeKey;
  readonly senderRuntimeId: string;
  readonly operationId: string;
  readonly operation: DedupeOperationName;
  readonly fingerprint: string;
  readonly expiresAt: string | number;
  readonly retainedUntil: number;
  readonly pending: boolean;
  readonly result?: Outcome;
  readonly taskReference?: TaskReference;
}

export interface DedupeDecision<Outcome = unknown, TaskReference = unknown> {
  readonly kind: DedupeDecisionKind;
  readonly status: DedupeDecisionStatus;
  readonly action: 'execute' | 'replay' | 'reject' | 'retry' | 'ignore' | 'stored';
  readonly key?: DedupeKey;
  readonly senderRuntimeId?: string;
  readonly operationId?: string;
  readonly operation?: DedupeOperationName;
  readonly fingerprint?: string;
  readonly result?: Outcome;
  readonly taskReference?: TaskReference;
  readonly record?: DedupeRecord<Outcome, TaskReference>;
  readonly reservation?: DedupeReservation;
  readonly error?: ProtocolError;
  readonly retryable?: boolean;
  readonly reserved?: true;
}

export type DedupeResult<Outcome = unknown, TaskReference = unknown> = DedupeDecision<
  Outcome,
  TaskReference
>;
export type DeduplicationDecision<Outcome = unknown, TaskReference = unknown> = DedupeDecision<
  Outcome,
  TaskReference
>;

interface NormalizedOperation {
  readonly operation: DedupeOperationName;
  readonly operationId: string;
  readonly senderRuntimeId: string;
  readonly expiresAt: string | number;
  readonly expiresAtMs: number;
  readonly retainedUntil: number;
  readonly key: DedupeKey;
  readonly fingerprint: string;
}

interface StoredRecord<Outcome, TaskReference> extends NormalizedOperation {
  pending: boolean;
  hasResult: boolean;
  result?: Outcome;
  hasTaskReference: boolean;
  taskReference?: TaskReference;
  timer?: unknown;
}

const MAX_TIMER_DELAY_MS = 2_147_483_647;

function defaultSetTimeout(callback: () => void, delayMs: number): unknown {
  const handle = globalThis.setTimeout(callback, delayMs);
  const unref = (handle as unknown as { unref?: () => void }).unref;
  unref?.call(handle);
  return handle;
}

function defaultClearTimeout(handle: unknown): void {
  globalThis.clearTimeout(handle as Parameters<typeof globalThis.clearTimeout>[0]);
}

function cloneValue<T>(value: T): T {
  if (value === null || value === undefined || typeof value !== 'object') {
    return value;
  }

  try {
    return structuredClone(value);
  } catch {
    // Protocol outcomes and task references are JSON values.  Returning the
    // original is a safe fallback for a caller-provided opaque reference.
    return value;
  }
}

function operationObject(operation: unknown): Record<string, unknown> {
  if (!isRecord(operation)) {
    throw new TypeError('deduplication operation must be an object');
  }
  return operation;
}

function operationName(operation: unknown): string | undefined {
  if (!isRecord(operation) || typeof operation.operation !== 'string') {
    return undefined;
  }
  return operation.operation;
}

function normalizedExpiry(
  rawExpiry: unknown,
  nowMs: number,
  defaultTtlMs: number,
): { value: string | number; milliseconds: number } {
  if (rawExpiry === undefined) {
    return { value: nowMs + defaultTtlMs, milliseconds: nowMs + defaultTtlMs };
  }

  if (rawExpiry instanceof Date) {
    const milliseconds = rawExpiry.getTime();
    if (!Number.isFinite(milliseconds)) {
      throw new TypeError('expiresAt must be a valid timestamp');
    }
    return { value: milliseconds, milliseconds };
  }

  if (typeof rawExpiry === 'number') {
    if (!Number.isFinite(rawExpiry)) {
      throw new TypeError('expiresAt must be a finite timestamp');
    }
    return { value: rawExpiry, milliseconds: rawExpiry };
  }

  if (typeof rawExpiry === 'string' && rawExpiry.length > 0) {
    const milliseconds = Date.parse(rawExpiry);
    if (!Number.isFinite(milliseconds)) {
      throw new TypeError('expiresAt must be a valid timestamp');
    }
    return { value: rawExpiry, milliseconds };
  }

  throw new TypeError('expiresAt must be an RFC 3339 timestamp or millisecond deadline');
}

function normalizedOperation(
  operation: DedupeOperation,
  nowMs: number,
  defaultTtlMs: number,
  retentionGraceMs: number,
): NormalizedOperation {
  const object = operationObject(operation);
  const rawOperation = object.operation;
  if (!isDedupeOperation(rawOperation)) {
    throw new TypeError(`operation ${String(rawOperation)} is not deduplicated`);
  }

  const rawOperationId = object.operationId;
  if (typeof rawOperationId !== 'string' || rawOperationId.length === 0) {
    throw new TypeError('operationId must be a non-empty string');
  }

  const directRuntimeId = object.senderRuntimeId;
  const sender = object.sender;
  const nestedRuntimeId = isRecord(sender) ? sender.runtimeId : undefined;
  const senderRuntimeId =
    typeof directRuntimeId === 'string'
      ? directRuntimeId
      : typeof nestedRuntimeId === 'string'
        ? nestedRuntimeId
        : undefined;

  if (senderRuntimeId === undefined || senderRuntimeId.length === 0) {
    throw new TypeError('senderRuntimeId is required for deduplication');
  }
  if (
    typeof directRuntimeId === 'string' &&
    typeof nestedRuntimeId === 'string' &&
    directRuntimeId !== nestedRuntimeId
  ) {
    throw new TypeError('senderRuntimeId does not match sender.runtimeId');
  }

  const expiry = normalizedExpiry(object.expiresAt, nowMs, defaultTtlMs);
  const key = makeDedupeKey(senderRuntimeId, rawOperationId);
  const fingerprint = fingerprintOperation(operation);

  // Validate the grace-period arithmetic once at the boundary so retention
  // cannot silently wrap or create an unbounded record.
  const retainedUntil = expiry.milliseconds + retentionGraceMs;
  if (!Number.isFinite(retainedUntil)) {
    throw new RangeError('deduplication retention deadline must be finite');
  }

  return {
    operation: rawOperation,
    operationId: rawOperationId,
    senderRuntimeId,
    expiresAt: expiry.value,
    expiresAtMs: expiry.milliseconds,
    retainedUntil,
    key,
    fingerprint,
  };
}

function isBusyResult(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }
  if (value.code === 'busy') {
    return true;
  }
  const error = value.error;
  return isRecord(error) && error.code === 'busy';
}

function duplicateError(senderRuntimeId: string, operationId: string): ProtocolError {
  return createProtocolError('duplicate', 'operationId was reused with different content', {
    details: { senderRuntimeId, operationId },
  });
}

function busyError(): ProtocolError {
  return createProtocolError('busy', 'deduplication admission is temporarily busy');
}

function expiredError(): ProtocolError {
  return createProtocolError('expired', 'deduplication reservation has expired');
}

function ignoredDecision(operation: string | undefined): DedupeDecision {
  return {
    kind: 'ignored',
    status: 'ignored',
    action: 'ignore',
    ...(operation === undefined ? {} : { operation: operation as DedupeOperationName }),
  };
}

/**
 * A small in-memory store owned by exactly one live runtime.  It intentionally
 * exposes reservation/commit separately: queue policy can check capacity first,
 * reserve only after admission, and release without leaving a `busy` tombstone.
 */
export class RuntimeScopedDedupeStore<Outcome = unknown, TaskReference = unknown> {
  public readonly runtimeScoped = true;
  public readonly runtimeId?: string;

  private readonly records = new Map<DedupeKey, StoredRecord<Outcome, TaskReference>>();
  private readonly now: () => number;
  private readonly setTimeout: DedupeSetTimeout;
  private readonly clearTimeout: DedupeClearTimeout;
  private readonly retentionGraceMs: number;
  private readonly defaultTtlMs: number;
  private closed = false;

  public constructor(options: DedupeStoreOptions = {}) {
    const clock = options.clock;
    const configuredNow = options.now ?? (typeof clock === 'function' ? clock : clock?.now);
    this.now = configuredNow ?? Date.now;

    const configuredTimer = options.timer;
    const clockTimer = typeof clock === 'function' ? undefined : clock;
    this.setTimeout =
      options.setTimeout ??
      configuredTimer?.setTimeout ??
      clockTimer?.setTimeout ??
      defaultSetTimeout;
    this.clearTimeout =
      options.clearTimeout ??
      configuredTimer?.clearTimeout ??
      clockTimer?.clearTimeout ??
      defaultClearTimeout;

    this.retentionGraceMs = options.retentionGraceMs ?? DEDUPE_RETENTION_GRACE_MS;
    this.defaultTtlMs = options.defaultTtlMs ?? DEFAULT_REQUEST_TTL_MS;
    this.runtimeId = options.runtimeId;

    if (!Number.isFinite(this.retentionGraceMs) || this.retentionGraceMs < 0) {
      throw new RangeError('retentionGraceMs must be a finite non-negative number');
    }
    if (!Number.isFinite(this.defaultTtlMs) || this.defaultTtlMs <= 0) {
      throw new RangeError('defaultTtlMs must be a finite positive number');
    }
    if (!Number.isFinite(this.now())) {
      throw new RangeError('deduplication clock must return a finite number');
    }
  }

  public get size(): number {
    this.prune();
    return this.records.size;
  }

  public get count(): number {
    return this.size;
  }

  /** Classify an operation without reserving it. */
  public inspect(operation: DedupeOperation): DedupeDecision<Outcome, TaskReference> {
    this.ensureOpen();
    this.prune();

    if (!isDedupeOperation(operationName(operation))) {
      return ignoredDecision(operationName(operation)) as DedupeDecision<Outcome, TaskReference>;
    }

    const normalized = this.normalize(operation);
    const existing = this.records.get(normalized.key);
    if (existing === undefined) {
      return this.newDecision(normalized);
    }
    return this.existingDecision(existing, normalized.fingerprint);
  }

  public check(operation: DedupeOperation): DedupeDecision<Outcome, TaskReference> {
    return this.inspect(operation);
  }

  public classify(operation: DedupeOperation): DedupeDecision<Outcome, TaskReference> {
    return this.inspect(operation);
  }

  /** Return the stored record for a key, regardless of retry fingerprint. */
  public getRecord(operation: DedupeOperation): DedupeRecord<Outcome, TaskReference> | undefined {
    this.ensureOpen();
    this.prune();
    if (!isDedupeOperation(operationName(operation))) {
      return undefined;
    }
    const normalized = this.normalize(operation);
    const record = this.records.get(normalized.key);
    return record === undefined ? undefined : this.snapshot(record);
  }

  public get(operation: DedupeOperation): DedupeRecord<Outcome, TaskReference> | undefined {
    return this.getRecord(operation);
  }

  public find(operation: DedupeOperation): DedupeRecord<Outcome, TaskReference> | undefined {
    return this.getRecord(operation);
  }

  public has(operation: DedupeOperation): boolean {
    return this.getRecord(operation) !== undefined;
  }

  /**
   * Reserve a new operation.  A reservation is not an acknowledgement; commit
   * the admission/delivery result before sending that acknowledgement.
   */
  public reserve(operation: DedupeOperation): DedupeDecision<Outcome, TaskReference> {
    this.ensureOpen();
    this.prune();

    if (!isDedupeOperation(operationName(operation))) {
      return ignoredDecision(operationName(operation)) as DedupeDecision<Outcome, TaskReference>;
    }

    const normalized = this.normalize(operation);
    const existing = this.records.get(normalized.key);
    if (existing !== undefined) {
      return this.existingDecision(existing, normalized.fingerprint);
    }

    const record: StoredRecord<Outcome, TaskReference> = {
      ...normalized,
      pending: true,
      hasResult: false,
      hasTaskReference: false,
    };
    this.records.set(record.key, record);
    this.schedule(record);

    const reservation = this.reservation(record);
    return {
      ...this.newDecision(normalized),
      reservation,
      reserved: true,
    };
  }

  public begin(operation: DedupeOperation): DedupeDecision<Outcome, TaskReference> {
    return this.reserve(operation);
  }

  /**
   * Cache an admission or delivery result.  Calling record directly for a new
   * key performs reserve+commit atomically from this store's perspective.
   */
  public commit(
    target: DedupeOperation | DedupeReservation,
    result?: Outcome,
    taskReference?: TaskReference,
  ): DedupeDecision<Outcome, TaskReference> {
    this.ensureOpen();
    this.prune();
    if (isBusyResult(result)) {
      if (this.isReservation(target)) {
        this.release(target);
        return {
          kind: 'busy',
          status: 'busy',
          action: 'retry',
          key: target.key,
          senderRuntimeId: target.senderRuntimeId,
          operationId: target.operationId,
          operation: target.operation,
          fingerprint: target.fingerprint,
          error: busyError(),
          retryable: true,
        };
      }
      if (!isDedupeOperation(operationName(target))) {
        return ignoredDecision(operationName(target)) as DedupeDecision<Outcome, TaskReference>;
      }
      this.release(target);
      return this.busy(target);
    }

    if (this.isReservation(target)) {
      const record = this.records.get(target.key);
      if (record === undefined) {
        return {
          kind: 'expired',
          status: 'expired',
          action: 'retry',
          key: target.key,
          senderRuntimeId: target.senderRuntimeId,
          operationId: target.operationId,
          operation: target.operation,
          fingerprint: target.fingerprint,
          error: expiredError(),
          retryable: false,
        };
      }
      if (record.fingerprint !== target.fingerprint) {
        return {
          kind: 'duplicate',
          status: 'duplicate',
          action: 'reject',
          key: target.key,
          senderRuntimeId: target.senderRuntimeId,
          operationId: target.operationId,
          operation: target.operation,
          fingerprint: target.fingerprint,
          error: duplicateError(target.senderRuntimeId, target.operationId),
          record: this.snapshot(record),
          retryable: false,
        };
      }
      if (!record.pending) {
        return this.existingDecision(record, target.fingerprint);
      }
      return this.commitRecord(record, result, taskReference);
    }

    if (!isDedupeOperation(operationName(target))) {
      return ignoredDecision(operationName(target)) as DedupeDecision<Outcome, TaskReference>;
    }

    const reservation = this.reserve(target);
    if (reservation.kind !== 'new' || reservation.reservation === undefined) {
      return reservation;
    }
    return this.commit(reservation.reservation, result, taskReference);
  }

  public record(
    operation: DedupeOperation,
    result?: Outcome,
    taskReference?: TaskReference,
  ): DedupeDecision<Outcome, TaskReference> {
    return this.commit(operation, result, taskReference);
  }

  public cache(
    operation: DedupeOperation,
    result?: Outcome,
    taskReference?: TaskReference,
  ): DedupeDecision<Outcome, TaskReference> {
    return this.commit(operation, result, taskReference);
  }

  public put(
    operation: DedupeOperation,
    result?: Outcome,
    taskReference?: TaskReference,
  ): DedupeDecision<Outcome, TaskReference> {
    return this.commit(operation, result, taskReference);
  }

  public setResult(
    operation: DedupeOperation,
    result?: Outcome,
    taskReference?: TaskReference,
  ): DedupeDecision<Outcome, TaskReference> {
    return this.commit(operation, result, taskReference);
  }

  public resolve(
    operation: DedupeOperation,
    result?: Outcome,
    taskReference?: TaskReference,
  ): DedupeDecision<Outcome, TaskReference> {
    return this.commit(operation, result, taskReference);
  }

  public cacheAdmission(
    operation: DedupeOperation,
    result?: Outcome,
    taskReference?: TaskReference,
  ): DedupeDecision<Outcome, TaskReference> {
    return this.commit(operation, result, taskReference);
  }

  public cacheDelivery(
    operation: DedupeOperation,
    result?: Outcome,
    taskReference?: TaskReference,
  ): DedupeDecision<Outcome, TaskReference> {
    return this.commit(operation, result, taskReference);
  }

  /**
   * Reserve or cache an outcome.  A busy outcome is intentionally not stored,
   * allowing the same operation ID to be retried before its deadline.
   */
  public admit(operation: DedupeOperation): DedupeDecision<Outcome, TaskReference>;
  public admit(
    operation: DedupeOperation,
    result: Outcome,
    taskReference?: TaskReference,
  ): DedupeDecision<Outcome, TaskReference>;
  public admit(
    operation: DedupeOperation,
    result?: Outcome,
    taskReference?: TaskReference,
  ): DedupeDecision<Outcome, TaskReference> {
    if (arguments.length === 1) {
      return this.reserve(operation);
    }
    if (isBusyResult(result)) {
      return this.busy(operation);
    }
    return this.commit(operation, result, taskReference);
  }

  /** Execute a producer only for a newly reserved operation. */
  public execute(
    operation: DedupeOperation,
    producer: () => Outcome,
    taskReference?: TaskReference,
  ): DedupeDecision<Outcome, TaskReference> {
    const reservation = this.reserve(operation);
    if (reservation.kind !== 'new' || reservation.reservation === undefined) {
      return reservation;
    }

    try {
      const result = producer();
      if (isBusyResult(result)) {
        this.release(reservation.reservation);
        return this.busy(operation);
      }
      return this.commit(reservation.reservation, result, taskReference);
    } catch (error) {
      this.release(reservation.reservation);
      throw error;
    }
  }

  public run(
    operation: DedupeOperation,
    producer: () => Outcome,
    taskReference?: TaskReference,
  ): DedupeDecision<Outcome, TaskReference> {
    return this.execute(operation, producer, taskReference);
  }

  /**
   * A busy admission is represented only as a response; it never creates a
   * record.  Queue policy may use this helper before calling reserve.
   */
  public busy(operation: DedupeOperation): DedupeDecision<Outcome, TaskReference> {
    this.ensureOpen();
    if (!isDedupeOperation(operationName(operation))) {
      return ignoredDecision(operationName(operation)) as DedupeDecision<Outcome, TaskReference>;
    }
    const normalized = this.normalize(operation);
    return {
      kind: 'busy',
      status: 'busy',
      action: 'retry',
      key: normalized.key,
      senderRuntimeId: normalized.senderRuntimeId,
      operationId: normalized.operationId,
      operation: normalized.operation,
      fingerprint: normalized.fingerprint,
      error: busyError(),
      retryable: true,
    };
  }

  /** Release only a pending reservation; committed outcomes are immutable. */
  public release(target: DedupeOperation | DedupeReservation): boolean {
    this.ensureOpen();
    this.prune();

    let key: DedupeKey;
    let fingerprint: string;
    if (this.isReservation(target)) {
      key = target.key;
      fingerprint = target.fingerprint;
    } else {
      if (!isDedupeOperation(operationName(target))) {
        return false;
      }
      const normalized = this.normalize(target);
      key = normalized.key;
      fingerprint = normalized.fingerprint;
    }

    const record = this.records.get(key);
    if (record === undefined || !record.pending || record.fingerprint !== fingerprint) {
      return false;
    }
    this.removeRecord(record);
    return true;
  }

  public abandon(target: DedupeOperation | DedupeReservation): boolean {
    return this.release(target);
  }

  /** Remove records whose deadline plus grace period has elapsed. */
  public prune(nowMs = this.now()): number {
    if (!Number.isFinite(nowMs)) {
      throw new RangeError('deduplication clock must return a finite number');
    }

    let removed = 0;
    for (const record of this.records.values()) {
      if (record.retainedUntil <= nowMs) {
        this.removeRecord(record);
        removed += 1;
      }
    }
    return removed;
  }

  public cleanup(nowMs = this.now()): number {
    return this.prune(nowMs);
  }

  public clear(): void {
    for (const record of this.records.values()) {
      this.cancelTimer(record);
    }
    this.records.clear();
  }

  public close(): void {
    this.clear();
    this.closed = true;
  }

  public dispose(): void {
    this.close();
  }

  private normalize(operation: DedupeOperation): NormalizedOperation {
    const nowMs = this.now();
    if (!Number.isFinite(nowMs)) {
      throw new RangeError('deduplication clock must return a finite number');
    }
    return normalizedOperation(operation, nowMs, this.defaultTtlMs, this.retentionGraceMs);
  }

  private newDecision(normalized: NormalizedOperation): DedupeDecision<Outcome, TaskReference> {
    return {
      kind: 'new',
      status: 'new',
      action: 'execute',
      key: normalized.key,
      senderRuntimeId: normalized.senderRuntimeId,
      operationId: normalized.operationId,
      operation: normalized.operation,
      fingerprint: normalized.fingerprint,
      retryable: false,
    };
  }

  private existingDecision(
    record: StoredRecord<Outcome, TaskReference>,
    fingerprint: string,
  ): DedupeDecision<Outcome, TaskReference> {
    const base = {
      key: record.key,
      senderRuntimeId: record.senderRuntimeId,
      operationId: record.operationId,
      operation: record.operation,
      fingerprint,
      record: this.snapshot(record),
    };

    if (record.fingerprint !== fingerprint) {
      return {
        ...base,
        kind: 'duplicate',
        status: 'duplicate',
        action: 'reject',
        error: duplicateError(record.senderRuntimeId, record.operationId),
        retryable: false,
      };
    }

    if (record.pending) {
      return {
        ...base,
        kind: 'pending',
        status: 'pending',
        action: 'retry',
        retryable: true,
      };
    }

    const result = record.hasResult ? cloneValue(record.result) : undefined;
    const taskReference = record.hasTaskReference ? cloneValue(record.taskReference) : undefined;
    return {
      ...base,
      kind: 'replay',
      status: 'replay',
      action: 'replay',
      ...(record.hasResult ? { result } : {}),
      ...(record.hasTaskReference ? { taskReference } : {}),
      retryable: false,
    };
  }

  private commitRecord(
    record: StoredRecord<Outcome, TaskReference>,
    result: Outcome | undefined,
    taskReference: TaskReference | undefined,
  ): DedupeDecision<Outcome, TaskReference> {
    record.pending = false;
    record.hasResult = true;
    record.result = cloneValue(result);
    record.hasTaskReference = taskReference !== undefined;
    record.taskReference = cloneValue(taskReference);

    const cachedResult = cloneValue(record.result);
    const cachedTaskReference = record.hasTaskReference
      ? cloneValue(record.taskReference)
      : undefined;
    return {
      kind: 'stored',
      status: 'stored',
      action: 'stored',
      key: record.key,
      senderRuntimeId: record.senderRuntimeId,
      operationId: record.operationId,
      operation: record.operation,
      fingerprint: record.fingerprint,
      ...(record.hasResult ? { result: cachedResult } : {}),
      ...(record.hasTaskReference ? { taskReference: cachedTaskReference } : {}),
      record: this.snapshot(record),
      retryable: false,
    };
  }

  private reservation(record: StoredRecord<Outcome, TaskReference>): DedupeReservation {
    return {
      kind: 'reservation',
      key: record.key,
      senderRuntimeId: record.senderRuntimeId,
      operationId: record.operationId,
      operation: record.operation,
      fingerprint: record.fingerprint,
      retainedUntil: record.retainedUntil,
    };
  }

  private snapshot(
    record: StoredRecord<Outcome, TaskReference>,
  ): DedupeRecord<Outcome, TaskReference> {
    const snapshot: DedupeRecord<Outcome, TaskReference> = {
      key: record.key,
      senderRuntimeId: record.senderRuntimeId,
      operationId: record.operationId,
      operation: record.operation,
      fingerprint: record.fingerprint,
      expiresAt: record.expiresAt,
      retainedUntil: record.retainedUntil,
      pending: record.pending,
      ...(record.hasResult ? { result: cloneValue(record.result) } : {}),
      ...(record.hasTaskReference ? { taskReference: cloneValue(record.taskReference) } : {}),
    };
    return Object.freeze(snapshot);
  }

  private schedule(record: StoredRecord<Outcome, TaskReference>): void {
    const delay = record.retainedUntil - this.now();
    if (delay <= 0) {
      this.removeRecord(record);
      return;
    }

    record.timer = this.setTimeout(
      () => {
        record.timer = undefined;
        if (this.closed || this.records.get(record.key) !== record) {
          return;
        }
        if (record.retainedUntil <= this.now()) {
          this.removeRecord(record);
        } else {
          this.schedule(record);
        }
      },
      Math.min(delay, MAX_TIMER_DELAY_MS),
    );
  }

  private cancelTimer(record: StoredRecord<Outcome, TaskReference>): void {
    if (record.timer !== undefined) {
      this.clearTimeout(record.timer);
      record.timer = undefined;
    }
  }

  private removeRecord(record: StoredRecord<Outcome, TaskReference>): void {
    if (this.records.get(record.key) !== record) {
      return;
    }
    this.cancelTimer(record);
    this.records.delete(record.key);
  }

  private isReservation(value: DedupeOperation | DedupeReservation): value is DedupeReservation {
    return isRecord(value) && value.kind === 'reservation';
  }

  private ensureOpen(): void {
    if (this.closed) {
      throw new Error('deduplication store is closed');
    }
  }
}

/** Compatibility aliases for callers that name the runtime cache directly. */
export const DedupeStore = RuntimeScopedDedupeStore;
export const OperationDedupeStore = RuntimeScopedDedupeStore;
export const RequestDeduplicator = RuntimeScopedDedupeStore;
export const RuntimeDedupeStore = RuntimeScopedDedupeStore;
export const OperationDedupe = RuntimeScopedDedupeStore;

export function createDedupeStore<Outcome = unknown, TaskReference = unknown>(
  options?: DedupeStoreOptions,
): RuntimeScopedDedupeStore<Outcome, TaskReference> {
  return new RuntimeScopedDedupeStore<Outcome, TaskReference>(options);
}

export const createRuntimeDedupeStore = createDedupeStore;
