/**
 * Runtime-local state and lifecycle boundary for Pi-to-Pi.
 *
 * This module is deliberately not a durable database.  Task records,
 * deduplication reservations, operation retry guards, and unreachable results
 * all belong to live runtime boundaries.  Active task/dedupe state is never
 * adopted by a replacement; operation guards are the explicit bounded exception
 * retained through the original deadline plus grace.
 */

import { randomUUID } from 'node:crypto';
import {
  DEFAULT_REQUEST_TTL_MS,
  DEDUPE_RETENTION_GRACE_MS,
  MAX_REQUEST_TTL_MS,
} from '../config.js';

import {
  asRuntimeId,
  asSessionId,
  type OperationId,
  type RuntimeId,
} from '../protocol/messages.js';
import { createProtocolError, type ProtocolError } from '../protocol/errors.js';
import { RuntimeScopedDedupeStore, type DedupeStoreOptions } from '../router/dedupe.js';
import { TaskStore, type TaskOwner, type TaskStoreOptions } from '../router/task-store.js';
import {
  createRuntimeIdentity,
  type RuntimeIdFactory,
  type SessionRuntimeIdentity,
} from '../identity.js';
import { isTerminalTaskState, type TaskSnapshot } from '../protocol/task-state.js';

/** Lifecycle of one runtime-owned state boundary. */
export type RuntimePersistenceState = 'active' | 'shutting_down' | 'closed';
export type RuntimeBoundaryState = RuntimePersistenceState;

/** A best-effort result for a system-generated shutdown signal. */
export type RuntimeShutdownDeliveryStatus = 'delivered' | 'unreachable' | 'skipped';

export interface RuntimeShutdownDelivery {
  readonly status: RuntimeShutdownDeliveryStatus;
  readonly error?: unknown;
}

/**
 * Shutdown hooks receive terminal snapshots collected before the old stores are
 * discarded.  A hook may use the snapshot to send a system-generated reply;
 * it must not hand the snapshot to a replacement runtime.
 */
export interface RuntimeShutdownTask {
  readonly identity: SessionRuntimeIdentity;
  readonly requestId: string;
  readonly owner: TaskOwner;
  readonly previous: TaskSnapshot;
  readonly snapshot: TaskSnapshot;
  readonly delivery: RuntimeShutdownDeliveryStatus;
  readonly deliveryError?: unknown;
}

export interface RuntimeShutdownAttemptFailure {
  readonly status: 'failed';
  readonly error?: unknown;
}

export type RuntimeShutdownHookResult =
  RuntimeShutdownDelivery | RuntimeShutdownDeliveryStatus | RuntimeShutdownAttemptFailure | void;

export type RuntimeShutdownTaskHook = (
  task: Omit<RuntimeShutdownTask, 'delivery' | 'deliveryError'>,
) => RuntimeShutdownHookResult | PromiseLike<RuntimeShutdownHookResult>;
/** Synchronously fences resources owned by this runtime before stores are disposed. */
export type RuntimePersistenceOwnerShutdownHook = () => void;
export interface RuntimeShutdownOptions {
  /** Graceful shutdown attempts system-generated terminal signals. */
  readonly graceful?: boolean;
  readonly reason?: string;
  readonly onTask?: RuntimeShutdownTaskHook;
  /** Overall bounded time allowed for shutdown hook draining. */
  readonly hookTimeoutMs?: number;
  /** Compatibility alias for hookTimeoutMs. */
  readonly shutdownHookTimeoutMs?: number;
  readonly timeoutMs?: number;
  readonly shutdownTimeoutMs?: number;
}

export interface RuntimeShutdownReport {
  readonly identity: SessionRuntimeIdentity;
  readonly graceful: boolean;
  readonly state: 'closed';
  readonly tasks: readonly RuntimeShutdownTask[];
}

export type RuntimePersistenceSetTimeout = (callback: () => void, delayMs: number) => unknown;
export type RuntimePersistenceClearTimeout = (handle: unknown) => void;
export interface RuntimeOperationGuardState {
  /** Keys are the sender runtime generation plus the wire operation ID. */
  readonly acceptedOperations: Map<string, AcceptedOperationRecord>;
  readonly unreachableResults: Map<string, UnreachableRecord>;
}

export interface RuntimeIdentityHistory {
  readonly issued: Map<string, number>;
  readonly retentionMs: number;
}

/** One sender-generation/operation destination state shared by local adapters. */
export interface RuntimeDestinationGuardRecord {
  readonly senderRuntimeId: string;
  readonly operationId: string;
  readonly recipientRuntimeId: string;
  /** Sender runtime ID is the generation fence for this transport-independent guard. */
  readonly generation: string | number;
  readonly retainedUntil: number;
  state: 'pending' | 'delivered' | 'unreachable';
  unreachableMessage?: string;
  timer?: unknown;
  clearTimeout?: RuntimePersistenceClearTimeout;
}

const destinationGuardStates = new WeakMap<
  RuntimeOperationGuardState,
  Map<string, RuntimeDestinationGuardRecord>
>();
export function runtimeOperationGuardKey(senderRuntimeId: string, operationId: string): string {
  return `${senderRuntimeId}\u0000${operationId}`;
}

/** Return the destination state machine associated with one guard state object. */
export function runtimeDestinationGuardStateFor(
  state: RuntimeOperationGuardState,
): Map<string, RuntimeDestinationGuardRecord> {
  const existing = destinationGuardStates.get(state);
  if (existing !== undefined) {
    return existing;
  }
  const created = new Map<string, RuntimeDestinationGuardRecord>();
  destinationGuardStates.set(state, created);
  return created;
}
export interface RuntimePersistenceOptions {
  /** Use an already-created identity, without sharing any state with it. */
  readonly identity?: SessionRuntimeIdentity;
  readonly sessionId?: string;
  readonly runtimeId?: RuntimeId | string;
  readonly runtimeIdFactory?: RuntimeIdFactory;
  readonly taskStoreOptions?: TaskStoreOptions;
  readonly dedupeStoreOptions?: DedupeStoreOptions;
  readonly onShutdownTask?: RuntimeShutdownTaskHook;
  /** Monotonic/epoch clock used for operation guard retention. */
  readonly now?: () => number;
  readonly setTimeout?: RuntimePersistenceSetTimeout;
  readonly clearTimeout?: RuntimePersistenceClearTimeout;
  /** Shared operation guards retained across runtime replacement. */
  readonly operationGuardState?: RuntimeOperationGuardState;
  /** Retention after an operation deadline; defaults to the v1 grace window. */
  readonly retentionGraceMs?: number;
  /** Retain issued runtime identities across the replacement chain. */
  readonly runtimeIdentityHistory?: RuntimeIdentityHistory;
  readonly runtimeIdRetentionMs?: number;
}

/** Options accepted by `reload`/`replacement`; state is never copied. */
export interface RuntimeReloadOptions extends Omit<
  RuntimePersistenceOptions,
  'identity' | 'sessionId' | 'runtimeId'
> {
  readonly identity?: SessionRuntimeIdentity;
  readonly sessionId?: string;
  readonly runtimeId?: RuntimeId | string;
  readonly shutdown?: RuntimeShutdownOptions;
}

export interface AcceptedOperation {
  readonly operationId: string;
  readonly recipientRuntimeId: string;
  /** Sender generation is part of the operation guard identity. */
  readonly senderRuntimeId?: string;
  readonly generation?: string;
}

