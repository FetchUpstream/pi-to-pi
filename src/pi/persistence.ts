/**
 * Runtime-local state and lifecycle boundary for Pi-to-Pi.
 *
 * This module is deliberately not a durable database.  Task records,
 * deduplication reservations, operation retry guards, and unreachable results
 * all belong to one live runtime instance.  A replacement must construct a new
 * boundary; it cannot import or adopt any state from the old one.
 */

import { randomUUID } from 'node:crypto';
import { DEFAULT_REQUEST_TTL_MS, DEDUPE_RETENTION_GRACE_MS } from '../config.js';

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
export interface RuntimeShutdownOptions {
  /** Graceful shutdown attempts system-generated terminal signals. */
  readonly graceful?: boolean;
  readonly reason?: string;
  readonly onTask?: RuntimeShutdownTaskHook;
  /** Maximum time allowed for one arbitrary shutdown hook. */
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
export interface RuntimeIdentityHistory {
  readonly issued: Map<string, number>;
  readonly retentionMs: number;
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
}

export interface RuntimeUnreachableResult {
  readonly status: 'unreachable';
  readonly operationId: string;
  readonly error: ProtocolError & { readonly code: 'unreachable' };
  readonly recipientRuntimeId?: string;
}

/** Error raised when a closed runtime or a stale operation is used. */
export class RuntimePersistenceError extends Error {
  readonly code: 'closed' | 'stale_operation' | 'identity_conflict';
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

interface AcceptedOperationRecord {
  readonly value: AcceptedOperation;
  readonly retainedUntil: number;
  stale: boolean;
  timer?: unknown;
}

interface UnreachableRecord {
  readonly value: RuntimeUnreachableResult;
  readonly recipientRuntimeId?: string;
  readonly message: string;
  readonly retainedUntil: number;
  timer?: unknown;
}

const DEFAULT_SHUTDOWN_HOOK_TIMEOUT_MS = 10_000;
const MAX_TIMER_DELAY_MS = 2_147_483_647;

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

function deadlineMs(value: RuntimeDeadlineInput | undefined, nowMs: number): number {
  if (value === undefined) {
    return nowMs + DEFAULT_REQUEST_TTL_MS;
  }
  let parsed: number;
  if (value instanceof Date) {
    parsed = value.getTime();
  } else if (typeof value === 'number') {
    parsed = value;
  } else {
    parsed = Date.parse(value);
  }
  if (!Number.isFinite(parsed)) {
    throw new TypeError('operation expiry must be a finite timestamp');
  }
  return parsed;
}

function retainedDeadline(
  value: RuntimeDeadlineInput | undefined,
  nowMs: number,
  graceMs: number,
): number {
  const deadline = deadlineMs(value, nowMs);
  const retainedUntil = deadline + graceMs;
  if (!Number.isFinite(retainedUntil)) {
    throw new RangeError('operation retention deadline must be finite');
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
  if (typeof value !== 'string' || value.length === 0 || /\p{C}/u.test(value)) {
    throw new TypeError(`${field} must be a non-empty string without control characters`);
  }
  return value;
}

function identityFromOptions(options: RuntimePersistenceOptions): SessionRuntimeIdentity {
  const supplied = options.identity;
  const suppliedSessionId = options.sessionId;
  const suppliedRuntimeId = options.runtimeId;

  if (supplied !== undefined) {
    const identity = createRuntimeIdentity(supplied.sessionId, () => supplied.runtimeId);
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

  const sessionId = suppliedSessionId ?? `session-${randomUUID()}`;
  if (suppliedRuntimeId !== undefined) {
    return createRuntimeIdentity(sessionId, () => suppliedRuntimeId);
  }
  return createRuntimeIdentity(sessionId, options.runtimeIdFactory ?? randomUUID);
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
  if (runtimeId === current.runtimeId || history.issued.has(runtimeId)) {
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
    assertFreshRuntimeId(current, requested.runtimeId, history);
    if (options.sessionId !== undefined && options.sessionId !== requested.sessionId) {
      throw new RuntimePersistenceError(
        'identity_conflict',
        'sessionId does not match the replacement identity',
      );
    }
    if (options.runtimeId !== undefined && options.runtimeId !== requested.runtimeId) {
      throw new RuntimePersistenceError(
        'identity_conflict',
        'runtimeId does not match the replacement identity',
      );
    }
    return createRuntimeIdentity(requested.sessionId, () => requested.runtimeId);
  }

  const sessionId = options.sessionId ?? current.sessionId;
  const runtimeId =
    options.runtimeId ??
    (options.runtimeIdFactory === undefined ? randomUUID() : options.runtimeIdFactory());
  assertFreshRuntimeId(current, runtimeId, history);
  return createRuntimeIdentity(sessionId, () => runtimeId);
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
  if (!Number.isFinite(timeout) || timeout <= 0) {
    throw new RangeError('shutdown hook timeout must be a finite positive number');
  }
  return timeout;
}

async function waitForShutdownHook<T>(
  hook: () => T | PromiseLike<T>,
  timeoutMs: number,
  setTimeoutFn: RuntimePersistenceSetTimeout,
  clearTimeoutFn: RuntimePersistenceClearTimeout,
): Promise<T> {
  let timer: unknown;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeoutFn(() => reject(new RuntimeShutdownHookTimeout(timeoutMs)), timeoutMs);
  });
  try {
    return await Promise.race([Promise.resolve().then(hook), timeout]);
  } finally {
    if (timer !== undefined) {
      clearTimeoutFn(timer);
    }
  }
}

/**
 * Owns all mutable task/dedupe state for exactly one live runtime.
 *
 * The class intentionally has no import/export or persistence adapter.  The
 * public replacement operation creates new stores, and shutdown clears the old
 * stores before any asynchronous notification hook runs.
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
  private readonly runtimeIdentityHistory: RuntimeIdentityHistory;
  private readonly acceptedOperations = new Map<string, AcceptedOperationRecord>();
  private readonly unreachableResults = new Map<string, UnreachableRecord>();
  public constructor(options: RuntimePersistenceOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    this.setTimeout = options.setTimeout ?? defaultSetTimeout;
    this.clearTimeout = options.clearTimeout ?? defaultClearTimeout;
    const history =
      options.runtimeIdentityHistory ??
      ({
        issued: new Map<string, number>(),
        retentionMs: options.runtimeIdRetentionMs ?? DEDUPE_RETENTION_GRACE_MS,
      } satisfies RuntimeIdentityHistory);
    if (!Number.isFinite(history.retentionMs) || history.retentionMs < 0) {
      throw new RangeError('runtimeIdRetentionMs must be a finite non-negative number');
    }
    const nowMs = finiteNow(this.now());
    pruneRuntimeIdentityHistory(history, nowMs);
    this.runtimeIdentityHistory = history;
    this.identity = identityFromOptions(options);
    if (history.issued.has(this.identity.runtimeId)) {
      throw new RuntimePersistenceError(
        'identity_conflict',
        'runtimeId has already been issued in this runtime replacement chain',
      );
    }
    this.sessionId = this.identity.sessionId;
    this.runtimeId = this.identity.runtimeId;
    this.onShutdownTask = options.onShutdownTask;
    this.retentionGraceMs =
      options.retentionGraceMs ??
      options.dedupeStoreOptions?.retentionGraceMs ??
      DEDUPE_RETENTION_GRACE_MS;
    if (!Number.isFinite(this.retentionGraceMs) || this.retentionGraceMs < 0) {
      throw new RangeError('retentionGraceMs must be a finite non-negative number');
    }

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

  /**
   * Record that an operation was delivered/accepted for one destination.  A
   * later attempt to send that operation ID to a different runtime is refused;
   * callers must create a new operation ID after rediscovery.
   */
  public recordAcceptedOperation(
    operationId: string,
    recipientRuntimeId: string,
    expiresAt?: RuntimeDeadlineInput,
  ): AcceptedOperation {
    this.assertActive();
    const normalizedOperationId = requireText(operationId, 'operationId');
    const normalizedRecipient = requireText(recipientRuntimeId, 'recipientRuntimeId');
    const nowMs = finiteNow(this.now());
    this.prune(nowMs);
    const previous = this.acceptedOperations.get(normalizedOperationId);
    if (previous !== undefined) {
      if (previous.stale || previous.value.recipientRuntimeId !== normalizedRecipient) {
        // Once a caller has tried to move an accepted ID to a replacement,
        // neither the old nor the replacement endpoint may reuse it.
        previous.stale = true;
        throw new RuntimePersistenceError(
          'stale_operation',
          'an accepted operation cannot be replayed at a replacement runtime; create a new operationId',
          {
            operationId: normalizedOperationId,
            recipientRuntimeId: normalizedRecipient,
          },
        );
      }
      return previous.value;
    }
    const accepted = Object.freeze({
      operationId: normalizedOperationId,
      recipientRuntimeId: normalizedRecipient,
    });
    const record: AcceptedOperationRecord = {
      value: accepted,
      retainedUntil: retainedDeadline(expiresAt, nowMs, this.retentionGraceMs),
      stale: false,
    };
    this.acceptedOperations.set(normalizedOperationId, record);
    this.scheduleAcceptedOperation(normalizedOperationId, record);
    return accepted;
  }

