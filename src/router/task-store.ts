import { DEFAULT_REQUEST_TTL_MS } from '../config.js';
import type {
  Content,
  ExpectedResponse,
  RequestId,
  RoomId,
  RuntimeId,
  SenderIdentity,
  SessionId,
  UtcTimestamp,
} from '../protocol/messages.js';
import { createProtocolError, type ProtocolError } from '../protocol/errors.js';
import {
  canTransitionTaskState,
  isTerminalTaskState,
  type TaskSnapshot,
  type TaskState,
  type TerminalTaskSnapshot,
} from '../protocol/task-state.js';

/** String, Date, and epoch inputs keep the store convenient to test. */
export type TaskTimestampInput = UtcTimestamp | string | Date | number;
export type TaskRequestKey = RequestId | string;
export type TaskRuntimeIdentifier = RuntimeId | string;

/** The runtime that originated a logical request. */
export interface TaskOwner {
  readonly runtimeId: RuntimeId;
  readonly sessionId?: SessionId;
}

export type TaskOwnership = 'inbound' | 'outbound';

/** Runtime-local routing metadata that is deliberately not inferred from order. */
export interface TaskRecordMetadata {
  readonly requestId: RequestId;
  readonly requester: TaskOwner;
  readonly localOwner: TaskOwner;
  readonly expectedTargetRuntimeId?: RuntimeId;
  readonly roomId?: RoomId;
  readonly responseContract?: ExpectedResponse;
  readonly ownership: TaskOwnership;
  readonly snapshot: TaskSnapshot;
  readonly signal: AbortSignal;
}

export type TaskOwnerInput =
  | TaskRuntimeIdentifier
  | TaskOwner
  | SenderIdentity
  | {
      readonly runtimeId: TaskRuntimeIdentifier;
      readonly sessionId?: SessionId | string;
    };

export type TaskCaller = TaskOwnerInput;
export type TaskAdmissionState = Extract<TaskState, 'accepted' | 'queued'>;

export interface TaskResponse {
  readonly content?: Content;
  readonly error?: ProtocolError;
}

export interface TaskTransitionUpdate extends TaskResponse {
  /** An alternate spelling useful to callers that already have a reply object. */
  readonly response?: TaskResponse;
  readonly cancellationRequested?: boolean;
  readonly requestedAt?: TaskTimestampInput;
  readonly updatedAt?: TaskTimestampInput;
  readonly reason?: string;
}

export interface TaskStoreCreateInput extends TaskResponse {
  readonly requestId: TaskRequestKey;
  readonly operationId?: string;
  readonly owner?: TaskOwnerInput;
  /** Explicit requester alias; owner remains the compatibility spelling. */
  readonly requester?: TaskOwnerInput;
  readonly localOwner?: TaskOwnerInput;
  readonly expectedTargetRuntimeId?: TaskRuntimeIdentifier;
  readonly roomId?: RoomId | string;
  readonly responseContract?: ExpectedResponse;
  readonly ownership?: TaskOwnership;
  readonly direction?: TaskOwnership;
  readonly sender?: SenderIdentity;
  readonly ownerRuntimeId?: TaskRuntimeIdentifier;
  readonly senderRuntimeId?: TaskRuntimeIdentifier;
  readonly ownerSessionId?: SessionId | string;
  readonly createdAt?: TaskTimestampInput;
  readonly expiresAt?: TaskTimestampInput;
  readonly state?: TaskState;
  readonly initialState?: TaskState;
  readonly admissionState?: TaskAdmissionState;
  readonly cancellationRequested?: boolean;
  readonly requestedAt?: TaskTimestampInput;
  readonly response?: TaskResponse;
}

export interface CancellationRequestOptions {
  readonly caller?: TaskCaller;
  readonly reason?: string;
  readonly requestedAt?: TaskTimestampInput;
}

export interface SnapshotReadOptions {
  readonly includeTerminalResponse?: boolean;
  readonly caller?: TaskCaller;
}

export interface TaskStateChangeEvent {
  readonly requestId: RequestId;
  readonly from: TaskState;
  readonly to: TaskState;
  readonly snapshot: TaskSnapshot;
}

export interface TaskCancellationEvent {
  readonly requestId: RequestId;
  readonly owner: TaskOwner;
  readonly snapshot: TaskSnapshot;
  readonly signal: AbortSignal;
  readonly reason?: string;
}

export type TaskAuthorizationAction = 'status' | 'cancel';

export interface TaskAuthorizationRequest {
  readonly requestId: RequestId;
  readonly action: TaskAuthorizationAction;
  readonly owner: TaskOwner;
  readonly callerRuntimeId: RuntimeId;
}

export type TaskAuthorization = (request: TaskAuthorizationRequest) => boolean;

export interface TaskStoreOptions {
  /** Keep terminal content/error fields in terminal snapshots. */
  readonly retainTerminalResponse?: boolean;
  /** How long terminal records remain addressable. Infinity retains them. */
  readonly terminalRetentionMs?: number;
  readonly terminalSnapshotRetentionMs?: number;
  readonly retentionMs?: number;
  /** Wall clock used for wire timestamps and admission. */
  readonly now?: () => number;
  readonly wallNow?: () => number;
  readonly clock?: () => number;
  /** Monotonic clock used after admission for deadline timers. */
  readonly monotonicNow?: () => number;
  readonly monotonicClock?: () => number;
  readonly setTimeout?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  readonly clearTimeout?: (timer: ReturnType<typeof setTimeout>) => void;
  readonly localOwnerRuntimeId?: TaskRuntimeIdentifier;
  readonly authorize?: TaskAuthorization;
  readonly onStateChange?: (event: TaskStateChangeEvent) => void;
  readonly onCancellationRequested?: (event: TaskCancellationEvent) => void;
  readonly onExpired?: (snapshot: TerminalTaskSnapshot) => void;
}