export interface RuntimeUnreachableResult {
  readonly status: 'unreachable';
  readonly operationId: string;
  readonly error: ProtocolError & { readonly code: 'unreachable' };
  readonly recipientRuntimeId?: string;
  /** Sender generation is part of the operation guard identity. */
  readonly senderRuntimeId?: string;
  readonly generation?: string;
}

/** Error raised when a closed runtime or a stale operation is used. */
export class RuntimePersistenceError extends Error {
  readonly code: 'closed' | 'stale_operation' | 'identity_conflict' | 'busy';
  readonly operationId?: string;
  readonly recipientRuntimeId?: string;

  public constructor(
    code: RuntimePersistenceError['code'],
    message: string,
    options: { readonly operationId?: string; readonly recipientRuntimeId?: string } = {},
  ) {
    super(message);
    this.name = 'RuntimePersistenceError';
    this.code = code;
    this.operationId = options.operationId;
    this.recipientRuntimeId = options.recipientRuntimeId;
  }
}
type RuntimeDeadlineInput = string | number | Date;

export interface AcceptedOperationRecord {
  readonly value: AcceptedOperation;
  readonly senderRuntimeId: string;
  /** Sender runtime ID is also the generation fence for this guard. */
  readonly generation: string;
  readonly retainedUntil: number;
  stale: boolean;
  timer?: unknown;
  clearTimeout?: RuntimePersistenceClearTimeout;
}
export interface UnreachableRecord {
  readonly value: RuntimeUnreachableResult;
  readonly senderRuntimeId: string;
  /** Sender runtime ID is also the generation fence for this guard. */
  readonly generation: string;
  readonly recipientRuntimeId?: string;
  readonly message: string;
  readonly retainedUntil: number;
  timer?: unknown;
  clearTimeout?: RuntimePersistenceClearTimeout;
}

const DEFAULT_SHUTDOWN_HOOK_TIMEOUT_MS = 10_000;
const MAX_TIMER_DELAY_MS = 2_147_483_647;
const MAX_IDENTIFIER_LENGTH = 256;
const MIN_RETENTION_GRACE_MS = DEDUPE_RETENTION_GRACE_MS;
const MAX_RETENTION_GRACE_MS = Number.MAX_SAFE_INTEGER;
const MAX_OPERATION_DEADLINE_HORIZON_MS = MAX_REQUEST_TTL_MS;
export const RUNTIME_ID_GUARD_RETENTION_MS =
  MAX_OPERATION_DEADLINE_HORIZON_MS + MIN_RETENTION_GRACE_MS;
const MAX_OPERATION_GUARD_ENTRIES = 4_096;
const MAX_RUNTIME_ID_HISTORY_ENTRIES = 4_096;
const MAX_SHUTDOWN_HOOKS = 256;
function defaultSetTimeout(callback: () => void, delayMs: number): unknown {
  return globalThis.setTimeout(callback, delayMs);
}

function unrefTimer(handle: unknown): void {
  if ((typeof handle !== 'object' && typeof handle !== 'function') || handle === null) {
    return;
  }
  const unref = (handle as { unref?: () => void }).unref;
  if (typeof unref === 'function') {
    unref.call(handle);
  }
}

function defaultClearTimeout(handle: unknown): void {
  globalThis.clearTimeout(handle as Parameters<typeof globalThis.clearTimeout>[0]);
}

function finiteNow(value: number): number {
  if (!Number.isFinite(value)) {
    throw new RangeError('runtime persistence clock must return a finite number');
  }
  return value;
}

function validateRetentionGrace(value: number | undefined, fallback: number): number {
  const grace = value ?? fallback;
  if (
    !Number.isSafeInteger(grace) ||
    grace < MIN_RETENTION_GRACE_MS ||
    grace > MAX_RETENTION_GRACE_MS
  ) {
    throw new RangeError(
      `retentionGraceMs must be a safe integer between ${MIN_RETENTION_GRACE_MS} and ${MAX_RETENTION_GRACE_MS}`,
    );
  }
  return grace;
}

function validateRuntimeIdRetention(
  value: number | undefined,
  fallback: number,
  minimum = RUNTIME_ID_GUARD_RETENTION_MS,
): number {
  const retention = value ?? fallback;
  if (retention !== Infinity && (!Number.isSafeInteger(retention) || retention < minimum)) {
    throw new RangeError(
      `runtimeIdRetentionMs must be Infinity or a safe integer of at least ${minimum}`,
    );
  }
  return retention;
}

function deadlineMs(
  value: RuntimeDeadlineInput | undefined,
  nowMs: number,
  allowElapsed = false,
): number {
  if (value === undefined) {
    const defaultDeadline = nowMs + DEFAULT_REQUEST_TTL_MS;
    if (!Number.isSafeInteger(defaultDeadline)) {
      throw new RangeError('operation expiry must be a safe timestamp');
    }
    return defaultDeadline;
  }
  let parsed: number;
  if (value instanceof Date) {
    parsed = value.getTime();
  } else if (typeof value === 'number') {
    parsed = value;
  } else {
    parsed = Date.parse(value);
  }
  if (!Number.isSafeInteger(parsed)) {
    throw new TypeError('operation expiry must be a finite safe timestamp');
  }
  if (parsed <= nowMs && !allowElapsed) {
    throw new RangeError('operation expiry is already elapsed');
  }
  if (parsed > nowMs + MAX_OPERATION_DEADLINE_HORIZON_MS) {
    throw new RangeError('operation expiry exceeds the v1 deadline horizon');
  }
  return parsed;
}

function retainedDeadline(
  value: RuntimeDeadlineInput | undefined,
  nowMs: number,
  graceMs: number,
): number {
  const grace = validateRetentionGrace(graceMs, DEDUPE_RETENTION_GRACE_MS);
  const parsedDeadline = value === undefined ? undefined : deadlineMs(value, nowMs, true);
  const deadline =
    parsedDeadline === undefined || parsedDeadline <= nowMs
      ? nowMs + MAX_OPERATION_DEADLINE_HORIZON_MS
      : parsedDeadline;
  if (!Number.isSafeInteger(deadline)) {
    throw new RangeError('operation retention deadline must be a safe timestamp');
  }
  const retainedUntil = deadline + grace;
  if (!Number.isSafeInteger(retainedUntil)) {
    throw new RangeError('operation retention deadline must be a safe timestamp');
  }
  return retainedUntil;
}

export class RuntimeShutdownHookTimeout extends Error {
  public constructor(timeoutMs: number) {
    super(`runtime shutdown hook exceeded its ${timeoutMs}ms deadline`);
    this.name = 'RuntimeShutdownHookTimeout';
  }
}
function requireText(value: string | undefined, field: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MAX_IDENTIFIER_LENGTH ||
    /\p{C}/u.test(value)
  ) {
    throw new TypeError(`${field} must be a bounded non-empty string without control characters`);
  }
  return value;
}

export function createRuntimeOperationGuardState(): RuntimeOperationGuardState {
  return {
    acceptedOperations: new Map<string, AcceptedOperationRecord>(),
    unreachableResults: new Map<string, UnreachableRecord>(),
  };
}

export const sharedRuntimeOperationGuardState: RuntimeOperationGuardState =
  createRuntimeOperationGuardState();