  public rememberAcceptedOperation(
    operationId: string,
    recipientRuntimeId: string,
    expiresAt?: RuntimeDeadlineInput,
  ): AcceptedOperation {
    return this.recordAcceptedOperation(operationId, recipientRuntimeId, expiresAt);
  }

  public canReplayOperation(operationId: string, recipientRuntimeId: string): boolean {
    if (!this.active) {
      return false;
    }
    let normalizedOperationId: string;
    let normalizedRecipient: string;
    try {
      normalizedOperationId = requireText(operationId, 'operationId');
      normalizedRecipient = requireText(recipientRuntimeId, 'recipientRuntimeId');
      this.prune(finiteNow(this.now()));
    } catch {
      return false;
    }
    const previous = this.acceptedOperations.get(normalizedOperationId);
    return (
      previous === undefined ||
      (!previous.stale && previous.value.recipientRuntimeId === normalizedRecipient)
    );
  }

  public assertReplayAllowed(operationId: string, recipientRuntimeId: string): void {
    this.assertActive();
    const normalizedOperationId = requireText(operationId, 'operationId');
    const normalizedRecipient = requireText(recipientRuntimeId, 'recipientRuntimeId');
    if (!this.canReplayOperation(normalizedOperationId, normalizedRecipient)) {
      throw new RuntimePersistenceError(
        'stale_operation',
        'operationId belongs to an earlier runtime endpoint; create a new operationId',
        { operationId: normalizedOperationId, recipientRuntimeId: normalizedRecipient },
      );
    }
  }