export type TaskStoreErrorCode =
  | 'duplicate'
  | 'not_found'
  | 'invalid_transition'
  | 'terminal'
  | 'unauthorized'
  | 'not_cancelable'
  | 'expired'
  | 'disposed';

/** Errors are available for callers that prefer throwing transition APIs. */
export class TaskStoreError extends Error {
  readonly code: TaskStoreErrorCode;
  readonly requestId?: RequestId;
  readonly snapshot?: TaskSnapshot;

  constructor(
    code: TaskStoreErrorCode,
    message: string,
    requestId?: RequestId,
    snapshot?: TaskSnapshot,
  ) {
    super(message);
    this.name = 'TaskStoreError';
    this.code = code;
    this.requestId = requestId;
    this.snapshot = snapshot;
  }
}

export interface TaskTransitionSuccess {
  readonly ok: true;
  readonly changed: true;
  readonly previousState: TaskState;
  readonly snapshot: TaskSnapshot;
}

export interface TaskTransitionFailure {
  readonly ok: false;
  readonly changed: false;
  readonly code: Exclude<TaskStoreErrorCode, 'duplicate' | 'unauthorized' | 'disposed'>;
  readonly snapshot?: TaskSnapshot;
}

export type TaskTransitionResult = TaskTransitionSuccess | TaskTransitionFailure;

export interface TaskCancellationSuccess {
  readonly ok: true;
  readonly changed: boolean;
  readonly state: Extract<TaskState, 'cancelling' | 'cancelled'>;
  readonly snapshot: TaskSnapshot;
}

export interface TaskCancellationFailure {
  readonly ok: false;
  readonly changed: false;
  readonly code: 'not_found' | 'unauthorized' | 'not_cancelable';
  readonly snapshot?: TaskSnapshot;
}

export type TaskCancellationResult = TaskCancellationSuccess | TaskCancellationFailure;

export type TaskStatusResult =
  | { readonly ok: true; readonly snapshot: TaskSnapshot }
  | { readonly ok: false; readonly code: 'not_found' | 'unauthorized' };

export interface TaskHandle {
  readonly requestId: RequestId;
  readonly owner: TaskOwner;
  readonly snapshot: TaskSnapshot;
  readonly signal: AbortSignal;
}

export interface TaskExecutionHandle extends TaskHandle {
  readonly snapshot: TaskSnapshot & { readonly state: Extract<TaskState, 'working'> };
}

type Timer = ReturnType<typeof setTimeout>;

interface StoredTask {
  readonly requestId: RequestId;
  readonly owner: TaskOwner;
  readonly localOwner: TaskOwner;
  readonly expectedTargetRuntimeId?: RuntimeId;
  readonly roomId?: RoomId;
  readonly responseContract?: ExpectedResponse;
  readonly ownership: TaskOwnership;
  readonly controller: AbortController;
  readonly deadlineMs: number;
  readonly deadlineMonotonicMs: number;
  updatedAtMs: number;
  snapshot: TaskSnapshot;
  expiryTimer?: Timer;
  purgeTimer?: Timer;
}

interface NormalizedTimestamp {
  readonly value: UtcTimestamp;
  readonly epochMs: number;
}

interface ParsedCancellationRequest {
  readonly caller?: TaskCaller;
  readonly reason?: string;
  readonly requestedAt?: TaskTimestampInput;
}

type StoreTerminalState = Extract<
  TaskState,
  'completed' | 'failed' | 'rejected' | 'cancelled' | 'expired'
>;

function isTerminal(state: TaskState): state is StoreTerminalState {
  return isTerminalTaskState(state);
}

function isContent(value: unknown): value is Content {
  if (typeof value !== 'object' || value === null || !('type' in value)) {
    return false;
  }

  const type = (value as { readonly type?: unknown }).type;
  return type === 'text' || type === 'json';
}

function cloneAndFreeze<T>(value: T, seen = new WeakMap<object, unknown>()): T {
  if (value === null || typeof value !== 'object') {
    return value;
  }

  const existing = seen.get(value);
  if (existing !== undefined) {
    return existing as T;
  }

  if (Array.isArray(value)) {
    const copy: unknown[] = [];
    seen.set(value, copy);
    for (const item of value) {
      copy.push(cloneAndFreeze(item, seen));
    }
    return Object.freeze(copy) as T;
  }

  const copy: Record<string, unknown> = {};
  seen.set(value, copy);
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    copy[key] = cloneAndFreeze(item, seen);
  }
  return Object.freeze(copy) as T;
}

function normalizeTimestamp(value: TaskTimestampInput): NormalizedTimestamp {
  let epochMs: number;
  let wireValue: string;

  if (value instanceof Date) {
    epochMs = value.getTime();
    wireValue = value.toISOString();
  } else if (typeof value === 'number') {
    epochMs = value;
    wireValue = new Date(value).toISOString();
  } else {
    wireValue = value;
    epochMs = Date.parse(value);
  }

  if (!Number.isFinite(epochMs)) {
    throw new RangeError('task timestamps must be finite dates');
  }

  if (typeof value === 'number' || value instanceof Date) {
    wireValue = new Date(epochMs).toISOString();
  }

  return {
    value: wireValue as UtcTimestamp,
    epochMs,
  };
}

function nowTimestamp(epochMs: number): NormalizedTimestamp {
  return normalizeTimestamp(new Date(epochMs));
}

function runtimeIdOf(value: TaskCaller | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'object' && value !== null && typeof value.runtimeId === 'string') {
    return value.runtimeId;
  }
  return undefined;
}