function identityFromOptions(options: RuntimePersistenceOptions): SessionRuntimeIdentity {
  const supplied = options.identity;
  const suppliedSessionId = options.sessionId;
  const suppliedRuntimeId = options.runtimeId;

  if (supplied !== undefined) {
    const sessionId = requireText(supplied.sessionId, 'sessionId');
    const runtimeId = requireText(supplied.runtimeId, 'runtimeId');
    const identity = createRuntimeIdentity(sessionId, () => runtimeId);
    if (suppliedSessionId !== undefined && suppliedSessionId !== identity.sessionId) {
      throw new RuntimePersistenceError(
        'identity_conflict',
        'sessionId does not match the supplied runtime identity',
      );
    }
    if (suppliedRuntimeId !== undefined && suppliedRuntimeId !== identity.runtimeId) {
      throw new RuntimePersistenceError(
        'identity_conflict',
        'runtimeId does not match the supplied runtime identity',
      );
    }
    return identity;
  }

  const sessionId = requireText(suppliedSessionId ?? `session-${randomUUID()}`, 'sessionId');
  if (suppliedRuntimeId !== undefined) {
    return createRuntimeIdentity(sessionId, () => requireText(suppliedRuntimeId, 'runtimeId'));
  }
  return createRuntimeIdentity(sessionId, () => {
    const runtimeId = (options.runtimeIdFactory ?? randomUUID)();
    return requireText(runtimeId, 'runtimeId');
  });
}

function pruneRuntimeIdentityHistory(history: RuntimeIdentityHistory, nowMs: number): void {
  for (const [runtimeId, retainedUntil] of history.issued) {
    if (retainedUntil <= nowMs) {
      history.issued.delete(runtimeId);
    }
  }
}

function assertFreshRuntimeId(
  current: SessionRuntimeIdentity,
  runtimeId: string,
  history: RuntimeIdentityHistory,
): void {
  const normalizedRuntimeId = requireText(runtimeId, 'runtimeId');
  if (normalizedRuntimeId === current.runtimeId || history.issued.has(normalizedRuntimeId)) {
    throw new RuntimePersistenceError(
      'identity_conflict',
      'a replacement runtime must have a fresh runtimeId that has not been issued before',
    );
  }
}

function replacementIdentity(
  current: SessionRuntimeIdentity,
  options: RuntimeReloadOptions,
  history: RuntimeIdentityHistory,
  nowMs: number,
): SessionRuntimeIdentity {
  pruneRuntimeIdentityHistory(history, nowMs);
  const requested = options.identity;
  if (requested !== undefined) {
    const sessionId = requireText(requested.sessionId, 'sessionId');
    const runtimeId = requireText(requested.runtimeId, 'runtimeId');
    assertFreshRuntimeId(current, runtimeId, history);
    if (options.sessionId !== undefined && options.sessionId !== sessionId) {
      throw new RuntimePersistenceError(
        'identity_conflict',
        'sessionId does not match the replacement identity',
      );
    }
    if (options.runtimeId !== undefined && options.runtimeId !== runtimeId) {
      throw new RuntimePersistenceError(
        'identity_conflict',
        'runtimeId does not match the replacement identity',
      );
    }
    return createRuntimeIdentity(sessionId, () => runtimeId);
  }

  const sessionId = requireText(options.sessionId ?? current.sessionId, 'sessionId');
  const runtimeId = requireText(
    options.runtimeId ??
      (options.runtimeIdFactory === undefined ? randomUUID() : options.runtimeIdFactory()),
    'runtimeId',
  );
  assertFreshRuntimeId(current, runtimeId, history);
  return createRuntimeIdentity(sessionId, () => runtimeId);
}

function sameReloadValue(left: unknown, right: unknown, seen = new Map<object, object>()): boolean {
  if (Object.is(left, right)) {
    return true;
  }
  if (typeof left !== 'object' || left === null || typeof right !== 'object' || right === null) {
    return false;
  }
  if (Object.getPrototypeOf(left) !== Object.getPrototypeOf(right)) {
    return false;
  }
  if (left instanceof Map || left instanceof Set) {
    return false;
  }
  const prior = seen.get(left);
  if (prior === right) {
    return true;
  }
  seen.set(left, right);
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
      return false;
    }
    return left.every((value, index) => sameReloadValue(value, right[index], seen));
  }
  const leftKeys = Object.keys(left as Record<string, unknown>).sort();
  const rightKeys = Object.keys(right as Record<string, unknown>).sort();
  if (
    leftKeys.length !== rightKeys.length ||
    leftKeys.some((key, index) => key !== rightKeys[index])
  ) {
    return false;
  }
  return leftKeys.every((key) =>
    sameReloadValue(
      (left as Record<string, unknown>)[key],
      (right as Record<string, unknown>)[key],
      seen,
    ),
  );
}

function reloadOptionsEqual(left: RuntimeReloadOptions, right: RuntimeReloadOptions): boolean {
  return sameReloadValue(left, right);
}

interface RuntimePersistenceLike {
  readonly sessionId: string;
  readonly runtimeId: string;
}
function assertCachedReplacementOptions(
  requested: RuntimeReloadOptions,
  cached: RuntimeReloadOptions,
  replacement: RuntimePersistenceLike,
): void {
  if (
    (requested.identity !== undefined &&
      (requested.identity.sessionId !== replacement.sessionId ||
        requested.identity.runtimeId !== replacement.runtimeId)) ||
    (requested.sessionId !== undefined && requested.sessionId !== replacement.sessionId) ||
    (requested.runtimeId !== undefined && requested.runtimeId !== replacement.runtimeId) ||
    !reloadOptionsEqual(requested, cached)
  ) {
    throw new RuntimePersistenceError(
      'identity_conflict',
      'cached replacement does not match the requested runtime identity or options',
    );
  }
}

function validateReloadOptions(options: RuntimeReloadOptions): void {
  validateShutdownOptions(options.shutdown);
  if (options.retentionGraceMs !== undefined) {
    validateRetentionGrace(options.retentionGraceMs, MIN_RETENTION_GRACE_MS);
  }
  if (options.dedupeStoreOptions?.retentionGraceMs !== undefined) {
    validateRetentionGrace(options.dedupeStoreOptions.retentionGraceMs, MIN_RETENTION_GRACE_MS);
  }
  if (
    options.retentionGraceMs !== undefined &&
    options.dedupeStoreOptions?.retentionGraceMs !== undefined &&
    options.retentionGraceMs !== options.dedupeStoreOptions.retentionGraceMs
  ) {
    throw new RangeError('retentionGraceMs conflicts with dedupeStoreOptions.retentionGraceMs');
  }
  if (options.runtimeIdRetentionMs !== undefined) {
    validateRuntimeIdRetention(options.runtimeIdRetentionMs, RUNTIME_ID_GUARD_RETENTION_MS);
  }
}

function normalizeShutdownDelivery(value: unknown): RuntimeShutdownDelivery {
  if (
    value === 'delivered' ||
    (typeof value === 'object' &&
      value !== null &&
      'status' in value &&
      value.status === 'delivered')
  ) {
    return { status: 'delivered' };
  }
  if (value === 'unreachable') {
    return { status: 'unreachable' };
  }
  if (
    typeof value === 'object' &&
    value !== null &&
    'status' in value &&
    value.status === 'unreachable'
  ) {
    const candidate = value as { readonly error?: unknown };
    return {
      status: 'unreachable',
      ...(candidate.error === undefined ? {} : { error: candidate.error }),
    };
  }
  if (
    typeof value === 'object' &&
    value !== null &&
    'status' in value &&
    value.status === 'failed'
  ) {
    const candidate = value as { readonly error?: unknown };
    return { status: 'unreachable', error: candidate.error };
  }
  return { status: 'skipped' };
}

function shutdownReason(value: string | undefined): string {
  return requireText(value ?? 'runtime is shutting down', 'shutdown reason');
}