  public assertOperationReplaySafe(operationId: string, recipientRuntimeId: string): void {
    this.assertReplayAllowed(operationId, recipientRuntimeId);
  }

  /** Always returns a fresh UUIDv4 for a retry after a runtime replacement. */
  public createRetryOperationId(operationId: string, recipientRuntimeId: string): OperationId {
    // A retry is a new operation by definition.  Validate the old operation and
    // the replacement recipient, but never reject the supported replacement case.
    this.assertActive();
    const normalizedOperationId = requireText(operationId, 'operationId');
    const normalizedRecipient = requireText(recipientRuntimeId, 'recipientRuntimeId');
    this.prune(finiteNow(this.now()));
    const previous = this.acceptedOperations.get(normalizedOperationId);
    if (previous !== undefined && previous.value.recipientRuntimeId !== normalizedRecipient) {
      previous.stale = true;
    }
    return randomUUID() as OperationId;
  }

  public newOperationIdForRetry(operationId: string, recipientRuntimeId: string): OperationId {
    return this.createRetryOperationId(operationId, recipientRuntimeId);
  }

  /**
   * Convert a lost local delivery into a protocol-shaped result.  This is a
   * local observation, not a failed/completed remote task outcome.
   */
  public reportUnreachable(
    operationId: string,
    recipientRuntimeId?: string,
    message = 'delivery could not be established with the runtime endpoint',
    expiresAt?: RuntimeDeadlineInput,
  ): RuntimeUnreachableResult {
    this.assertActive();
    const normalizedOperationId = requireText(operationId, 'operationId');
    const normalizedRecipient =
      recipientRuntimeId === undefined
        ? undefined
        : requireText(recipientRuntimeId, 'recipientRuntimeId');
    const normalizedMessage = requireText(message, 'message');
    const nowMs = finiteNow(this.now());
    this.prune(nowMs);

    const accepted = this.acceptedOperations.get(normalizedOperationId);
    if (
      accepted !== undefined &&
      (accepted.stale || accepted.value.recipientRuntimeId !== normalizedRecipient)
    ) {
      throw new RuntimePersistenceError(
        'identity_conflict',
        'unreachable result does not belong to the accepted destination',
        { operationId: normalizedOperationId, recipientRuntimeId: normalizedRecipient },
      );
    }

    const previous = this.unreachableResults.get(normalizedOperationId);
    if (previous !== undefined) {
      const sameRecipient = previous.recipientRuntimeId === normalizedRecipient;
      if (sameRecipient && previous.message === normalizedMessage) {
        return previous.value;
      }
      throw new RuntimePersistenceError(
        'identity_conflict',
        'an unreachable result cannot be overwritten with a conflicting destination or result',
        { operationId: normalizedOperationId, recipientRuntimeId: normalizedRecipient },
      );
    }

    const error = createProtocolError('unreachable', normalizedMessage, {
      details:
        normalizedRecipient === undefined ? undefined : { recipientRuntimeId: normalizedRecipient },
    });
    const result: RuntimeUnreachableResult = Object.freeze({
      status: 'unreachable',
      operationId: normalizedOperationId,
      error: error as ProtocolError & { readonly code: 'unreachable' },
      ...(normalizedRecipient === undefined ? {} : { recipientRuntimeId: normalizedRecipient }),
    });
    const record: UnreachableRecord = {
      value: result,
      recipientRuntimeId: normalizedRecipient,
      message: normalizedMessage,
      retainedUntil:
        accepted?.retainedUntil ?? retainedDeadline(expiresAt, nowMs, this.retentionGraceMs),
    };
    this.unreachableResults.set(normalizedOperationId, record);
    this.scheduleUnreachableResult(normalizedOperationId, record);
    return result;
  }