function normalizeOwnerValue(owner: TaskOwnerInput | undefined): TaskOwner | undefined {
  if (owner === undefined) {
    return undefined;
  }
  const runtimeId = runtimeIdOf(owner);
  if (runtimeId === undefined || runtimeId.length === 0) {
    throw new TypeError('a task owner runtimeId is required');
  }
  const sessionId = typeof owner === 'object' && owner !== null ? owner.sessionId : undefined;
  return cloneAndFreeze({
    runtimeId: runtimeId as RuntimeId,
    ...(sessionId === undefined ? {} : { sessionId: sessionId as SessionId }),
  });
}

function normalizeOwner(input: TaskStoreCreateInput): TaskOwner {
  const owner = normalizeOwnerValue(input.requester ?? input.owner ?? input.sender);
  if (owner !== undefined) {
    return owner;
  }
  const runtimeId = runtimeIdOf(input.ownerRuntimeId) ?? runtimeIdOf(input.senderRuntimeId);
  const fallback = normalizeOwnerValue(
    runtimeId === undefined ? undefined : { runtimeId, sessionId: input.ownerSessionId },
  );
  if (fallback === undefined) {
    throw new TypeError('a task owner runtimeId is required');
  }
  return fallback;
}

function normalizeLocalOwner(
  input: TaskStoreCreateInput,
  requester: TaskOwner,
  localOwnerRuntimeId: string | undefined,
): TaskOwner {
  const explicit = normalizeOwnerValue(input.localOwner);
  if (explicit !== undefined) {
    return explicit;
  }
  return (
    normalizeOwnerValue(
      localOwnerRuntimeId === undefined ? undefined : { runtimeId: localOwnerRuntimeId },
    ) ?? requester
  );
}

function isCancellationRequestOptions(value: unknown): value is CancellationRequestOptions {
  return (
    typeof value === 'object' &&
    value !== null &&
    ('caller' in value || 'reason' in value || 'requestedAt' in value)
  );
}

function parseCancellationRequest(
  value: TaskCaller | CancellationRequestOptions | undefined,
): ParsedCancellationRequest {
  if (value === undefined) {
    return {};
  }
  if (isCancellationRequestOptions(value)) {
    return value;
  }
  return { caller: value };
}

function taskKey(requestId: TaskRequestKey): string {
  return requestId;
}

/**
 * Runtime-local task state. All mutating operations are synchronous, so a
 * state check and its corresponding map update are one event-loop-critical
 * section. No operation awaits between those two steps.
 */
export class TaskStore {
  private readonly records = new Map<string, StoredTask>();
  private readonly queued = new Set<string>();
  private readonly retainTerminalResponse: boolean;
  private readonly terminalRetentionMs: number;
  private readonly nowFn: () => number;
  private readonly monotonicNowFn: () => number;
  private readonly scheduleTimer: (callback: () => void, delayMs: number) => Timer;
  private readonly cancelTimer: (timer: Timer) => void;
  private readonly localOwnerRuntimeId?: string;
  private readonly authorize?: TaskAuthorization;
  private readonly onStateChange?: (event: TaskStateChangeEvent) => void;
  private readonly onCancellationRequested?: (event: TaskCancellationEvent) => void;
  private readonly onExpired?: (snapshot: TerminalTaskSnapshot) => void;
  private disposed = false;

  constructor(options: TaskStoreOptions = {}) {
    this.retainTerminalResponse = options.retainTerminalResponse ?? true;
    const retention =
      options.terminalRetentionMs ??
      options.terminalSnapshotRetentionMs ??
      options.retentionMs ??
      Infinity;
    if (retention < 0 || Number.isNaN(retention)) {
      throw new RangeError('terminal retention must be non-negative');
    }
    this.terminalRetentionMs = retention;
    const suppliedWallClock = options.wallNow ?? options.now ?? options.clock;
    this.nowFn = suppliedWallClock ?? (() => Date.now());
    this.monotonicNowFn =
      options.monotonicNow ??
      options.monotonicClock ??
      suppliedWallClock ??
      (() => performance.now());
    this.scheduleTimer =
      options.setTimeout ?? ((callback, delayMs) => setTimeout(callback, delayMs));
    this.cancelTimer = options.clearTimeout ?? ((timer) => clearTimeout(timer));
    this.localOwnerRuntimeId = runtimeIdOf(options.localOwnerRuntimeId);
    this.authorize = options.authorize;
    this.onStateChange = options.onStateChange;
    this.onCancellationRequested = options.onCancellationRequested;
    this.onExpired = options.onExpired;
  }

  /** Number of active and retained terminal tasks. */
  get size(): number {
    return this.records.size;
  }

  /** Number of tasks currently marked queued. */
  get queuedSize(): number {
    return this.queued.size;
  }