function shutdownHookTimeout(options: RuntimeShutdownOptions): number {
  const timeout =
    options.hookTimeoutMs ??
    options.shutdownHookTimeoutMs ??
    options.timeoutMs ??
    options.shutdownTimeoutMs ??
    DEFAULT_SHUTDOWN_HOOK_TIMEOUT_MS;
  if (
    !Number.isSafeInteger(timeout) ||
    timeout <= 0 ||
    timeout > MAX_OPERATION_DEADLINE_HORIZON_MS
  ) {
    throw new RangeError(
      `shutdown hook timeout must be a positive safe integer no greater than ${MAX_OPERATION_DEADLINE_HORIZON_MS}`,
    );
  }
  return timeout;
}

function validateShutdownOptions(options: RuntimeShutdownOptions | undefined): void {
  if (options === undefined) {
    return;
  }
  if (options.graceful !== undefined && typeof options.graceful !== 'boolean') {
    throw new TypeError('shutdown graceful must be a boolean');
  }
  if (options.onTask !== undefined && typeof options.onTask !== 'function') {
    throw new TypeError('shutdown onTask must be a function');
  }
  shutdownReason(options.reason);
  shutdownHookTimeout(options);
}

interface BoundedPromiseOutcome<T> {
  settled: boolean;
  value?: T;
  error?: unknown;
}

async function settlePromisesWithin<T>(
  promises: readonly Promise<T>[],
  timeoutMs: number,
  setTimeoutFn: RuntimePersistenceSetTimeout,
  clearTimeoutFn: RuntimePersistenceClearTimeout,
): Promise<BoundedPromiseOutcome<T>[]> {
  if (promises.length === 0) {
    return [];
  }
  const outcomes: BoundedPromiseOutcome<T>[] = promises.map(() => ({ settled: false }));
  const tracked = promises.map(async (promise, index) => {
    try {
      const value = await promise;
      outcomes[index] = { settled: true, value };
    } catch (error) {
      outcomes[index] = { settled: true, error };
    }
  });
  let timer: unknown;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeoutFn(resolve, timeoutMs);
  });
  try {
    await Promise.race([Promise.all(tracked), timeout]);
  } finally {
    if (timer !== undefined) {
      clearTimeoutFn(timer);
    }
  }
  return outcomes;
}

/**
 * Owns all mutable task/dedupe state for exactly one live runtime.
 *
 * The public replacement operation creates new stores; it never adopts active
 * task or deduplication state.  Shared operation guards remain bounded and
 * survive shutdown until their original deadline plus grace.
 */
export class RuntimePersistence {
  public readonly runtimeScoped = true;
  public readonly identity: SessionRuntimeIdentity;
  public readonly sessionId: SessionRuntimeIdentity['sessionId'];
  public readonly runtimeId: SessionRuntimeIdentity['runtimeId'];
  public readonly taskStore: TaskStore;
  public readonly tasks: TaskStore;
  public readonly dedupeStore: RuntimeScopedDedupeStore;
  public readonly dedupe: RuntimeScopedDedupeStore;

  private lifecycleState: RuntimePersistenceState = 'active';
  private shutdownPromise: Promise<RuntimeShutdownReport> | undefined;
  private replacementRuntime: RuntimePersistence | undefined;
  private readonly onShutdownTask?: RuntimeShutdownTaskHook;
  private readonly now: () => number;
  private readonly setTimeout: RuntimePersistenceSetTimeout;
  private readonly clearTimeout: RuntimePersistenceClearTimeout;
  private readonly retentionGraceMs: number;
  public readonly runtimeIdentityHistory: RuntimeIdentityHistory;
  public readonly operationGuardState: RuntimeOperationGuardState;
  private readonly acceptedOperations: Map<string, AcceptedOperationRecord>;
  private readonly unreachableResults: Map<string, UnreachableRecord>;
  private readonly shutdownHooks = new Set<Promise<unknown>>();
  private readonly ownerShutdownHooks = new Set<RuntimePersistenceOwnerShutdownHook>();
  private replacementOptions: RuntimeReloadOptions | undefined;
  private previousRuntimeShutdownPromise: Promise<RuntimeShutdownReport> | undefined;
  private previousRuntimeShutdownFailure: unknown;
  public constructor(options: RuntimePersistenceOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    this.setTimeout = options.setTimeout ?? defaultSetTimeout;
    this.clearTimeout = options.clearTimeout ?? defaultClearTimeout;
    const configuredGrace = options.retentionGraceMs;
    const dedupeConfiguredGrace = options.dedupeStoreOptions?.retentionGraceMs;
    if (
      configuredGrace !== undefined &&
      dedupeConfiguredGrace !== undefined &&
      configuredGrace !== dedupeConfiguredGrace
    ) {
      throw new RuntimePersistenceError(
        'identity_conflict',
        'retentionGraceMs conflicts with dedupeStoreOptions.retentionGraceMs',
      );
    }
    const effectiveRetentionGrace = validateRetentionGrace(
      configuredGrace ?? dedupeConfiguredGrace,
      MIN_RETENTION_GRACE_MS,
    );
    const requiredRuntimeRetention = MAX_OPERATION_DEADLINE_HORIZON_MS + effectiveRetentionGrace;
    const requestedRuntimeRetention = options.runtimeIdRetentionMs;
    const history =
      options.runtimeIdentityHistory ??
      ({
        issued: new Map<string, number>(),
        retentionMs: requestedRuntimeRetention ?? requiredRuntimeRetention,
      } satisfies RuntimeIdentityHistory);
    const historyRetention = validateRuntimeIdRetention(
      history.retentionMs,
      requiredRuntimeRetention,
      requiredRuntimeRetention,
    );
    if (requestedRuntimeRetention !== undefined && requestedRuntimeRetention !== historyRetention) {
      throw new RuntimePersistenceError(
        'identity_conflict',
        'runtimeIdRetentionMs conflicts with the shared runtime identity history',
      );
    }
    const nowMs = finiteNow(this.now());
    pruneRuntimeIdentityHistory(history, nowMs);
    this.runtimeIdentityHistory = history;
    this.operationGuardState = options.operationGuardState ?? createRuntimeOperationGuardState();
    this.acceptedOperations = this.operationGuardState.acceptedOperations;
    this.unreachableResults = this.operationGuardState.unreachableResults;
    this.identity = identityFromOptions(options);
    if (history.issued.has(this.identity.runtimeId)) {
      throw new RuntimePersistenceError(
        'identity_conflict',
        'runtimeId has already been issued in this runtime replacement chain',
      );
    }
    if (history.issued.size >= MAX_RUNTIME_ID_HISTORY_ENTRIES) {
      throw new RuntimePersistenceError(
        'busy',
        'runtime identity history has reached its bounded capacity',
      );
    }
    this.sessionId = this.identity.sessionId;
    this.runtimeId = this.identity.runtimeId;
    this.onShutdownTask = options.onShutdownTask;
    this.retentionGraceMs = effectiveRetentionGrace;

    const taskOptions = options.taskStoreOptions ?? {};
    if (
      taskOptions.localOwnerRuntimeId !== undefined &&
      String(taskOptions.localOwnerRuntimeId) !== this.runtimeId
    ) {
      throw new RuntimePersistenceError(
        'identity_conflict',
        'task-store state belongs to another runtime',
      );
    }
    this.taskStore = new TaskStore({
      ...taskOptions,
      localOwnerRuntimeId: this.runtimeId,
    });
    this.tasks = this.taskStore;

    const dedupeOptions = options.dedupeStoreOptions ?? {};
    if (dedupeOptions.runtimeId !== undefined && dedupeOptions.runtimeId !== this.runtimeId) {
      throw new RuntimePersistenceError(
        'identity_conflict',
        'deduplication state belongs to another runtime',
      );
    }
    this.dedupeStore = new RuntimeScopedDedupeStore({
      ...dedupeOptions,
      retentionGraceMs: this.retentionGraceMs,
      runtimeId: this.runtimeId,
    });
    this.dedupe = this.dedupeStore;
    history.issued.set(this.identity.runtimeId, Infinity);
  }

