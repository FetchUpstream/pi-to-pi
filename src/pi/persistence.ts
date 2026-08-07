/**
 * Runtime-local state and lifecycle boundary for Pi-to-Pi.
 *
 * This module is deliberately not a durable database.  Task records,
 * deduplication reservations, operation retry guards, and unreachable results
 * all belong to one live runtime instance.  A replacement must construct a new
 * boundary; it cannot import or adopt any state from the old one.
 */

import { randomUUID } from 'node:crypto';

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
}

export interface RuntimeShutdownReport {
  readonly identity: SessionRuntimeIdentity;
  readonly graceful: boolean;
  readonly state: 'closed';
  readonly tasks: readonly RuntimeShutdownTask[];
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

function replacementIdentity(
  current: SessionRuntimeIdentity,
  options: RuntimeReloadOptions,
): SessionRuntimeIdentity {
  const requested = options.identity;
  if (requested !== undefined) {
    if (requested.runtimeId === current.runtimeId) {
      throw new RuntimePersistenceError(
        'identity_conflict',
        'a replacement runtime must have a fresh runtimeId',
      );
    }
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
  if (runtimeId === current.runtimeId) {
    throw new RuntimePersistenceError(
      'identity_conflict',
      'a replacement runtime must have a fresh runtimeId',
    );
  }
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
  if (
    value === 'unreachable' ||
    (typeof value === 'object' &&
      value !== null &&
      'status' in value &&
      value.status === 'unreachable')
  ) {
    return { status: 'unreachable' };
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
  private readonly onShutdownTask?: RuntimeShutdownTaskHook;
  private readonly acceptedOperations = new Map<string, AcceptedOperation>();
  private readonly unreachableResults = new Map<string, RuntimeUnreachableResult>();

  public constructor(options: RuntimePersistenceOptions = {}) {
    this.identity = identityFromOptions(options);
    this.sessionId = this.identity.sessionId;
    this.runtimeId = this.identity.runtimeId;
    this.onShutdownTask = options.onShutdownTask;

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
  ): AcceptedOperation {
    this.assertActive();
    const normalizedOperationId = requireText(operationId, 'operationId');
    const normalizedRecipient = requireText(recipientRuntimeId, 'recipientRuntimeId');
    const previous = this.acceptedOperations.get(normalizedOperationId);
    if (previous !== undefined && previous.recipientRuntimeId !== normalizedRecipient) {
      throw new RuntimePersistenceError(
        'stale_operation',
        'an accepted operation cannot be replayed at a replacement runtime; create a new operationId',
        {
          operationId: normalizedOperationId,
          recipientRuntimeId: normalizedRecipient,
        },
      );
    }
    const accepted = previous ?? {
      operationId: normalizedOperationId,
      recipientRuntimeId: normalizedRecipient,
    };
    this.acceptedOperations.set(normalizedOperationId, accepted);
    return accepted;
  }

  public rememberAcceptedOperation(
    operationId: string,
    recipientRuntimeId: string,
  ): AcceptedOperation {
    return this.recordAcceptedOperation(operationId, recipientRuntimeId);
  }

  public canReplayOperation(operationId: string, recipientRuntimeId: string): boolean {
    if (!this.active) {
      return false;
    }
    const previous = this.acceptedOperations.get(operationId);
    return previous === undefined || previous.recipientRuntimeId === recipientRuntimeId;
  }

  public assertReplayAllowed(operationId: string, recipientRuntimeId: string): void {
    this.assertActive();
    if (!this.canReplayOperation(operationId, recipientRuntimeId)) {
      throw new RuntimePersistenceError(
        'stale_operation',
        'operationId belongs to an earlier runtime endpoint; create a new operationId',
        { operationId, recipientRuntimeId },
      );
    }
  }

  public assertOperationReplaySafe(operationId: string, recipientRuntimeId: string): void {
    this.assertReplayAllowed(operationId, recipientRuntimeId);
  }

  /** Always returns a fresh UUIDv4 for a retry after a runtime replacement. */
  public createRetryOperationId(operationId: string, recipientRuntimeId: string): OperationId {
    this.assertReplayAllowed(operationId, recipientRuntimeId);
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
  ): RuntimeUnreachableResult {
    const normalizedOperationId = requireText(operationId, 'operationId');
    const normalizedRecipient =
      recipientRuntimeId === undefined
        ? undefined
        : requireText(recipientRuntimeId, 'recipientRuntimeId');
    const error = createProtocolError('unreachable', message, {
      details:
        normalizedRecipient === undefined ? undefined : { recipientRuntimeId: normalizedRecipient },
    });
    const result: RuntimeUnreachableResult = Object.freeze({
      status: 'unreachable',
      operationId: normalizedOperationId,
      error: error as ProtocolError & { readonly code: 'unreachable' },
      ...(normalizedRecipient === undefined ? {} : { recipientRuntimeId: normalizedRecipient }),
    });
    this.unreachableResults.set(normalizedOperationId, result);
    return result;
  }

  public markUnreachable(
    operationId: string,
    recipientRuntimeId?: string,
    message?: string,
  ): RuntimeUnreachableResult {
    return this.reportUnreachable(operationId, recipientRuntimeId, message);
  }

  public getUnreachable(operationId: string): RuntimeUnreachableResult | undefined {
    return this.unreachableResults.get(operationId);
  }

  public unreachable(operationId: string, recipientRuntimeId?: string): RuntimeUnreachableResult {
    return this.reportUnreachable(operationId, recipientRuntimeId);
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
    this.lifecycleState = 'shutting_down';
    const tasks = graceful ? this.terminalizeTasks(reason) : [];

    // Disposal is deliberately before the asynchronous hook.  A callback may
    // attempt best-effort delivery, but it can never mutate this old runtime.
    this.taskStore.dispose();
    this.dedupeStore.close();
    this.acceptedOperations.clear();
    this.unreachableResults.clear();
    this.lifecycleState = 'closed';

    const hook = options.onTask ?? this.onShutdownTask;
    this.shutdownPromise = (async (): Promise<RuntimeShutdownReport> => {
      const completedTasks: RuntimeShutdownTask[] = [];
      for (const task of tasks) {
        let delivery: RuntimeShutdownDelivery;
        try {
          delivery = normalizeShutdownDelivery(hook === undefined ? undefined : await hook(task));
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
    })();
    return this.shutdownPromise;
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
    const identity = replacementIdentity(this.identity, options);
    void this.shutdown(options.shutdown);
    return new RuntimePersistence({
      identity,
      runtimeIdFactory: options.runtimeIdFactory,
      taskStoreOptions: options.taskStoreOptions,
      dedupeStoreOptions: options.dedupeStoreOptions,
      onShutdownTask: options.onShutdownTask,
    });
  }

  public replacement(options: RuntimeReloadOptions = {}): RuntimePersistence {
    return this.reload(options);
  }

  public replace(options: RuntimeReloadOptions = {}): RuntimePersistence {
    return this.reload(options);
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