  /** Create an admitted task, defaulting to the receiver's `accepted` state. */
  createTask(input: TaskStoreCreateInput): TaskSnapshot {
    this.ensureUsable();
    const key = taskKey(input.requestId);
    const requestId = input.requestId as RequestId;
    if (this.records.has(key)) {
      throw new TaskStoreError('duplicate', `task ${key} already exists`, requestId);
    }

    const owner = normalizeOwner(input);
    const localOwner = normalizeLocalOwner(input, owner, this.localOwnerRuntimeId);
    const expectedTargetRuntimeId = input.expectedTargetRuntimeId as RuntimeId | undefined;
    const roomId = input.roomId as RoomId | undefined;
    const responseContract = input.responseContract;
    const ownership = input.ownership ?? input.direction ?? 'inbound';
    const admissionState = input.admissionState;
    const requestedState = input.initialState ?? input.state ?? admissionState ?? 'accepted';
    if (requestedState === 'cancelling') {
      throw new TaskStoreError(
        'invalid_transition',
        'a task cannot be created in cancelling state',
        requestId,
      );
    }

    const currentNow = this.currentNow();
    const createdAt = normalizeTimestamp(input.createdAt ?? currentNow);
    const expiresAt = normalizeTimestamp(
      input.expiresAt ?? createdAt.epochMs + DEFAULT_REQUEST_TTL_MS,
    );
    if (expiresAt.epochMs <= createdAt.epochMs) {
      throw new RangeError('task expiresAt must be later than createdAt');
    }

    let state = requestedState;
    const expiredAtAdmission = !isTerminal(state) && expiresAt.epochMs <= currentNow;
    if (expiredAtAdmission) {
      state = 'expired';
    }

    const cancellationRequested = input.cancellationRequested ?? false;
    const requestedAt =
      cancellationRequested && input.requestedAt !== undefined
        ? normalizeTimestamp(input.requestedAt).value
        : cancellationRequested
          ? nowTimestamp(currentNow).value
          : undefined;
    const response = input.response ?? { content: input.content, error: input.error };
    const snapshot = this.buildSnapshot({
      requestId,
      state,
      createdAt: createdAt.value,
      updatedAt: createdAt.value,
      expiresAt: expiresAt.value,
      cancellationRequested,
      requestedAt,
      content: response.content,
      error: expiredAtAdmission
        ? createProtocolError('expired', 'task deadline elapsed before admission')
        : response.error,
      terminal: isTerminal(state),
      terminalResponse: response,
    });
    const deadlineMonotonicMs =
      this.currentMonotonic() + Math.max(0, expiresAt.epochMs - currentNow);
    const record: StoredTask = {
      requestId,
      owner,
      localOwner,
      ...(expectedTargetRuntimeId === undefined ? {} : { expectedTargetRuntimeId }),
      ...(roomId === undefined ? {} : { roomId }),
      ...(responseContract === undefined
        ? {}
        : { responseContract: cloneAndFreeze(responseContract) }),
      ownership,
      controller: new AbortController(),
      deadlineMs: expiresAt.epochMs,
      deadlineMonotonicMs,
      updatedAtMs: createdAt.epochMs,
      snapshot,
    };
    this.records.set(key, record);
    if (state === 'queued') {
      this.queued.add(key);
    }

    if (isTerminal(state)) {
      this.schedulePurge(record);
      if (state === 'expired') {
        this.abort(record, 'task deadline expired');
        this.notifyExpired(snapshot);
      }
    } else {
      this.scheduleExpiry(record);
    }

    return snapshot;
  }

  /** Short alias for createTask. */
  create(input: TaskStoreCreateInput): TaskSnapshot {
    return this.createTask(input);
  }

  /** Return an immutable snapshot, or undefined for unknown/purged requests. */
  getTask(
    requestId: TaskRequestKey,
    options?: SnapshotReadOptions | TaskCaller,
  ): TaskSnapshot | undefined {
    const record = this.findRecord(requestId);
    if (record === undefined) {
      return undefined;
    }
    this.expireIfDue(record);
    const readOptions = this.readOptions(options);
    if (
      readOptions.caller !== undefined &&
      !this.isAuthorized(record, readOptions.caller, 'status')
    ) {
      return undefined;
    }
    return this.projectSnapshot(record.snapshot, readOptions.includeTerminalResponse);
  }

  /** Short aliases used by status/router integrations. */
  get(
    requestId: TaskRequestKey,
    options?: SnapshotReadOptions | TaskCaller,
  ): TaskSnapshot | undefined {
    return this.getTask(requestId, options);
  }

  getStatus(
    requestId: TaskRequestKey,
    options?: SnapshotReadOptions | TaskCaller,
  ): TaskSnapshot | undefined {
    return this.getTask(requestId, options);
  }

  /** Status lookup with an explicit not-found/unauthorized result. */
  getStatusResult(
    requestId: TaskRequestKey,
    options?: SnapshotReadOptions | TaskCaller,
  ): TaskStatusResult {
    const readOptions = this.readOptions(options);
    const record = this.findRecord(requestId);
    if (record === undefined) {
      return { ok: false, code: readOptions.caller === undefined ? 'not_found' : 'unauthorized' };
    }
    this.expireIfDue(record);
    if (
      readOptions.caller !== undefined &&
      !this.isAuthorized(record, readOptions.caller, 'status')
    ) {
      return { ok: false, code: 'unauthorized' };
    }
    return {
      ok: true,
      snapshot: this.projectSnapshot(record.snapshot, readOptions.includeTerminalResponse),
    };
  }

  status(requestId: TaskRequestKey, options?: SnapshotReadOptions | TaskCaller): TaskStatusResult {
    return this.getStatusResult(requestId, options);
  }

  /** Return owner and cancellation signal for local router/executor integration. */
  getTaskHandle(requestId: TaskRequestKey): TaskHandle | undefined {
    const record = this.findRecord(requestId);
    if (record === undefined) {
      return undefined;
    }
    this.expireIfDue(record);
    return Object.freeze({
      requestId: record.requestId,
      owner: record.owner,
      snapshot: record.snapshot,
      signal: record.controller.signal,
    });
  }

  getOwner(requestId: TaskRequestKey): TaskOwner | undefined {
    return this.findRecord(requestId)?.owner;
  }

  getRecordMetadata(requestId: TaskRequestKey): TaskRecordMetadata | undefined {
    const record = this.findRecord(requestId);
    if (record === undefined) {
      return undefined;
    }
    this.expireIfDue(record);
    return Object.freeze({
      requestId: record.requestId,
      requester: record.owner,
      localOwner: record.localOwner,
      ...(record.expectedTargetRuntimeId === undefined
        ? {}
        : { expectedTargetRuntimeId: record.expectedTargetRuntimeId }),
      ...(record.roomId === undefined ? {} : { roomId: record.roomId }),
      ...(record.responseContract === undefined
        ? {}
        : { responseContract: record.responseContract }),
      ownership: record.ownership,
      snapshot: record.snapshot,
      signal: record.controller.signal,
    });
  }