  public get state(): RuntimePersistenceState {
    return this.lifecycleState;
  }

  public get lifecycle(): RuntimePersistenceState {
    return this.lifecycleState;
  }

  public get active(): boolean {
    return this.lifecycleState === 'active';
  }

  public get closed(): boolean {
    return this.lifecycleState === 'closed';
  }
  /** Shutdown result for the old runtime that this boundary replaced. */
  public get previousRuntimeShutdown(): Promise<RuntimeShutdownReport> | undefined {
    return this.previousRuntimeShutdownPromise;
  }
  /** Rejection captured from a failed old-runtime shutdown, if any. */
  public get previousRuntimeShutdownError(): unknown {
    return this.previousRuntimeShutdownFailure;
  }
  public get operationRetentionGraceMs(): number {
    return this.retentionGraceMs;
  }
  public get clock(): () => number {
    return this.now;
  }
  public get timeoutScheduler(): RuntimePersistenceSetTimeout {
    return this.setTimeout;
  }
  public get timeoutClearer(): RuntimePersistenceClearTimeout {
    return this.clearTimeout;
  }

  public isActive(): boolean {
    return this.active;
  }

  public isClosed(): boolean {
    return this.closed;
  }

  public ownsRuntime(runtimeId: string): boolean {
    return this.runtimeId === runtimeId;
  }

  /** Assert that a caller is still operating on this live runtime generation. */
  public assertActive(): void {
    if (!this.active) {
      throw new RuntimePersistenceError('closed', 'runtime persistence boundary is closed');
    }
  }
  /** Register a resource owner that must be fenced before this runtime shuts down. */
  public registerOwnerShutdownHook(hook: RuntimePersistenceOwnerShutdownHook): () => void {
    if (typeof hook !== 'function') {
      throw new TypeError('runtime owner shutdown hook must be a function');
    }
    if (!this.active) {
      hook();
      return () => undefined;
    }
    if (this.ownerShutdownHooks.size >= MAX_SHUTDOWN_HOOKS) {
      throw new RuntimePersistenceError(
        'busy',
        'runtime owner shutdown hook capacity is temporarily exhausted',
      );
    }
    this.ownerShutdownHooks.add(hook);
    let registered = true;
    return () => {
      if (!registered) {
        return;
      }
      registered = false;
      this.ownerShutdownHooks.delete(hook);
    };
  }

  /**
   * Record that an operation was delivered/accepted for one destination. A
   * later attempt to send that sender-generation/operation key elsewhere is refused.
   */
  public recordAcceptedOperation(
    operationId: string,
    recipientRuntimeId: string,
    expiresAt?: RuntimeDeadlineInput,
    senderRuntimeId?: string,
  ): AcceptedOperation {
    this.assertActive();
    const normalizedOperationId = requireText(operationId, 'operationId');
    const normalizedRecipient = requireText(recipientRuntimeId, 'recipientRuntimeId');
    const normalizedSender = requireText(senderRuntimeId ?? this.runtimeId, 'senderRuntimeId');
    const key = runtimeOperationGuardKey(normalizedSender, normalizedOperationId);
    const nowMs = finiteNow(this.now());
    this.prune(nowMs);
    const previousUnreachable = this.unreachableResults.get(key);
    if (previousUnreachable !== undefined) {
      if (previousUnreachable.recipientRuntimeId !== normalizedRecipient) {
        throw new RuntimePersistenceError(
          'identity_conflict',
          'operationId is already bound to an unreachable destination',
          { operationId: normalizedOperationId, recipientRuntimeId: normalizedRecipient },
        );
      }
      throw new RuntimePersistenceError(
        'stale_operation',
        'an unreachable operation result is immutable; create a new operationId',
        { operationId: normalizedOperationId, recipientRuntimeId: normalizedRecipient },
      );
    }
    const previous = this.acceptedOperations.get(key);
    if (previous !== undefined) {
      if (previous.stale || previous.value.recipientRuntimeId !== normalizedRecipient) {
        // Once a caller has tried to move an accepted ID to a replacement,
        // neither the old nor the replacement endpoint may reuse it.
        previous.stale = true;
        throw new RuntimePersistenceError(
          'stale_operation',
          'an accepted operation cannot be replayed at a replacement runtime; create a new operationId',
          { operationId: normalizedOperationId, recipientRuntimeId: normalizedRecipient },
        );
      }
      return previous.value;
    }
    const requestedRetainedUntil =
      expiresAt === undefined
        ? undefined
        : retainedDeadline(expiresAt, nowMs, this.retentionGraceMs);
    if (this.acceptedOperations.size >= MAX_OPERATION_GUARD_ENTRIES) {
      throw new RuntimePersistenceError(
        'busy',
        'operation guard capacity is temporarily exhausted',
        { operationId: normalizedOperationId, recipientRuntimeId: normalizedRecipient },
      );
    }
    const retainedUntil =
      requestedRetainedUntil ?? retainedDeadline(undefined, nowMs, this.retentionGraceMs);
    const accepted = Object.freeze({
      operationId: normalizedOperationId,
      recipientRuntimeId: normalizedRecipient,
      senderRuntimeId: normalizedSender,
      generation: normalizedSender,
    });
    const record: AcceptedOperationRecord = {
      value: accepted,
      senderRuntimeId: normalizedSender,
      generation: normalizedSender,
      retainedUntil,
      stale: false,
    };
    this.acceptedOperations.set(key, record);
    this.scheduleAcceptedOperation(key, record);
    return accepted;
  }

  public rememberAcceptedOperation(
    operationId: string,
    recipientRuntimeId: string,
    expiresAt?: RuntimeDeadlineInput,
    senderRuntimeId?: string,
  ): AcceptedOperation {
    return this.recordAcceptedOperation(
      operationId,
      recipientRuntimeId,
      expiresAt,
      senderRuntimeId,
    );
  }

  public canReplayOperation(
    operationId: string,
    recipientRuntimeId: string,
    senderRuntimeId?: string,
  ): boolean {
    if (!this.active) {
      return false;
    }
    let normalizedOperationId: string;
    let normalizedRecipient: string;
    let normalizedSender: string;
    try {
      normalizedOperationId = requireText(operationId, 'operationId');
      normalizedRecipient = requireText(recipientRuntimeId, 'recipientRuntimeId');
      normalizedSender = requireText(senderRuntimeId ?? this.runtimeId, 'senderRuntimeId');
      this.prune(finiteNow(this.now()));
    } catch {
      return false;
    }
    const key = runtimeOperationGuardKey(normalizedSender, normalizedOperationId);
    const previous = this.acceptedOperations.get(key);
    const unreachable = this.unreachableResults.get(key);
    if (previous !== undefined && previous.value.recipientRuntimeId !== normalizedRecipient) {
      previous.stale = true;
    }
    return (
      unreachable === undefined &&
      (previous === undefined ||
        (!previous.stale && previous.value.recipientRuntimeId === normalizedRecipient))
    );
  }