  public markUnreachable(
    operationId: string,
    recipientRuntimeId?: string,
    message?: string,
    expiresAt?: RuntimeDeadlineInput,
  ): RuntimeUnreachableResult {
    return this.reportUnreachable(operationId, recipientRuntimeId, message, expiresAt);
  }

  public getUnreachable(operationId: string): RuntimeUnreachableResult | undefined {
    this.assertActive();
    const normalizedOperationId = requireText(operationId, 'operationId');
    this.prune(finiteNow(this.now()));
    return this.unreachableResults.get(normalizedOperationId)?.value;
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
    for (const [operationId, record] of this.acceptedOperations) {
      if (record.retainedUntil <= nowMs) {
        this.removeAcceptedOperation(operationId, record);
        removed += 1;
      }
    }
    for (const [operationId, record] of this.unreachableResults) {
      if (record.retainedUntil <= nowMs) {
        this.removeUnreachableResult(operationId, record);
        removed += 1;
      }
    }
    return removed;
  }

  public unreachable(
    operationId: string,
    recipientRuntimeId?: string,
    expiresAt?: RuntimeDeadlineInput,
  ): RuntimeUnreachableResult {
    return this.reportUnreachable(operationId, recipientRuntimeId, undefined, expiresAt);
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

    let tasks: RuntimeShutdownTask[] = [];
    try {
      tasks = graceful ? this.terminalizeTasks(reason) : [];

      // Disposal is deliberately before asynchronous hooks.  A callback may
      // attempt best-effort delivery, but it can never mutate this old runtime.
      this.taskStore.dispose();
      this.dedupeStore.close();
      this.clearRuntimeGuards();
      this.lifecycleState = 'closed';
    } catch (error) {
      try {
        this.taskStore.dispose();
        this.dedupeStore.close();
        this.clearRuntimeGuards();
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
    if (this.replacementRuntime !== undefined) {
      return this.replacementRuntime;
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
      now: options.now ?? this.now,
      setTimeout: options.setTimeout ?? this.setTimeout,
      clearTimeout: options.clearTimeout ?? this.clearTimeout,
      retentionGraceMs: options.retentionGraceMs ?? this.retentionGraceMs,
      runtimeIdentityHistory: this.runtimeIdentityHistory,
    });
    this.runtimeIdentityHistory.issued.set(
      this.runtimeId,
      nowMs + this.runtimeIdentityHistory.retentionMs,
    );
    // Publish the sole replacement before invoking shutdown: a reentrant hook
    // must observe and return this exact runtime rather than create another.
    this.replacementRuntime = replacement;
    void this.shutdown(options.shutdown);
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
      this.clearTimeout(record.timer);
      record.timer = undefined;
    }
    this.acceptedOperations.delete(operationId);
  }

  private removeUnreachableResult(operationId: string, record: UnreachableRecord): void {
    if (this.unreachableResults.get(operationId) !== record) {
      return;
    }
    if (record.timer !== undefined) {
      this.clearTimeout(record.timer);
      record.timer = undefined;
    }
    this.unreachableResults.delete(operationId);
  }

  private clearRuntimeGuards(): void {
    for (const [operationId, record] of this.acceptedOperations) {
      this.removeAcceptedOperation(operationId, record);
    }
    for (const [operationId, record] of this.unreachableResults) {
      this.removeUnreachableResult(operationId, record);
    }
  }

  private async finishShutdown(
    tasks: readonly RuntimeShutdownTask[],
    graceful: boolean,
    hook: RuntimeShutdownTaskHook | undefined,
    hookTimeoutMs: number,
  ): Promise<RuntimeShutdownReport> {
    const completedTasks: RuntimeShutdownTask[] = [];
    for (const task of tasks) {
      let delivery: RuntimeShutdownDelivery;
      try {
        delivery = normalizeShutdownDelivery(
          hook === undefined
            ? undefined
            : await waitForShutdownHook(
                () => hook(task),
                hookTimeoutMs,
                this.setTimeout,
                this.clearTimeout,
              ),
        );
      } catch (error) {
        delivery = { status: 'unreachable', error };
      }
      completedTasks.push(
        Object.freeze({
          ...task,
          delivery: delivery.status,
          ...(delivery.error === undefined ? {} : { deliveryError: delivery.error }),
        }),
      );
    }
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
      tasks.push({
        identity: this.identity,
        requestId: previous.requestId,
        owner,
        previous,
        snapshot,
        delivery: 'skipped',
      });
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