  getTaskRecord(requestId: TaskRequestKey): TaskRecordMetadata | undefined {
    return this.getRecordMetadata(requestId);
  }

  recordMetadata(requestId: TaskRequestKey): TaskRecordMetadata | undefined {
    return this.getRecordMetadata(requestId);
  }

  ownsTask(requestId: TaskRequestKey, caller: TaskCaller): boolean {
    const record = this.findRecord(requestId);
    return record !== undefined && this.isAuthorized(record, caller, 'status');
  }

  /** The per-task signal is intentionally not shared with any other request. */
  getCancellationSignal(requestId: TaskRequestKey): AbortSignal | undefined {
    return this.findRecord(requestId)?.controller.signal;
  }

  /** Register a listener without exposing the task's AbortController. */
  onCancellation(requestId: TaskRequestKey, listener: (reason?: unknown) => void): () => void {
    const signal = this.getCancellationSignal(requestId);
    if (signal === undefined) {
      return () => undefined;
    }
    if (signal.aborted) {
      listener((signal as AbortSignal & { readonly reason?: unknown }).reason);
      return () => undefined;
    }
    const handler = (): void => {
      listener((signal as AbortSignal & { readonly reason?: unknown }).reason);
    };
    signal.addEventListener('abort', handler, { once: true });
    return () => signal.removeEventListener('abort', handler);
  }

  /** Begin execution only after an accepted/queued task has become working. */
  startTask(requestId: TaskRequestKey): TaskSnapshot | undefined {
    return this.transition(requestId, 'working');
  }

  start(requestId: TaskRequestKey): TaskSnapshot | undefined {
    return this.startTask(requestId);
  }

  /** Start and return the scoped executor signal in one operation. */
  beginExecution(requestId: TaskRequestKey): TaskExecutionHandle | undefined {
    const record = this.findRecord(requestId);
    if (record === undefined) {
      return undefined;
    }
    this.expireIfDue(record);
    if (record.snapshot.state !== 'working') {
      const result = this.tryTransition(requestId, 'working');
      if (!result.ok) {
        return undefined;
      }
    }
    const snapshot = record.snapshot;
    if (snapshot.state !== 'working') {
      return undefined;
    }
    return Object.freeze({
      requestId: record.requestId,
      owner: record.owner,
      snapshot: snapshot as TaskSnapshot & { readonly state: 'working' },
      signal: record.controller.signal,
    });
  }

  acceptTask(requestId: TaskRequestKey): TaskSnapshot | undefined {
    return this.transition(requestId, 'accepted');
  }

  accept(requestId: TaskRequestKey): TaskSnapshot | undefined {
    return this.acceptTask(requestId);
  }

  queueTask(requestId: TaskRequestKey): TaskSnapshot | undefined {
    return this.transition(requestId, 'queued');
  }

  queue(requestId: TaskRequestKey): TaskSnapshot | undefined {
    return this.queueTask(requestId);
  }

  /**
   * Try a legal state transition. Terminal transitions are linearized by the
   * synchronous map update; a later terminal attempt returns the winner.
   */
  tryTransition(
    requestId: TaskRequestKey,
    nextState: TaskState,
    update?: TaskTransitionUpdate,
  ): TaskTransitionResult;
  tryTransition(
    requestId: TaskRequestKey,
    expectedState: TaskState,
    nextState: TaskState,
    update?: TaskTransitionUpdate,
  ): TaskTransitionResult;
  tryTransition(
    requestId: TaskRequestKey,
    firstState: TaskState,
    secondStateOrUpdate: TaskState | TaskTransitionUpdate = {},
    thirdUpdate: TaskTransitionUpdate = {},
  ): TaskTransitionResult {
    const expectedState = typeof secondStateOrUpdate === 'string' ? firstState : undefined;
    const nextState = typeof secondStateOrUpdate === 'string' ? secondStateOrUpdate : firstState;
    const update = typeof secondStateOrUpdate === 'string' ? thirdUpdate : secondStateOrUpdate;
    this.ensureUsable();
    const record = this.findRecord(requestId);
    if (record === undefined) {
      return { ok: false, changed: false, code: 'not_found' };
    }
    if (nextState !== 'expired') {
      this.expireIfDue(record);
    }
    const current = record.snapshot;
    if (expectedState !== undefined && current.state !== expectedState) {
      return { ok: false, changed: false, code: 'invalid_transition', snapshot: current };
    }
    if (isTerminal(current.state)) {
      return { ok: false, changed: false, code: 'terminal', snapshot: current };
    }
    if (!canTransitionTaskState(current.state, nextState)) {
      return { ok: false, changed: false, code: 'invalid_transition', snapshot: current };
    }

    const nextIsTerminal = isTerminal(nextState);
    const previousState = current.state;
    const cancellation = this.nextCancellation(record, nextState, update);
    const timestamp = this.nextUpdatedAt(record, update.updatedAt);
    const response = this.responseForUpdate(update);
    const nextSnapshot = this.buildSnapshot({
      requestId: record.requestId,
      state: nextState,
      createdAt: current.createdAt,
      updatedAt: timestamp.value,
      expiresAt: current.expiresAt,
      cancellationRequested: cancellation.requested,
      requestedAt: cancellation.requestedAt,
      content: nextIsTerminal
        ? response.content
        : 'content' in update
          ? update.content
          : current.content,
      error: nextIsTerminal ? response.error : 'error' in update ? update.error : current.error,
      terminal: nextIsTerminal,
      terminalResponse: response,
    });

    // This is the linearization point. Everything below observes the new state.
    record.snapshot = nextSnapshot;
    record.updatedAtMs = timestamp.epochMs;
    if (nextState === 'queued') {
      this.queued.add(taskKey(record.requestId));
    } else {
      this.queued.delete(taskKey(record.requestId));
    }
    if (nextIsTerminal) {
      this.clearExpiry(record);
      this.schedulePurge(record);
    }

    if (nextState === 'cancelling' || nextState === 'cancelled' || nextState === 'expired') {
      this.abort(record, updateReason(update));
    }
    this.notifyStateChange({
      requestId: record.requestId,
      from: previousState,
      to: nextState,
      snapshot: nextSnapshot,
    });
    if (nextState === 'expired') {
      this.notifyExpired(nextSnapshot);
    }
    if (nextState === 'cancelling') {
      this.notifyCancellation(record, nextSnapshot, updateReason(update));
    }

    return { ok: true, changed: true, previousState, snapshot: nextSnapshot };
  }