  public assertReplayAllowed(
    operationId: string,
    recipientRuntimeId: string,
    senderRuntimeId?: string,
  ): void {
    this.assertActive();
    const normalizedOperationId = requireText(operationId, 'operationId');
    const normalizedRecipient = requireText(recipientRuntimeId, 'recipientRuntimeId');
    const normalizedSender = requireText(senderRuntimeId ?? this.runtimeId, 'senderRuntimeId');
    if (!this.canReplayOperation(normalizedOperationId, normalizedRecipient, normalizedSender)) {
      throw new RuntimePersistenceError(
        'stale_operation',
        'operationId belongs to an earlier runtime endpoint; create a new operationId',
        { operationId: normalizedOperationId, recipientRuntimeId: normalizedRecipient },
      );
    }
  }

  public assertOperationReplaySafe(
    operationId: string,
    recipientRuntimeId: string,
    senderRuntimeId?: string,
  ): void {
    this.assertReplayAllowed(operationId, recipientRuntimeId, senderRuntimeId);
  }

  /** Always returns a fresh UUIDv4 for a retry after a runtime replacement. */
  public createRetryOperationId(
    operationId: string,
    recipientRuntimeId: string,
    senderRuntimeId?: string,
  ): OperationId {
    this.assertActive();
    const normalizedOperationId = requireText(operationId, 'operationId');
    const normalizedRecipient = requireText(recipientRuntimeId, 'recipientRuntimeId');
    const normalizedSender = requireText(senderRuntimeId ?? this.runtimeId, 'senderRuntimeId');
    this.prune(finiteNow(this.now()));
    const previous = this.acceptedOperations.get(
      runtimeOperationGuardKey(normalizedSender, normalizedOperationId),
    );
    if (previous !== undefined && previous.value.recipientRuntimeId !== normalizedRecipient) {
      previous.stale = true;
    }
    return randomUUID() as OperationId;
  }

  public newOperationIdForRetry(
    operationId: string,
    recipientRuntimeId: string,
    senderRuntimeId?: string,
  ): OperationId {
    return this.createRetryOperationId(operationId, recipientRuntimeId, senderRuntimeId);
  }

  /** Convert a lost local delivery into a protocol-shaped result. */
  public reportUnreachable(
    operationId: string,
    recipientRuntimeId?: string,
    message = 'delivery could not be established with the runtime endpoint',
    expiresAt?: RuntimeDeadlineInput,
    senderRuntimeId?: string,
  ): RuntimeUnreachableResult {
    this.assertActive();
    const normalizedOperationId = requireText(operationId, 'operationId');
    const normalizedRecipient =
      recipientRuntimeId === undefined
        ? undefined
        : requireText(recipientRuntimeId, 'recipientRuntimeId');
    const normalizedSender = requireText(senderRuntimeId ?? this.runtimeId, 'senderRuntimeId');
    const normalizedMessage = requireText(message, 'message');
    const key = runtimeOperationGuardKey(normalizedSender, normalizedOperationId);
    const nowMs = finiteNow(this.now());
    this.prune(nowMs);
    const accepted = this.acceptedOperations.get(key);
    const previous = this.unreachableResults.get(key);
    const acceptedRecipient = accepted?.value.recipientRuntimeId;
    const effectiveRecipient = normalizedRecipient ?? acceptedRecipient;
    if (previous !== undefined) {
      if (previous.recipientRuntimeId !== effectiveRecipient) {
        throw new RuntimePersistenceError(
          'identity_conflict',
          'an unreachable result belongs to a different destination',
          { operationId: normalizedOperationId, recipientRuntimeId: normalizedRecipient },
        );
      }
      // Terminal delivery is immutable: a retry with the same destination
      // replays the first result even when its message or deadline differs.
      return previous.value;
    }
    if (accepted !== undefined && acceptedRecipient !== effectiveRecipient) {
      throw new RuntimePersistenceError(
        'identity_conflict',
        'unreachable result does not belong to the accepted destination',
        { operationId: normalizedOperationId, recipientRuntimeId: normalizedRecipient },
      );
    }
    // Once an accepted operation exists, its retained deadline is authoritative
    // and may be used even when the caller's original deadline has elapsed.
    const requestedRetainedUntil =
      accepted === undefined && expiresAt !== undefined
        ? retainedDeadline(expiresAt, nowMs, this.retentionGraceMs)
        : undefined;
    if (this.unreachableResults.size >= MAX_OPERATION_GUARD_ENTRIES) {
      throw new RuntimePersistenceError(
        'busy',
        'unreachable-result guard capacity is temporarily exhausted',
        { operationId: normalizedOperationId, recipientRuntimeId: effectiveRecipient },
      );
    }
    const error = createProtocolError('unreachable', normalizedMessage, {
      details:
        effectiveRecipient === undefined ? undefined : { recipientRuntimeId: effectiveRecipient },
    });
    const result: RuntimeUnreachableResult = Object.freeze({
      status: 'unreachable',
      operationId: normalizedOperationId,
      error: error as ProtocolError & { readonly code: 'unreachable' },
      ...(effectiveRecipient === undefined ? {} : { recipientRuntimeId: effectiveRecipient }),
      senderRuntimeId: normalizedSender,
      generation: normalizedSender,
    });
    const retainedUntil =
      accepted?.retainedUntil ??
      requestedRetainedUntil ??
      retainedDeadline(undefined, nowMs, this.retentionGraceMs);
    const record: UnreachableRecord = {
      value: result,
      senderRuntimeId: normalizedSender,
      generation: normalizedSender,
      recipientRuntimeId: effectiveRecipient,
      message: normalizedMessage,
      retainedUntil,
    };
    this.unreachableResults.set(key, record);
    this.scheduleUnreachableResult(key, record);
    return result;
  }

  public markUnreachable(
    operationId: string,
    recipientRuntimeId?: string,
    message?: string,
    expiresAt?: RuntimeDeadlineInput,
    senderRuntimeId?: string,
  ): RuntimeUnreachableResult {
    return this.reportUnreachable(
      operationId,
      recipientRuntimeId,
      message,
      expiresAt,
      senderRuntimeId,
    );
  }

  public getUnreachable(
    operationId: string,
    senderRuntimeId?: string,
  ): RuntimeUnreachableResult | undefined {
    this.assertActive();
    const normalizedOperationId = requireText(operationId, 'operationId');
    const normalizedSender = requireText(senderRuntimeId ?? this.runtimeId, 'senderRuntimeId');
    this.prune(finiteNow(this.now()));
    return this.unreachableResults.get(
      runtimeOperationGuardKey(normalizedSender, normalizedOperationId),
    )?.value;
  }

  /** Prune expired operation guards and unreachable observations. */
  public cleanup(nowMs = finiteNow(this.now())): number {
    return this.prune(nowMs);
  }

  public prune(nowMs = finiteNow(this.now())): number {
    if (!Number.isFinite(nowMs)) {
      throw new RangeError('runtime persistence clock must return a finite number');
    }
    let removed = 0;
    for (const [operationKey, record] of this.acceptedOperations) {
      if (record.retainedUntil <= nowMs) {
        this.removeAcceptedOperation(operationKey, record);
        removed += 1;
      }
    }
    for (const [operationKey, record] of this.unreachableResults) {
      if (record.retainedUntil <= nowMs) {
        this.removeUnreachableResult(operationKey, record);
        removed += 1;
      }
    }
    return removed;
  }

  public unreachable(
    operationId: string,
    recipientRuntimeId?: string,
    expiresAt?: RuntimeDeadlineInput,
    senderRuntimeId?: string,
  ): RuntimeUnreachableResult {
    return this.reportUnreachable(
      operationId,
      recipientRuntimeId,
      undefined,
      expiresAt,
      senderRuntimeId,
    );
  }