  /** Snapshot-returning transition API for simple router/lifecycle callers. */
  transition(
    requestId: TaskRequestKey,
    nextState: TaskState,
    update?: TaskTransitionUpdate,
  ): TaskSnapshot | undefined;
  transition(
    requestId: TaskRequestKey,
    expectedState: TaskState,
    nextState: TaskState,
    update?: TaskTransitionUpdate,
  ): TaskSnapshot | undefined;
  transition(
    requestId: TaskRequestKey,
    firstState: TaskState,
    secondStateOrUpdate: TaskState | TaskTransitionUpdate = {},
    thirdUpdate: TaskTransitionUpdate = {},
  ): TaskSnapshot | undefined {
    const result =
      typeof secondStateOrUpdate === 'string'
        ? this.tryTransition(requestId, firstState, secondStateOrUpdate, thirdUpdate)
        : this.tryTransition(requestId, firstState, secondStateOrUpdate);
    return result.ok ? result.snapshot : undefined;
  }

  transitionOrThrow(
    requestId: TaskRequestKey,
    nextState: TaskState,
    update: TaskTransitionUpdate = {},
  ): TaskSnapshot {
    const result = this.tryTransition(requestId, nextState, update);
    if (result.ok) {
      return result.snapshot;
    }
    if (result.code === 'not_found') {
      throw new TaskStoreError(
        'not_found',
        `task ${String(requestId)} was not found`,
        requestId as RequestId,
      );
    }
    throw new TaskStoreError(
      result.code,
      `cannot transition task ${String(requestId)} from ${result.snapshot?.state ?? 'unknown'} to ${nextState}`,
      requestId as RequestId,
      result.snapshot,
    );
  }

  update(
    requestId: TaskRequestKey,
    nextState: TaskState,
    update: TaskTransitionUpdate = {},
  ): TaskSnapshot | undefined {
    return this.transition(requestId, nextState, update);
  }

  completeTask(
    requestId: TaskRequestKey,
    contentOrUpdate?: Content | TaskTransitionUpdate,
  ): TaskSnapshot | undefined {
    return this.transition(requestId, 'completed', toTransitionUpdate(contentOrUpdate));
  }

  complete(
    requestId: TaskRequestKey,
    contentOrUpdate?: Content | TaskTransitionUpdate,
  ): TaskSnapshot | undefined {
    return this.completeTask(requestId, contentOrUpdate);
  }

  failTask(
    requestId: TaskRequestKey,
    errorOrUpdate?: ProtocolError | TaskTransitionUpdate,
  ): TaskSnapshot | undefined {
    return this.transition(requestId, 'failed', toTransitionUpdate(errorOrUpdate, 'error'));
  }

  fail(
    requestId: TaskRequestKey,
    errorOrUpdate?: ProtocolError | TaskTransitionUpdate,
  ): TaskSnapshot | undefined {
    return this.failTask(requestId, errorOrUpdate);
  }

  rejectTask(
    requestId: TaskRequestKey,
    errorOrUpdate?: ProtocolError | TaskTransitionUpdate,
  ): TaskSnapshot | undefined {
    return this.transition(requestId, 'rejected', toTransitionUpdate(errorOrUpdate, 'error'));
  }

  reject(
    requestId: TaskRequestKey,
    errorOrUpdate?: ProtocolError | TaskTransitionUpdate,
  ): TaskSnapshot | undefined {
    return this.rejectTask(requestId, errorOrUpdate);
  }

  expireTask(requestId: TaskRequestKey): TaskSnapshot | undefined {
    const record = this.findRecord(requestId);
    if (record === undefined) {
      return undefined;
    }
    const result = this.tryTransition(record.requestId, 'expired', {
      error: createProtocolError('expired', 'task deadline expired'),
    });
    return result.snapshot;
  }

  expire(requestId: TaskRequestKey): TaskSnapshot | undefined {
    return this.expireTask(requestId);
  }

  /**
   * Request cooperative cancellation. Queued/accepted work commits directly
   * to cancelled; working work first commits cancelling and aborts only its
   * own signal. Repeated cancellation is idempotent for cancelled tasks.
   */
  cancelTask(
    requestId: TaskRequestKey,
    callerOrOptions?: TaskCaller | CancellationRequestOptions,
  ): TaskCancellationResult {
    this.ensureUsable();
    const request = parseCancellationRequest(callerOrOptions);
    const record = this.findRecord(requestId);
    if (record === undefined) {
      return {
        ok: false,
        changed: false,
        code: request.caller === undefined ? 'not_found' : 'unauthorized',
      };
    }
    this.expireIfDue(record);
    if (request.caller !== undefined && !this.isAuthorized(record, request.caller, 'cancel')) {
      return { ok: false, changed: false, code: 'unauthorized' };
    }

    const state = record.snapshot.state;
    if (state === 'cancelled') {
      return { ok: true, changed: false, state, snapshot: record.snapshot };
    }
    if (isTerminal(state)) {
      return { ok: false, changed: false, code: 'not_cancelable', snapshot: record.snapshot };
    }

    const requestedAt = request.requestedAt ?? new Date(this.currentNow());
    if (state === 'working') {
      const result = this.tryTransition(record.requestId, 'cancelling', {
        cancellationRequested: true,
        requestedAt,
        reason: request.reason,
      });
      if (!result.ok) {
        return {
          ok: false,
          changed: false,
          code: cancellationFailureCode(result.code),
          snapshot: result.snapshot,
        };
      }
      return { ok: true, changed: true, state: 'cancelling', snapshot: result.snapshot };
    }

    const result = this.tryTransition(record.requestId, 'cancelled', {
      cancellationRequested: true,
      requestedAt,
      ...(request.reason === undefined
        ? {}
        : { error: createProtocolError('cancelled', request.reason) }),
    });
    if (!result.ok) {
      return {
        ok: false,
        changed: false,
        code: cancellationFailureCode(result.code),
        snapshot: result.snapshot,
      };
    }
    return { ok: true, changed: true, state: 'cancelled', snapshot: result.snapshot };
  }

  cancel(
    requestId: TaskRequestKey,
    callerOrOptions?: TaskCaller | CancellationRequestOptions,
  ): TaskCancellationResult {
    return this.cancelTask(requestId, callerOrOptions);
  }

  requestCancellation(
    requestId: TaskRequestKey,
    callerOrOptions?: TaskCaller | CancellationRequestOptions,
  ): TaskCancellationResult {
    return this.cancelTask(requestId, callerOrOptions);
  }

  /** Remove a retained terminal task; active tasks cannot be purged. */
  purgeTask(requestId: TaskRequestKey): boolean {
    const key = taskKey(requestId);
    const record = this.records.get(key);
    if (record === undefined || !isTerminal(record.snapshot.state)) {
      return false;
    }
    this.removeRecord(key, record);
    return true;
  }

  purge(requestId: TaskRequestKey): boolean {
    return this.purgeTask(requestId);
  }

  listSnapshots(options: SnapshotReadOptions = {}): readonly TaskSnapshot[] {
    const snapshots: TaskSnapshot[] = [];
    for (const record of this.records.values()) {
      this.expireIfDue(record);
      if (options.caller !== undefined && !this.isAuthorized(record, options.caller, 'status')) {
        continue;
      }
      snapshots.push(this.projectSnapshot(record.snapshot, options.includeTerminalResponse));
    }
    return Object.freeze(snapshots);
  }

  clear(): void {
    for (const record of this.records.values()) {
      this.clearTimers(record);
      if (!record.controller.signal.aborted) {
        record.controller.abort('task store cleared');
      }
    }
    this.records.clear();
    this.queued.clear();
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.clear();
    this.disposed = true;
  }

  destroy(): void {
    this.dispose();
  }

  private ensureUsable(): void {
    if (this.disposed) {
      throw new TaskStoreError('disposed', 'task store is disposed');
    }
  }

  private currentNow(): number {
    const value = this.nowFn();
    if (!Number.isFinite(value)) {
      throw new RangeError('task store clock must return a finite epoch');
    }
    return value;
  }

  private currentMonotonic(): number {
    const value = this.monotonicNowFn();
    if (!Number.isFinite(value)) {
      throw new RangeError('task store monotonic clock must return a finite value');
    }
    return value;
  }

  private findRecord(requestId: TaskRequestKey): StoredTask | undefined {
    return this.records.get(taskKey(requestId));
  }

  private readOptions(options: SnapshotReadOptions | TaskCaller | undefined): SnapshotReadOptions {
    if (options === undefined) {
      return {};
    }
    if (typeof options === 'string') {
      return { caller: options };
    }
    if (typeof options === 'object' && options !== null && 'runtimeId' in options) {
      return { caller: options };
    }
    return options;
  }

  private isAuthorized(
    record: StoredTask,
    caller: TaskCaller,
    action: TaskAuthorizationAction,
  ): boolean {
    const callerRuntimeId = runtimeIdOf(caller);
    if (callerRuntimeId === undefined) {
      return false;
    }
    if (
      callerRuntimeId === record.owner.runtimeId ||
      callerRuntimeId === this.localOwnerRuntimeId
    ) {
      return true;
    }
    return (
      this.authorize?.({
        requestId: record.requestId,
        action,
        owner: record.owner,
        callerRuntimeId: callerRuntimeId as RuntimeId,
      }) ?? false
    );
  }

  private buildSnapshot(input: {
    readonly requestId: RequestId;
    readonly state: TaskState;
    readonly createdAt: UtcTimestamp;
    readonly updatedAt: UtcTimestamp;
    readonly expiresAt: UtcTimestamp;
    readonly cancellationRequested: boolean;
    readonly requestedAt?: UtcTimestamp;
    readonly content?: Content;
    readonly error?: ProtocolError;
    readonly terminal: boolean;
    readonly terminalResponse: TaskResponse;
  }): TaskSnapshot {
    const fields: Record<string, unknown> = {
      requestId: input.requestId,
      state: input.state,
      createdAt: input.createdAt,
      updatedAt: input.updatedAt,
      expiresAt: input.expiresAt,
      cancellationRequested: input.cancellationRequested,
    };
    if (input.cancellationRequested) {
      fields.cancellation = {
        state: 'requested',
        ...(input.requestedAt === undefined ? {} : { requestedAt: input.requestedAt }),
      };
    }
    if (input.terminal) {
      fields.terminalOutcome = input.state;
      if (this.retainTerminalResponse) {
        if (input.terminalResponse.content !== undefined || input.content !== undefined) {
          fields.content = input.terminalResponse.content ?? input.content;
        }
        if (input.terminalResponse.error !== undefined || input.error !== undefined) {
          fields.error = input.terminalResponse.error ?? input.error;
        }
      }
    } else {
      if (input.content !== undefined) {
        fields.content = input.content;
      }
      if (input.error !== undefined) {
        fields.error = input.error;
      }
    }
    return cloneAndFreeze(fields) as unknown as TaskSnapshot;
  }