  /**
   * Start graceful shutdown.  State is terminalized and both stores are
   * disposed synchronously before callbacks are awaited, so a replacement
   * cannot observe or adopt the old state.
   */
  public shutdown(options: RuntimeShutdownOptions = {}): Promise<RuntimeShutdownReport> {
    if (this.shutdownPromise !== undefined) {
      return this.shutdownPromise;
    }
    validateShutdownOptions(options);
    const graceful = options.graceful ?? true;
    const reason = shutdownReason(options.reason);
    const hookTimeoutMs = shutdownHookTimeout(options);
    let resolveShutdown!: (report: RuntimeShutdownReport) => void;
    let rejectShutdown!: (error: unknown) => void;
    const shutdownPromise = new Promise<RuntimeShutdownReport>((resolve, reject) => {
      resolveShutdown = resolve;
      rejectShutdown = reject;
    });

    // Publish the latch before terminalization/disposal.  Task-store observers,
    // abort listeners, and shutdown hooks can all re-enter this boundary.
    this.shutdownPromise = shutdownPromise;
    this.lifecycleState = 'shutting_down';
    this.notifyOwnerShutdownHooks();

    let tasks: RuntimeShutdownTask[] = [];
    try {
      tasks = graceful ? this.terminalizeTasks(reason) : [];

      // Disposal is deliberately before asynchronous hooks.  A callback may
      // attempt best-effort delivery, but it can never mutate this old runtime.
      this.taskStore.dispose();
      this.dedupeStore.close();
      // Operation guards intentionally outlive this runtime through deadline + grace.
      this.lifecycleState = 'closed';
    } catch (error) {
      try {
        this.taskStore.dispose();
        this.dedupeStore.close();
        // Operation guards intentionally outlive this runtime through deadline + grace.
      } finally {
        this.lifecycleState = 'closed';
      }
      rejectShutdown(error);
      return shutdownPromise;
    }

    const hook = options.onTask ?? this.onShutdownTask;
    void this.finishShutdown(tasks, graceful, hook, hookTimeoutMs).then(
      resolveShutdown,
      rejectShutdown,
    );
    return shutdownPromise;
  }

  public close(options: RuntimeShutdownOptions = {}): Promise<RuntimeShutdownReport> {
    return this.shutdown(options);
  }

  public dispose(options: RuntimeShutdownOptions = {}): Promise<RuntimeShutdownReport> {
    return this.shutdown(options);
  }

  public stop(options: RuntimeShutdownOptions = {}): Promise<RuntimeShutdownReport> {
    return this.shutdown(options);
  }
  /**
   * Replace this runtime with a fresh state boundary.  The old shutdown is
   * initiated without awaiting it because all mutable state is already cleared
   * synchronously by `shutdown`.
   */
  public reload(options: RuntimeReloadOptions = {}): RuntimePersistence {
    validateReloadOptions(options);
    if (this.replacementRuntime !== undefined && this.replacementOptions !== undefined) {
      assertCachedReplacementOptions(options, this.replacementOptions, this.replacementRuntime);
      return this.replacementRuntime;
    }
    if (
      options.runtimeIdentityHistory !== undefined &&
      options.runtimeIdentityHistory !== this.runtimeIdentityHistory
    ) {
      throw new RuntimePersistenceError(
        'identity_conflict',
        'replacement must share the existing runtime identity history',
      );
    }
    if (
      options.operationGuardState !== undefined &&
      options.operationGuardState !== this.operationGuardState
    ) {
      throw new RuntimePersistenceError(
        'identity_conflict',
        'replacement must share the existing operation guard state',
      );
    }
    if (
      options.runtimeIdRetentionMs !== undefined &&
      options.runtimeIdRetentionMs !== this.runtimeIdentityHistory.retentionMs
    ) {
      throw new RuntimePersistenceError(
        'identity_conflict',
        'runtimeIdRetentionMs cannot change within a replacement chain',
      );
    }
    if (options.now !== undefined && options.now !== this.now) {
      throw new RuntimePersistenceError(
        'identity_conflict',
        'replacement must share the persistence clock',
      );
    }
    if (options.setTimeout !== undefined && options.setTimeout !== this.setTimeout) {
      throw new RuntimePersistenceError(
        'identity_conflict',
        'replacement must share the persistence timer scheduler',
      );
    }
    if (options.clearTimeout !== undefined && options.clearTimeout !== this.clearTimeout) {
      throw new RuntimePersistenceError(
        'identity_conflict',
        'replacement must share the persistence timer clearer',
      );
    }
    if (
      (options.retentionGraceMs !== undefined &&
        options.retentionGraceMs !== this.retentionGraceMs) ||
      (options.dedupeStoreOptions?.retentionGraceMs !== undefined &&
        options.dedupeStoreOptions.retentionGraceMs !== this.retentionGraceMs)
    ) {
      throw new RuntimePersistenceError(
        'identity_conflict',
        'replacement must share the operation retention grace',
      );
    }
    const nowMs = finiteNow(this.now());
    const identity = replacementIdentity(
      this.identity,
      options,
      this.runtimeIdentityHistory,
      nowMs,
    );
    const replacement = new RuntimePersistence({
      identity,
      runtimeIdFactory: options.runtimeIdFactory,
      taskStoreOptions: options.taskStoreOptions,
      dedupeStoreOptions: options.dedupeStoreOptions,
      onShutdownTask: options.onShutdownTask,
      now: this.now,
      setTimeout: this.setTimeout,
      clearTimeout: this.clearTimeout,
      retentionGraceMs: this.retentionGraceMs,
      runtimeIdRetentionMs: this.runtimeIdentityHistory.retentionMs,
      runtimeIdentityHistory: this.runtimeIdentityHistory,
      operationGuardState: this.operationGuardState,
    });
    const previousRuntimeRetainedUntil = this.runtimeIdentityHistory.issued.get(this.runtimeId);
    this.runtimeIdentityHistory.issued.set(
      this.runtimeId,
      nowMs + this.runtimeIdentityHistory.retentionMs,
    );
    // Publish only after every replacement option and constructor check succeeds.
    this.replacementRuntime = replacement;
    this.replacementOptions = options;
    try {
      const shutdownPromise = this.shutdown(options.shutdown);
      replacement.previousRuntimeShutdownPromise = shutdownPromise;
      // Observe the rejection without erasing it: callers can await the exposed
      // lifecycle result, while the replacement records the failure explicitly.
      void shutdownPromise.catch((error: unknown) => {
        replacement.previousRuntimeShutdownFailure = error;
      });
    } catch (error) {
      this.replacementRuntime = undefined;
      this.replacementOptions = undefined;
      this.runtimeIdentityHistory.issued.delete(replacement.runtimeId);
      this.runtimeIdentityHistory.issued.set(
        this.runtimeId,
        previousRuntimeRetainedUntil ?? Infinity,
      );
      throw error;
    }
    return replacement;
  }

  public replacement(options: RuntimeReloadOptions = {}): RuntimePersistence {
    return this.reload(options);
  }

  public replace(options: RuntimeReloadOptions = {}): RuntimePersistence {
    return this.reload(options);
  }

  private scheduleAcceptedOperation(operationId: string, record: AcceptedOperationRecord): void {
    const delay = record.retainedUntil - finiteNow(this.now());
    if (delay <= 0) {
      this.removeAcceptedOperation(operationId, record);
      return;
    }
    record.clearTimeout = this.clearTimeout;
    record.timer = this.setTimeout(
      () => {
        record.timer = undefined;
        if (this.acceptedOperations.get(operationId) !== record) {
          return;
        }
        if (record.retainedUntil <= finiteNow(this.now())) {
          this.removeAcceptedOperation(operationId, record);
        } else {
          this.scheduleAcceptedOperation(operationId, record);
        }
      },
      Math.min(delay, MAX_TIMER_DELAY_MS),
    );
    unrefTimer(record.timer);
  }