  private projectSnapshot(snapshot: TaskSnapshot, includeTerminalResponse = true): TaskSnapshot {
    if (!isTerminal(snapshot.state) || includeTerminalResponse) {
      return snapshot;
    }
    const projected: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(snapshot)) {
      if (key !== 'content' && key !== 'error') {
        projected[key] = value;
      }
    }
    return cloneAndFreeze(projected) as unknown as TaskSnapshot;
  }

  private nextCancellation(
    record: StoredTask,
    nextState: TaskState,
    update: TaskTransitionUpdate,
  ): { readonly requested: boolean; readonly requestedAt?: UtcTimestamp } {
    const current = record.snapshot;
    const requested =
      current.cancellationRequested ||
      update.cancellationRequested === true ||
      nextState === 'cancelling';
    let requestedAt = current.cancellation?.requestedAt;
    if (requested && !current.cancellationRequested) {
      requestedAt = normalizeTimestamp(update.requestedAt ?? new Date(this.currentNow())).value;
    } else if (requested && update.requestedAt !== undefined) {
      requestedAt = normalizeTimestamp(update.requestedAt).value;
    }
    return { requested, requestedAt };
  }

  private nextUpdatedAt(
    record: StoredTask,
    value: TaskTimestampInput | undefined,
  ): NormalizedTimestamp {
    const now = this.currentNow();
    const candidate = value === undefined ? nowTimestamp(now) : normalizeTimestamp(value);
    const epochMs = Math.max(record.updatedAtMs, candidate.epochMs);
    return epochMs === candidate.epochMs ? candidate : nowTimestamp(epochMs);
  }

  private responseForUpdate(update: TaskTransitionUpdate): TaskResponse {
    return update.response ?? { content: update.content, error: update.error };
  }

  private scheduleExpiry(record: StoredTask): void {
    const delayMs = Math.max(0, record.deadlineMonotonicMs - this.currentMonotonic());
    if (delayMs === 0) {
      this.expireRecord(record);
      return;
    }
    record.expiryTimer = this.scheduleTimer(() => {
      record.expiryTimer = undefined;
      this.expireRecord(record);
    }, delayMs);
  }

  private expireIfDue(record: StoredTask): void {
    if (
      !isTerminal(record.snapshot.state) &&
      this.currentMonotonic() >= record.deadlineMonotonicMs
    ) {
      this.expireRecord(record);
    }
  }

  private expireRecord(record: StoredTask): void {
    if (!this.records.has(taskKey(record.requestId)) || isTerminal(record.snapshot.state)) {
      return;
    }
    this.tryTransition(record.requestId, 'expired', {
      error: createProtocolError('expired', 'task deadline expired'),
    });
  }

  private schedulePurge(record: StoredTask): void {
    if (!Number.isFinite(this.terminalRetentionMs)) {
      return;
    }
    record.purgeTimer = this.scheduleTimer(() => {
      record.purgeTimer = undefined;
      if (isTerminal(record.snapshot.state)) {
        this.removeRecord(taskKey(record.requestId), record);
      }
    }, this.terminalRetentionMs);
  }

  private clearExpiry(record: StoredTask): void {
    if (record.expiryTimer !== undefined) {
      this.cancelTimer(record.expiryTimer);
      record.expiryTimer = undefined;
    }
  }

  private clearTimers(record: StoredTask): void {
    this.clearExpiry(record);
    if (record.purgeTimer !== undefined) {
      this.cancelTimer(record.purgeTimer);
      record.purgeTimer = undefined;
    }
  }

  private removeRecord(key: string, record: StoredTask): void {
    this.clearTimers(record);
    this.records.delete(key);
    this.queued.delete(key);
  }

  private abort(record: StoredTask, reason: unknown): void {
    if (!record.controller.signal.aborted) {
      record.controller.abort(reason);
    }
  }

  private notifyStateChange(event: TaskStateChangeEvent): void {
    try {
      this.onStateChange?.(event);
    } catch {
      // Hooks are observers; an observer cannot roll back a committed state.
    }
  }

  private notifyCancellation(record: StoredTask, snapshot: TaskSnapshot, reason?: string): void {
    try {
      this.onCancellationRequested?.({
        requestId: record.requestId,
        owner: record.owner,
        snapshot,
        signal: record.controller.signal,
        ...(reason === undefined ? {} : { reason }),
      });
    } catch {
      // Cancellation has already been committed and signalled.
    }
  }

  private notifyExpired(snapshot: TaskSnapshot): void {
    if (snapshot.state !== 'expired') {
      return;
    }
    try {
      this.onExpired?.(snapshot);
    } catch {
      // Expiry remains committed even if an observer fails.
    }
  }
}

function toTransitionUpdate(
  value: Content | TaskTransitionUpdate | ProtocolError | undefined,
  property?: 'error',
): TaskTransitionUpdate {
  if (value === undefined) {
    return {};
  }
  if (isContent(value)) {
    return { content: value };
  }
  if (property === 'error' && typeof value === 'object' && 'code' in value) {
    return { error: value as ProtocolError };
  }
  return value as TaskTransitionUpdate;
}

function cancellationFailureCode(
  code: TaskTransitionFailure['code'],
): TaskCancellationFailure['code'] {
  if (code === 'not_found') {
    return code;
  }
  return 'not_cancelable';
}

function updateReason(update: TaskTransitionUpdate): string | undefined {
  return update.reason ?? update.error?.message;
}

export function createTaskStore(options: TaskStoreOptions = {}): TaskStore {
  return new TaskStore(options);
}