  private scheduleUnreachableResult(operationId: string, record: UnreachableRecord): void {
    const delay = record.retainedUntil - finiteNow(this.now());
    if (delay <= 0) {
      this.removeUnreachableResult(operationId, record);
      return;
    }
    record.clearTimeout = this.clearTimeout;
    record.timer = this.setTimeout(
      () => {
        record.timer = undefined;
        if (this.unreachableResults.get(operationId) !== record) {
          return;
        }
        if (record.retainedUntil <= finiteNow(this.now())) {
          this.removeUnreachableResult(operationId, record);
        } else {
          this.scheduleUnreachableResult(operationId, record);
        }
      },
      Math.min(delay, MAX_TIMER_DELAY_MS),
    );
    unrefTimer(record.timer);
  }

  private removeAcceptedOperation(operationId: string, record: AcceptedOperationRecord): void {
    if (this.acceptedOperations.get(operationId) !== record) {
      return;
    }
    if (record.timer !== undefined) {
      (record.clearTimeout ?? this.clearTimeout)(record.timer);
      record.timer = undefined;
    }
    this.acceptedOperations.delete(operationId);
  }

  private removeUnreachableResult(operationId: string, record: UnreachableRecord): void {
    if (this.unreachableResults.get(operationId) !== record) {
      return;
    }
    if (record.timer !== undefined) {
      (record.clearTimeout ?? this.clearTimeout)(record.timer);
      record.timer = undefined;
    }
    this.unreachableResults.delete(operationId);
  }
  private notifyOwnerShutdownHooks(): void {
    const hooks = [...this.ownerShutdownHooks];
    this.ownerShutdownHooks.clear();
    for (const hook of hooks) {
      try {
        hook();
      } catch {
        // Owner hooks are fences; shutdown remains idempotent even if a fence fails.
      }
    }
  }

  private trackShutdownHook<T>(factory: () => T | PromiseLike<T>): Promise<T> | undefined {
    // Check capacity before creating a promise so an over-capacity hook can
    // never invoke user code or create an unobserved late settlement.
    if (this.shutdownHooks.size >= MAX_SHUTDOWN_HOOKS) {
      return undefined;
    }
    const invocation = Promise.resolve().then(() => factory()) as Promise<T>;
    const tracked = invocation.finally(() => this.shutdownHooks.delete(tracked));
    this.shutdownHooks.add(tracked);
    return tracked;
  }

  private async finishShutdown(
    tasks: readonly RuntimeShutdownTask[],
    graceful: boolean,
    hook: RuntimeShutdownTaskHook | undefined,
    hookTimeoutMs: number,
  ): Promise<RuntimeShutdownReport> {
    const hookPromises = tasks.map((task) => {
      if (hook === undefined) {
        return Promise.resolve<RuntimeShutdownDelivery>({ status: 'skipped' });
      }
      const tracked = this.trackShutdownHook(() => hook(task));
      if (tracked === undefined) {
        return Promise.resolve<RuntimeShutdownDelivery>({
          status: 'unreachable',
          error: new Error('runtime shutdown hook capacity is exhausted'),
        });
      }
      return tracked.then((value) => normalizeShutdownDelivery(value));
    });
    const outcomes = await settlePromisesWithin(
      hookPromises,
      hookTimeoutMs,
      this.setTimeout,
      this.clearTimeout,
    );
    if (outcomes.some((outcome) => !outcome.settled)) {
      this.shutdownHooks.clear();
    }
    const completedTasks = tasks.map((task, index) => {
      const outcome = outcomes[index];
      const delivery: RuntimeShutdownDelivery =
        outcome === undefined || !outcome.settled
          ? {
              status: 'unreachable',
              error: new RuntimeShutdownHookTimeout(hookTimeoutMs),
            }
          : outcome.error !== undefined
            ? { status: 'unreachable', error: outcome.error }
            : (outcome.value ?? { status: 'skipped' });
      return Object.freeze({
        ...task,
        delivery: delivery.status,
        ...(delivery.error === undefined ? {} : { deliveryError: delivery.error }),
      });
    });
    return Object.freeze({
      identity: this.identity,
      graceful,
      state: 'closed',
      tasks: Object.freeze(completedTasks),
    });
  }

  private terminalizeTasks(reason: string): RuntimeShutdownTask[] {
    const snapshots = this.taskStore.listSnapshots({ includeTerminalResponse: true });
    const tasks: RuntimeShutdownTask[] = [];
    for (const previous of snapshots) {
      if (isTerminalTaskState(previous.state)) {
        continue;
      }
      const snapshot = this.terminalizeTask(previous, reason);
      if (snapshot === undefined) {
        continue;
      }
      const owner = this.taskStore.getOwner(previous.requestId) ?? {
        runtimeId: this.runtimeId,
      };
      tasks.push(
        Object.freeze({
          identity: this.identity,
          requestId: previous.requestId,
          owner,
          previous,
          snapshot,
          delivery: 'skipped',
        }),
      );
    }
    return tasks;
  }

  private terminalizeTask(previous: TaskSnapshot, reason: string): TaskSnapshot | undefined {
    if (previous.state === 'working') {
      return this.taskStore.failTask(previous.requestId, {
        error: createProtocolError(
          'unreachable',
          `runtime shutdown interrupted active work: ${reason}`,
        ),
      });
    }
    if (previous.state === 'cancelling') {
      return this.taskStore.transition(previous.requestId, 'cancelled', {
        cancellationRequested: true,
        reason,
        error: createProtocolError('cancelled', reason),
      });
    }
    if (previous.state === 'created') {
      return this.taskStore.rejectTask(previous.requestId, {
        error: createProtocolError(
          'unreachable',
          `runtime shutdown prevented admission: ${reason}`,
        ),
      });
    }
    return this.taskStore.cancelTask(previous.requestId, {
      caller: this.runtimeId,
      reason,
    }).snapshot;
  }
}

/** Compatibility aliases for lifecycle and persistence callers. */
export const RuntimeState = RuntimePersistence;
export const RuntimeScopedPersistence = RuntimePersistence;
export const PiRuntimePersistence = RuntimePersistence;
export const RuntimePersistenceBoundary = RuntimePersistence;
export const RuntimeStateBoundary = RuntimePersistence;

export function createRuntimePersistence(
  options: RuntimePersistenceOptions = {},
): RuntimePersistence {
  return new RuntimePersistence(options);
}

export const createRuntimeState = createRuntimePersistence;
export const createRuntimeBoundary = createRuntimePersistence;
export const createRuntimePersistenceBoundary = createRuntimePersistence;

/** A new runtime is intentionally the only supported replacement mechanism. */
export function createReplacementRuntime(
  previous: RuntimePersistence,
  options: RuntimeReloadOptions = {},
): RuntimePersistence {
  return previous.reload(options);
}

/** Narrow helper for callers that receive a generic delivery result. */
export function unreachableFromDelivery(
  persistence: RuntimePersistence,
  operationId: string,
  recipientRuntimeId?: string,
): RuntimeUnreachableResult {
  return persistence.reportUnreachable(operationId, recipientRuntimeId);
}

/** Keep branded identity constructors available from this boundary. */
export { asRuntimeId, asSessionId };
