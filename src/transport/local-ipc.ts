/**
 * Minimal local binding for the transport-independent adapter contract.
 *
 * The binding intentionally does not choose a socket, framing, serializer, or
 * authentication scheme.  Values are delivered directly to hooks registered in
 * one process, which gives lifecycle and integration code a deterministic
 * boundary without putting concrete framing into `transport.ts`.
 */
import {
  DEFAULT_REQUEST_TTL_MS,
  DEDUPE_RETENTION_GRACE_MS,
  MAX_REQUEST_TTL_MS,
} from '../config.js';
import {
  runtimeDestinationGuardStateFor,
  runtimeOperationGuardKey,
  RUNTIME_ID_GUARD_RETENTION_MS,
  sharedRuntimeOperationGuardState,
  type AcceptedOperationRecord,
  type RuntimeDestinationGuardRecord,
  type RuntimeIdentityHistory,
  type RuntimeOperationGuardState,
  type RuntimePersistence,
  type RuntimeUnreachableResult,
  type UnreachableRecord,
} from '../pi/persistence.js';
import { createProtocolError } from '../protocol/errors.js';

import type {
  TransportAdapter,
  TransportDeliveryErrorCode,
  TransportDeliveryFailure,
  TransportDeliveryResult,
  TransportDeliverySuccess,
  TransportEnvelope,
  TransportInboundEnvelope,
  TransportInboundHooks,
  TransportInboundResponse,
  TransportOperationResponse,
  TransportRuntimeTarget,
  TransportBinding,
} from './transport.js';

export type LocalIpcEndpoint = string;
export type LocalIpcRuntimeTarget = TransportRuntimeTarget<LocalIpcEndpoint>;

export interface LocalIpcShutdownNotice {
  readonly runtimeId: string;
  readonly endpoint: LocalIpcEndpoint;
  readonly graceful: true;
  readonly reason: string;
  readonly source: LocalIpcRuntimeTarget;
}

export interface LocalIpcInboundHooks<
  Envelope extends TransportEnvelope = TransportEnvelope,
  Response extends TransportOperationResponse = TransportOperationResponse,
> extends TransportInboundHooks<Envelope, Response, LocalIpcEndpoint> {
  /** Best-effort local signal emitted when a peer closes gracefully. */
  readonly onShutdown?: (notice: LocalIpcShutdownNotice) => void | PromiseLike<void>;
}

export type LocalIpcSetTimeout = (callback: () => void, delayMs: number) => unknown;
export type LocalIpcClearTimeout = (handle: unknown) => void;

export interface LocalIpcRegistryOptions {
  readonly now?: () => number;
  readonly setTimeout?: LocalIpcSetTimeout;
  readonly clearTimeout?: LocalIpcClearTimeout;
  /** Retain operation destinations after their envelope deadline. */
  readonly retentionGraceMs?: number;
  /** Retain retired runtime IDs long enough to reject stale reuse. */
  readonly runtimeIdRetentionMs?: number;
  /** Explicit state shared with the owning persistence boundary. */
  readonly operationGuardState?: RuntimeOperationGuardState;
  /** Identity history shared by replacement registry instances. */
  readonly runtimeIdentityHistory?: RuntimeIdentityHistory;
  /** Runtime identity allowed to bind against an already-issued live history entry. */
  readonly currentRuntimeId?: string;
}

export interface LocalIpcTransportOptions {
  /** Inject a registry to connect multiple adapter instances in one process. */
  readonly registry?: LocalIpcRegistry;
  /** Bound hook wait time; a stalled hook is surfaced as `unreachable`. */
  readonly deliveryTimeoutMs?: number;
  /** Runtime-owned accepted/unreachable operation store. */
  readonly persistence?: RuntimePersistence;
  /** Compatibility alias for persistence. */
  readonly runtimePersistence?: RuntimePersistence;
  readonly now?: () => number;
  readonly setTimeout?: LocalIpcSetTimeout;
  readonly clearTimeout?: LocalIpcClearTimeout;
  readonly retentionGraceMs?: number;
  /** Retain retired runtime identities in the shared replacement history. */
  readonly runtimeIdRetentionMs?: number;
  /** Explicit state shared with the owning persistence boundary. */
  readonly operationGuardState?: RuntimeOperationGuardState;
  /** Identity history shared by replacement registry instances. */
  readonly runtimeIdentityHistory?: RuntimeIdentityHistory;
}

export type LocalIpcBindingErrorCode =
  'closed' | 'invalid_target' | 'duplicate' | 'identity_conflict';

export class LocalIpcBindingError extends Error {
  readonly code: LocalIpcBindingErrorCode;

  public constructor(code: LocalIpcBindingErrorCode, message: string) {
    super(message);
    this.name = 'LocalIpcBindingError';
    this.code = code;
  }
}

class LocalIpcDeliveryTimeout extends Error {
  public constructor() {
    super('local IPC delivery hook did not settle before its deadline');
    this.name = 'LocalIpcDeliveryTimeout';
  }
}

class LocalIpcDeliveryStale extends Error {
  public constructor() {
    super('local IPC delivery belongs to a stale runtime generation');
    this.name = 'LocalIpcDeliveryStale';
  }
}

type StoredHooks = LocalIpcInboundHooks;

type OperationDestinationRecord = RuntimeDestinationGuardRecord;

interface IssuedRuntimeRecord {
  readonly retired: boolean;
  readonly retainedUntil: number;
  timer?: unknown;
  clearTimeout?: LocalIpcClearTimeout;
}

interface LocalIpcRegistryRecord {
  readonly key: string;
  readonly target: LocalIpcRuntimeTarget;
  readonly hooks: StoredHooks;
  readonly generation: number;
  readonly inFlight: Set<Promise<unknown>>;
  active: boolean;
  closing: boolean;
}

const MAX_ENDPOINT_LENGTH = 16_384;
const MAX_IDENTIFIER_LENGTH = 256;
const DEFAULT_DELIVERY_TIMEOUT_MS = 10_000;
const MAX_TIMER_DELAY_MS = 2_147_483_647;
const MAX_LIFECYCLE_TIMEOUT_MS = MAX_REQUEST_TTL_MS;
const MAX_IN_FLIGHT_DELIVERIES = 64;
const MAX_IN_FLIGHT_HOOKS = 64;
const MAX_REGISTRY_RECORDS = 256;
const MAX_OPERATION_DESTINATIONS = 4_096;
const MAX_RUNTIME_ID_HISTORY_ENTRIES = 4_096;
const DEFAULT_RUNTIME_ID_RETENTION_MS = RUNTIME_ID_GUARD_RETENTION_MS;
const SHARED_RUNTIME_IDENTITY_HISTORY: RuntimeIdentityHistory = {
  issued: new Map<string, number>(),
  retentionMs: DEFAULT_RUNTIME_ID_RETENTION_MS,
};
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

function finiteClock(value: number): number {
  if (!Number.isFinite(value)) {
    throw new RangeError('local IPC clock must return a finite number');
  }
  return value;
}

function validateIdentifier(value: unknown, field: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MAX_IDENTIFIER_LENGTH ||
    /\p{C}/u.test(value)
  ) {
    throw new LocalIpcBindingError(
      'invalid_target',
      `${field} must be a bounded non-empty string without control characters`,
    );
  }
  return value;
}

function validateRetention(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < DEDUPE_RETENTION_GRACE_MS) {
    throw new RangeError(
      `${field} must be a safe integer of at least ${DEDUPE_RETENTION_GRACE_MS}`,
    );
  }
  return value;
}

function validateRuntimeIdRetention(
  value: number,
  field: string,
  minimum = RUNTIME_ID_GUARD_RETENTION_MS,
): number {
  if (value !== Infinity && (!Number.isSafeInteger(value) || value < minimum)) {
    throw new RangeError(`${field} must be Infinity or a safe integer of at least ${minimum}`);
  }
  return value;
}

function operationDeadline(value: unknown, nowMs: number): number {
  if (value === undefined) {
    const defaultDeadline = nowMs + DEFAULT_REQUEST_TTL_MS;
    if (!Number.isSafeInteger(defaultDeadline)) {
      throw new LocalIpcBindingError(
        'invalid_target',
        'operation deadline is not a safe timestamp',
      );
    }
    return defaultDeadline;
  }
  if (typeof value !== 'string' && typeof value !== 'number' && !(value instanceof Date)) {
    throw new LocalIpcBindingError('invalid_target', 'operation deadline must be a timestamp');
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
    throw new LocalIpcBindingError(
      'invalid_target',
      'operation deadline must be a finite safe timestamp',
    );
  }
  if (parsed <= nowMs) {
    throw new LocalIpcBindingError('invalid_target', 'operation deadline is already elapsed');
  }
  if (parsed > nowMs + MAX_REQUEST_TTL_MS) {
    throw new LocalIpcBindingError(
      'invalid_target',
      'operation deadline exceeds the v1 deadline horizon',
    );
  }
  return parsed;
}

function retentionDeadline(value: unknown, nowMs: number, graceMs: number): number {
  const retainedUntil =
    operationDeadline(value, nowMs) + validateRetention(graceMs, 'retentionGraceMs');
  if (!Number.isSafeInteger(retainedUntil)) {
    throw new LocalIpcBindingError(
      'invalid_target',
      'operation retention deadline must be a safe timestamp',
    );
  }
  return retainedUntil;
}

function removeSharedAcceptedOperation(
  state: RuntimeOperationGuardState,
  operationKey: string,
  record: AcceptedOperationRecord,
  clearTimeoutFn: LocalIpcClearTimeout,
): void {
  if (state.acceptedOperations.get(operationKey) !== record) {
    return;
  }
  if (record.timer !== undefined) {
    (record.clearTimeout ?? clearTimeoutFn)(record.timer);
    record.timer = undefined;
  }
  state.acceptedOperations.delete(operationKey);
}

function removeSharedUnreachableResult(
  state: RuntimeOperationGuardState,
  operationKey: string,
  record: UnreachableRecord,
  clearTimeoutFn: LocalIpcClearTimeout,
): void {
  if (state.unreachableResults.get(operationKey) !== record) {
    return;
  }
  if (record.timer !== undefined) {
    (record.clearTimeout ?? clearTimeoutFn)(record.timer);
    record.timer = undefined;
  }
  state.unreachableResults.delete(operationKey);
}

function pruneSharedOperationGuards(
  state: RuntimeOperationGuardState,
  nowMs: number,
  clearTimeoutFn: LocalIpcClearTimeout,
): void {
  for (const [operationKey, record] of state.acceptedOperations) {
    if (record.retainedUntil <= nowMs) {
      removeSharedAcceptedOperation(state, operationKey, record, clearTimeoutFn);
    }
  }
  for (const [operationKey, record] of state.unreachableResults) {
    if (record.retainedUntil <= nowMs) {
      removeSharedUnreachableResult(state, operationKey, record, clearTimeoutFn);
    }
  }
}
function validateEndpoint(value: unknown): LocalIpcEndpoint {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MAX_ENDPOINT_LENGTH ||
    value.trim().length === 0 ||
    /\p{C}/u.test(value)
  ) {
    throw new LocalIpcBindingError(
      'invalid_target',
      'local IPC endpoint must be bounded non-empty text without control characters',
    );
  }
  return value;
}

function validateTarget(value: unknown): LocalIpcRuntimeTarget {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new LocalIpcBindingError('invalid_target', 'local IPC target must be an object');
  }
  const candidate = value as { readonly runtimeId?: unknown; readonly endpoint?: unknown };
  const runtimeId = validateIdentifier(candidate.runtimeId, 'local IPC target runtimeId');
  const endpoint = validateEndpoint(candidate.endpoint);
  return Object.freeze({
    runtimeId,
    endpoint,
  });
}

function targetKey(target: LocalIpcRuntimeTarget): string {
  return `${target.runtimeId}\u0000${target.endpoint}`;
}

function targetCopy(target: LocalIpcRuntimeTarget): LocalIpcRuntimeTarget {
  return Object.freeze({ runtimeId: target.runtimeId, endpoint: target.endpoint });
}

function operationIdOf(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null || !('operationId' in value)) {
    return undefined;
  }
  return validateIdentifier(
    (value as { readonly operationId?: unknown }).operationId,
    'operationId',
  );
}

function senderRuntimeIdOf(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null || !('sender' in value)) {
    return undefined;
  }
  const sender = (value as { readonly sender?: unknown }).sender;
  if (typeof sender !== 'object' || sender === null || !('runtimeId' in sender)) {
    throw new LocalIpcBindingError('invalid_target', 'sender runtimeId is required');
  }
  return validateIdentifier(
    (sender as { readonly runtimeId?: unknown }).runtimeId,
    'sender runtimeId',
  );
}

function sourceForRuntime(
  registry: LocalIpcRegistry,
  runtimeId: string | undefined,
  fallback: LocalIpcRuntimeTarget,
): LocalIpcRuntimeTarget {
  if (runtimeId === undefined) {
    return targetCopy(fallback);
  }
  return (
    registry.targetForRuntime(runtimeId) ??
    Object.freeze({
      runtimeId,
      endpoint: fallback.endpoint,
    })
  );
}

function failure<Endpoint>(
  code: TransportDeliveryErrorCode,
  message: string,
  target: TransportRuntimeTarget<Endpoint> | undefined,
  operationId: string | undefined,
  cause?: unknown,
): TransportDeliveryFailure<Endpoint> {
  return Object.freeze({
    status: 'failed',
    ...(operationId === undefined ? {} : { operationId }),
    error: Object.freeze({
      code,
      message,
      retryable: code === 'unreachable' || code === 'timeout',
      ...(target === undefined ? {} : { target }),
      ...(operationId === undefined ? {} : { operationId }),
      ...(cause === undefined ? {} : { cause }),
    }),
  });
}

function delivered(operationId: string | undefined): TransportDeliverySuccess {
  return Object.freeze({
    status: 'delivered',
    ...(operationId === undefined ? {} : { operationId }),
  });
}

function timeoutValue(value: number | undefined): number {
  const timeout = value ?? DEFAULT_DELIVERY_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeout) || timeout <= 0 || timeout > MAX_LIFECYCLE_TIMEOUT_MS) {
    throw new RangeError(
      `deliveryTimeoutMs must be a positive safe integer no greater than ${MAX_LIFECYCLE_TIMEOUT_MS}`,
    );
  }
  return timeout;
}

/**
 * A process-local endpoint registry.  It is a binding helper, not a protocol
 * registry: it stores only opaque endpoints, runtime IDs, and hook references.
 */
export class LocalIpcRegistry {
  private readonly records = new Map<string, LocalIpcRegistryRecord>();
  private readonly runtimes = new Map<string, LocalIpcRegistryRecord>();
  private readonly issuedRuntimeIds = new Map<string, IssuedRuntimeRecord>();
  private readonly operationDestinations: Map<string, OperationDestinationRecord>;
  public readonly operationGuardState: RuntimeOperationGuardState;
  public readonly runtimeIdentityHistory: RuntimeIdentityHistory;
  public readonly currentRuntimeId: string | undefined;
  private readonly now: () => number;
  private readonly setTimeout: LocalIpcSetTimeout;
  private readonly clearTimeout: LocalIpcClearTimeout;
  private readonly retentionGraceMs: number;
  private readonly runtimeIdRetentionMs: number;
  private nextGeneration = 0;

  public constructor(options: LocalIpcRegistryOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    this.setTimeout = options.setTimeout ?? defaultSetTimeout;
    this.clearTimeout = options.clearTimeout ?? defaultClearTimeout;
    this.operationGuardState = options.operationGuardState ?? sharedRuntimeOperationGuardState;
    this.operationDestinations = runtimeDestinationGuardStateFor(this.operationGuardState);
    const effectiveRetentionGrace = validateRetention(
      options.retentionGraceMs ?? DEDUPE_RETENTION_GRACE_MS,
      'retentionGraceMs',
    );
    const requiredRuntimeRetention = MAX_REQUEST_TTL_MS + effectiveRetentionGrace;
    const requestedRuntimeRetention = options.runtimeIdRetentionMs;
    this.runtimeIdentityHistory =
      options.runtimeIdentityHistory ??
      ((options.runtimeIdRetentionMs !== undefined &&
        options.runtimeIdRetentionMs !== DEFAULT_RUNTIME_ID_RETENTION_MS) ||
      effectiveRetentionGrace !== DEDUPE_RETENTION_GRACE_MS
        ? {
            issued: new Map<string, number>(),
            retentionMs: requestedRuntimeRetention ?? requiredRuntimeRetention,
          }
        : SHARED_RUNTIME_IDENTITY_HISTORY);
    const historyRetention = validateRuntimeIdRetention(
      this.runtimeIdentityHistory.retentionMs,
      'runtimeIdRetentionMs',
      requiredRuntimeRetention,
    );
    if (requestedRuntimeRetention !== undefined && requestedRuntimeRetention !== historyRetention) {
      throw new LocalIpcBindingError(
        'identity_conflict',
        'runtimeIdRetentionMs conflicts with the shared runtime identity history',
      );
    }
    this.retentionGraceMs = effectiveRetentionGrace;
    this.runtimeIdRetentionMs = historyRetention;
    this.currentRuntimeId =
      options.currentRuntimeId === undefined
        ? undefined
        : validateIdentifier(options.currentRuntimeId, 'current runtimeId');
    finiteClock(this.now());
  }

  public get size(): number {
    return this.records.size;
  }
  public get clock(): () => number {
    return this.now;
  }
  public get timerScheduler(): LocalIpcSetTimeout {
    return this.setTimeout;
  }
  public get timerClearer(): LocalIpcClearTimeout {
    return this.clearTimeout;
  }
  public get operationRetentionGraceMs(): number {
    return this.retentionGraceMs;
  }
  public get retiredRuntimeRetentionMs(): number {
    return this.runtimeIdRetentionMs;
  }

  public register<Envelope extends TransportEnvelope, Response extends TransportOperationResponse>(
    target: TransportRuntimeTarget<LocalIpcEndpoint>,
    hooks: LocalIpcInboundHooks<Envelope, Response>,
  ): LocalIpcRegistryRecord {
    this.prune();
    const normalizedTarget = validateTarget(target);
    const key = targetKey(normalizedTarget);
    const nowMs = finiteClock(this.now());
    if (this.records.size >= MAX_REGISTRY_RECORDS && !this.records.has(key)) {
      throw new LocalIpcBindingError(
        'duplicate',
        'local IPC registry capacity is temporarily exhausted',
      );
    }
    const issuedUntil = this.runtimeIdentityHistory.issued.get(normalizedTarget.runtimeId);
    const currentIdentityMayBind =
      issuedUntil === Infinity &&
      (this.currentRuntimeId === normalizedTarget.runtimeId ||
        this.runtimes.get(normalizedTarget.runtimeId) === undefined);
    if (
      this.runtimeIdentityHistory.issued.size >= MAX_RUNTIME_ID_HISTORY_ENTRIES &&
      issuedUntil === undefined
    ) {
      throw new LocalIpcBindingError(
        'duplicate',
        'runtime identity history capacity is temporarily exhausted',
      );
    }
    if (
      this.records.has(key) ||
      this.runtimes.has(normalizedTarget.runtimeId) ||
      (issuedUntil !== undefined && issuedUntil > nowMs && !currentIdentityMayBind)
    ) {
      throw new LocalIpcBindingError(
        'duplicate',
        'one runtime may own only one live local IPC endpoint and retired runtime IDs cannot be reused',
      );
    }
    const record: LocalIpcRegistryRecord = {
      key,
      target: normalizedTarget,
      hooks: hooks as unknown as StoredHooks,
      generation: ++this.nextGeneration,
      inFlight: new Set(),
      active: true,
      closing: false,
    };
    this.records.set(key, record);
    this.runtimes.set(normalizedTarget.runtimeId, record);
    this.runtimeIdentityHistory.issued.set(normalizedTarget.runtimeId, Infinity);
    this.issuedRuntimeIds.set(normalizedTarget.runtimeId, {
      retired: false,
      retainedUntil: Infinity,
    });
    return record;
  }

  public resolve(
    target: TransportRuntimeTarget<LocalIpcEndpoint>,
  ): LocalIpcRegistryRecord | undefined {
    this.prune();
    let normalizedTarget: LocalIpcRuntimeTarget;
    try {
      normalizedTarget = validateTarget(target);
    } catch {
      return undefined;
    }
    const record = this.records.get(targetKey(normalizedTarget));
    return record !== undefined && this.isCurrent(record, normalizedTarget) ? record : undefined;
  }

  public targetForRuntime(runtimeId: string): LocalIpcRuntimeTarget | undefined {
    this.prune();
    const record = this.runtimes.get(runtimeId);
    return record !== undefined && this.isCurrent(record) ? record.target : undefined;
  }

  public list(): readonly LocalIpcRuntimeTarget[] {
    this.prune();
    return Object.freeze(
      [...this.records.values()]
        .filter((record) => this.isCurrent(record))
        .map((record) => record.target),
    );
  }

  public isCurrent(
    record: LocalIpcRegistryRecord,
    target: LocalIpcRuntimeTarget = record.target,
  ): boolean {
    return (
      record.active &&
      !record.closing &&
      this.records.get(record.key) === record &&
      this.runtimes.get(record.target.runtimeId) === record &&
      targetKey(record.target) === targetKey(target)
    );
  }

  /** Mark a record closing before draining any hook already in flight. */
  public deactivate(record: LocalIpcRegistryRecord): boolean {
    if (this.records.get(record.key) !== record) {
      return false;
    }
    record.active = false;
    record.closing = true;
    return true;
  }

  /** Reserve the first destination for a sender/runtime operation. */
  public reserveOperation(
    senderRuntimeId: string,
    operationId: string,
    recipientRuntimeId: string,
    expiresAt?: unknown,
  ): RouteReservation | null {
    const normalizedSender = validateIdentifier(senderRuntimeId, 'sender runtimeId');
    const normalizedOperation = validateIdentifier(operationId, 'operationId');
    const normalizedRecipient = validateIdentifier(recipientRuntimeId, 'recipient runtimeId');
    const nowMs = finiteClock(this.now());
    const retainedUntil = retentionDeadline(expiresAt, nowMs, this.retentionGraceMs);
    this.prune(nowMs);
    const key = runtimeOperationGuardKey(normalizedSender, normalizedOperation);
    const sharedUnreachable = this.operationGuardState.unreachableResults.get(key);
    if (sharedUnreachable !== undefined) {
      if (sharedUnreachable.recipientRuntimeId !== normalizedRecipient) {
        return null;
      }
      return {
        key,
        created: false,
        terminal: 'unreachable',
        unreachableMessage: sharedUnreachable.message,
      };
    }
    const sharedAccepted = this.operationGuardState.acceptedOperations.get(key);
    if (sharedAccepted !== undefined) {
      if (
        sharedAccepted.stale ||
        sharedAccepted.senderRuntimeId !== normalizedSender ||
        sharedAccepted.value.recipientRuntimeId !== normalizedRecipient
      ) {
        sharedAccepted.stale = true;
        return null;
      }
    }
    const previous = this.operationDestinations.get(key);
    if (previous !== undefined) {
      if (
        previous.senderRuntimeId !== normalizedSender ||
        previous.generation !== normalizedSender ||
        previous.recipientRuntimeId !== normalizedRecipient
      ) {
        return null;
      }
      if (previous.state === 'unreachable') {
        return {
          key,
          created: false,
          terminal: 'unreachable',
          unreachableMessage: previous.unreachableMessage,
        };
      }
      if (previous.state === 'delivered') {
        return { key, created: false, terminal: 'delivered' };
      }
      return { key, created: false, terminal: 'pending' };
    }
    if (this.operationDestinations.size >= MAX_OPERATION_DESTINATIONS) {
      return null;
    }
    const record: OperationDestinationRecord = {
      senderRuntimeId: normalizedSender,
      operationId: normalizedOperation,
      recipientRuntimeId: normalizedRecipient,
      generation: normalizedSender,
      retainedUntil: sharedAccepted?.retainedUntil ?? retainedUntil,
      state: 'pending',
    };
    this.operationDestinations.set(key, record);
    this.scheduleOperationDestination(key, record);
    if (sharedAccepted === undefined) {
      if (this.operationGuardState.acceptedOperations.size >= MAX_OPERATION_DESTINATIONS) {
        this.removeOperationDestination(key, record);
        return null;
      }
      const accepted: AcceptedOperationRecord = {
        value: Object.freeze({
          operationId: normalizedOperation,
          recipientRuntimeId: normalizedRecipient,
          senderRuntimeId: normalizedSender,
          generation: normalizedSender,
        }),
        senderRuntimeId: normalizedSender,
        generation: normalizedSender,
        retainedUntil,
        stale: false,
      };
      this.operationGuardState.acceptedOperations.set(key, accepted);
      this.scheduleSharedAcceptedOperation(key, accepted);
    } else if (sharedAccepted.timer === undefined) {
      this.scheduleSharedAcceptedOperation(key, sharedAccepted);
    }
    return { key, created: sharedAccepted === undefined, terminal: 'pending' };
  }

  public markOperationUnreachable(
    senderRuntimeId: string,
    operationId: string,
    recipientRuntimeId: string,
    message: string,
    expiresAt?: unknown,
  ): OperationTerminalState {
    const reservation = this.reserveOperation(
      senderRuntimeId,
      operationId,
      recipientRuntimeId,
      expiresAt,
    );
    if (reservation === null) {
      throw new LocalIpcBindingError(
        'identity_conflict',
        'operation destination conflicts with an earlier runtime',
      );
    }
    if (reservation.terminal === 'delivered') {
      return 'delivered';
    }
    if (reservation.terminal === 'unreachable') {
      return 'unreachable';
    }
    const normalizedSender = validateIdentifier(senderRuntimeId, 'sender runtimeId');
    const normalizedOperation = validateIdentifier(operationId, 'operationId');
    const normalizedRecipient = validateIdentifier(recipientRuntimeId, 'recipient runtimeId');
    const normalizedMessage = validateIdentifier(message, 'unreachable message');
    const key = runtimeOperationGuardKey(normalizedSender, normalizedOperation);
    const sharedPrevious = this.operationGuardState.unreachableResults.get(key);
    if (sharedPrevious !== undefined) {
      if (
        sharedPrevious.recipientRuntimeId !== normalizedRecipient ||
        sharedPrevious.message !== normalizedMessage
      ) {
        throw new LocalIpcBindingError(
          'identity_conflict',
          'unreachable result is immutable for this operation destination',
        );
      }
      return 'unreachable';
    }
    const record = this.operationDestinations.get(key);
    if (record === undefined || record.state === 'delivered') {
      return record?.state ?? 'delivered';
    }
    if (record.state === 'unreachable') {
      if (record.unreachableMessage !== normalizedMessage) {
        throw new LocalIpcBindingError(
          'identity_conflict',
          'unreachable result is immutable for this operation destination',
        );
      }
      return 'unreachable';
    }
    record.state = 'unreachable';
    record.unreachableMessage = normalizedMessage;
    const accepted = this.operationGuardState.acceptedOperations.get(key);
    const retainedUntil = accepted?.retainedUntil ?? record.retainedUntil;
    if (this.operationGuardState.unreachableResults.size >= MAX_OPERATION_DESTINATIONS) {
      record.state = 'pending';
      record.unreachableMessage = undefined;
      throw new LocalIpcBindingError(
        'identity_conflict',
        'unreachable-result guard capacity is temporarily exhausted',
      );
    }
    const error = createProtocolError('unreachable', normalizedMessage, {
      details: { recipientRuntimeId: normalizedRecipient },
    });
    const result: RuntimeUnreachableResult = Object.freeze({
      status: 'unreachable',
      operationId: normalizedOperation,
      error: error as RuntimeUnreachableResult['error'],
      recipientRuntimeId: normalizedRecipient,
      senderRuntimeId: normalizedSender,
      generation: normalizedSender,
    });
    const sharedRecord: UnreachableRecord = {
      value: result,
      senderRuntimeId: normalizedSender,
      generation: normalizedSender,
      recipientRuntimeId: normalizedRecipient,
      message: normalizedMessage,
      retainedUntil,
    };
    this.operationGuardState.unreachableResults.set(key, sharedRecord);
    this.scheduleSharedUnreachableResult(key, sharedRecord);
    return 'unreachable';
  }

  public markOperationDelivered(
    senderRuntimeId: string,
    operationId: string,
    recipientRuntimeId: string,
  ): OperationTerminalState | undefined {
    const normalizedSender = validateIdentifier(senderRuntimeId, 'sender runtimeId');
    const normalizedOperation = validateIdentifier(operationId, 'operationId');
    const normalizedRecipient = validateIdentifier(recipientRuntimeId, 'recipient runtimeId');
    const key = runtimeOperationGuardKey(normalizedSender, normalizedOperation);
    const sharedUnreachable = this.operationGuardState.unreachableResults.get(key);
    if (sharedUnreachable?.recipientRuntimeId === normalizedRecipient) {
      return 'unreachable';
    }
    const record = this.operationDestinations.get(key);
    if (record === undefined || record.recipientRuntimeId !== normalizedRecipient) {
      return undefined;
    }
    if (record.state === 'unreachable') {
      return 'unreachable';
    }
    if (record.state === 'delivered') {
      return 'delivered';
    }
    record.state = 'delivered';
    return 'delivered';
  }
  public operationUnreachableMessage(
    senderRuntimeId: string,
    operationId: string,
    recipientRuntimeId: string,
  ): string | undefined {
    const normalizedSender = validateIdentifier(senderRuntimeId, 'sender runtimeId');
    const normalizedOperation = validateIdentifier(operationId, 'operationId');
    const normalizedRecipient = validateIdentifier(recipientRuntimeId, 'recipient runtimeId');
    const key = runtimeOperationGuardKey(normalizedSender, normalizedOperation);
    const sharedUnreachable = this.operationGuardState.unreachableResults.get(key);
    if (sharedUnreachable?.recipientRuntimeId === normalizedRecipient) {
      return sharedUnreachable.message;
    }
    const record = this.operationDestinations.get(key);
    return record?.recipientRuntimeId === normalizedRecipient && record.state === 'unreachable'
      ? record.unreachableMessage
      : undefined;
  }

  public prune(nowMs = finiteClock(this.now())): number {
    if (!Number.isFinite(nowMs)) {
      throw new RangeError('local IPC clock must return a finite number');
    }
    let removed = 0;
    pruneSharedOperationGuards(this.operationGuardState, nowMs, this.clearTimeout);
    for (const [runtimeId, retainedUntil] of this.runtimeIdentityHistory.issued) {
      if (retainedUntil <= nowMs && !this.issuedRuntimeIds.has(runtimeId)) {
        this.runtimeIdentityHistory.issued.delete(runtimeId);
        removed += 1;
      }
    }
    for (const [runtimeId, record] of this.issuedRuntimeIds) {
      if (record.retired && record.retainedUntil <= nowMs) {
        this.removeIssuedRuntimeId(runtimeId, record);
        removed += 1;
      }
    }
    for (const [key, record] of this.operationDestinations) {
      if (record.retainedUntil <= nowMs) {
        this.removeOperationDestination(key, record);
        removed += 1;
      }
    }
    return removed;
  }

  public cleanup(nowMs = finiteClock(this.now())): number {
    return this.prune(nowMs);
  }

  /**
   * Remove exactly one binding.  A delayed close from an old binding cannot
   * remove a replacement record because record identity is checked by reference.
   */
  public async unregister(
    record: LocalIpcRegistryRecord,
    notice?: LocalIpcShutdownNotice,
    timeoutMs = DEFAULT_DELIVERY_TIMEOUT_MS,
  ): Promise<boolean> {
    const boundedTimeout = timeoutValue(timeoutMs);
    if (this.records.get(record.key) !== record) {
      await this.drainRecord(record, boundedTimeout);
      return false;
    }
    this.deactivate(record);
    this.records.delete(record.key);
    if (this.runtimes.get(record.target.runtimeId) === record) {
      this.runtimes.delete(record.target.runtimeId);
    }
    this.retireRuntimeId(record.target.runtimeId);
    const peers = [...this.records.values()].filter((peer) => this.isCurrent(peer));
    const hookPromises: Promise<unknown>[] = [];
    if (notice !== undefined) {
      for (const peer of peers) {
        const onShutdown = peer.hooks.onShutdown;
        if (onShutdown === undefined || !this.hasHookCapacity(peer)) {
          continue;
        }
        const invocation = Promise.resolve().then(() => {
          // Recheck the exact generation immediately before invoking a snapshot peer.
          if (!this.isCurrent(peer, peer.target)) {
            throw new LocalIpcDeliveryStale();
          }
          return onShutdown(notice);
        });
        const tracked = this.trackRecord(peer, invocation);
        if (tracked !== undefined) {
          hookPromises.push(tracked);
        }
      }
    }
    await drainPromisesWithin(
      [...record.inFlight, ...hookPromises],
      boundedTimeout,
      this.setTimeout,
      this.clearTimeout,
    );
    return true;
  }

  public async closeAll(timeoutMs = DEFAULT_DELIVERY_TIMEOUT_MS): Promise<void> {
    const boundedTimeout = timeoutValue(timeoutMs);
    const records = [...this.records.values()];
    await Promise.all(records.map((record) => this.unregister(record, undefined, boundedTimeout)));
  }
  public hasHookCapacity(record: LocalIpcRegistryRecord): boolean {
    return this.isCurrent(record) && record.inFlight.size < MAX_IN_FLIGHT_HOOKS;
  }
  private trackRecord<T>(
    record: LocalIpcRegistryRecord,
    promise: Promise<T>,
  ): Promise<T> | undefined {
    if (!this.hasHookCapacity(record)) {
      return undefined;
    }
    const tracked = promise.finally(() => record.inFlight.delete(tracked));
    record.inFlight.add(tracked);
    return tracked;
  }

  private async drainRecord(record: LocalIpcRegistryRecord, timeoutMs: number): Promise<void> {
    await drainPromisesWithin([...record.inFlight], timeoutMs, this.setTimeout, this.clearTimeout);
  }

  private scheduleSharedAcceptedOperation(
    operationKey: string,
    record: AcceptedOperationRecord,
  ): void {
    if (record.timer !== undefined) {
      return;
    }
    const delay = record.retainedUntil - finiteClock(this.now());
    if (delay <= 0) {
      removeSharedAcceptedOperation(
        this.operationGuardState,
        operationKey,
        record,
        this.clearTimeout,
      );
      return;
    }
    record.clearTimeout = this.clearTimeout;
    record.timer = this.setTimeout(
      () => {
        record.timer = undefined;
        if (this.operationGuardState.acceptedOperations.get(operationKey) !== record) {
          return;
        }
        if (record.retainedUntil <= finiteClock(this.now())) {
          removeSharedAcceptedOperation(
            this.operationGuardState,
            operationKey,
            record,
            this.clearTimeout,
          );
        } else {
          this.scheduleSharedAcceptedOperation(operationKey, record);
        }
      },
      Math.min(delay, MAX_TIMER_DELAY_MS),
    );
    unrefTimer(record.timer);
  }

  private scheduleSharedUnreachableResult(operationKey: string, record: UnreachableRecord): void {
    if (record.timer !== undefined) {
      return;
    }
    const delay = record.retainedUntil - finiteClock(this.now());
    if (delay <= 0) {
      removeSharedUnreachableResult(
        this.operationGuardState,
        operationKey,
        record,
        this.clearTimeout,
      );
      return;
    }
    record.clearTimeout = this.clearTimeout;
    record.timer = this.setTimeout(
      () => {
        record.timer = undefined;
        if (this.operationGuardState.unreachableResults.get(operationKey) !== record) {
          return;
        }
        if (record.retainedUntil <= finiteClock(this.now())) {
          removeSharedUnreachableResult(
            this.operationGuardState,
            operationKey,
            record,
            this.clearTimeout,
          );
        } else {
          this.scheduleSharedUnreachableResult(operationKey, record);
        }
      },
      Math.min(delay, MAX_TIMER_DELAY_MS),
    );
    unrefTimer(record.timer);
  }

  private retireRuntimeId(runtimeId: string): void {
    const nowMs = finiteClock(this.now());
    const record: IssuedRuntimeRecord = {
      retired: true,
      retainedUntil:
        this.runtimeIdRetentionMs === Infinity ? Infinity : nowMs + this.runtimeIdRetentionMs,
    };
    const previous = this.issuedRuntimeIds.get(runtimeId);
    if (previous?.timer !== undefined) {
      (previous.clearTimeout ?? this.clearTimeout)(previous.timer);
    }
    this.issuedRuntimeIds.set(runtimeId, record);
    this.runtimeIdentityHistory.issued.set(runtimeId, record.retainedUntil);
    this.scheduleIssuedRuntimeId(runtimeId, record);
  }

  private scheduleIssuedRuntimeId(runtimeId: string, record: IssuedRuntimeRecord): void {
    const delay = record.retainedUntil - finiteClock(this.now());
    if (delay <= 0) {
      this.removeIssuedRuntimeId(runtimeId, record);
      return;
    }
    record.clearTimeout = this.clearTimeout;
    record.timer = this.setTimeout(
      () => {
        record.timer = undefined;
        if (this.issuedRuntimeIds.get(runtimeId) !== record || !record.retired) {
          return;
        }
        if (record.retainedUntil <= finiteClock(this.now())) {
          this.removeIssuedRuntimeId(runtimeId, record);
        } else {
          this.scheduleIssuedRuntimeId(runtimeId, record);
        }
      },
      Math.min(delay, MAX_TIMER_DELAY_MS),
    );
    unrefTimer(record.timer);
  }

  private scheduleOperationDestination(key: string, record: OperationDestinationRecord): void {
    const delay = record.retainedUntil - finiteClock(this.now());
    if (delay <= 0) {
      this.removeOperationDestination(key, record);
      return;
    }
    record.clearTimeout = this.clearTimeout;
    record.timer = this.setTimeout(
      () => {
        record.timer = undefined;
        if (this.operationDestinations.get(key) !== record) {
          return;
        }
        if (record.retainedUntil <= finiteClock(this.now())) {
          this.removeOperationDestination(key, record);
        } else {
          this.scheduleOperationDestination(key, record);
        }
      },
      Math.min(delay, MAX_TIMER_DELAY_MS),
    );
    unrefTimer(record.timer);
  }

  private removeIssuedRuntimeId(runtimeId: string, record: IssuedRuntimeRecord): void {
    if (this.issuedRuntimeIds.get(runtimeId) !== record) {
      return;
    }
    if (record.timer !== undefined) {
      (record.clearTimeout ?? this.clearTimeout)(record.timer);
      record.timer = undefined;
    }
    if (this.runtimeIdentityHistory.issued.get(runtimeId) === record.retainedUntil) {
      this.runtimeIdentityHistory.issued.delete(runtimeId);
    }
    this.issuedRuntimeIds.delete(runtimeId);
  }

  private removeOperationDestination(key: string, record: OperationDestinationRecord): void {
    if (this.operationDestinations.get(key) !== record) {
      return;
    }
    if (record.timer !== undefined) {
      (record.clearTimeout ?? this.clearTimeout)(record.timer);
      record.timer = undefined;
    }
    this.operationDestinations.delete(key);
  }
}

async function waitForHook<T>(
  hook: () => T | PromiseLike<T>,
  timeoutMs: number,
  setTimeoutFn: LocalIpcSetTimeout = defaultSetTimeout,
  clearTimeoutFn: LocalIpcClearTimeout = defaultClearTimeout,
): Promise<T> {
  const promise = Promise.resolve().then(hook);
  let timer: unknown;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeoutFn(() => reject(new LocalIpcDeliveryTimeout()), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) {
      clearTimeoutFn(timer);
    }
  }
}

async function drainPromisesWithin(
  promises: readonly Promise<unknown>[],
  timeoutMs: number,
  setTimeoutFn: LocalIpcSetTimeout,
  clearTimeoutFn: LocalIpcClearTimeout,
): Promise<void> {
  if (promises.length === 0) {
    return;
  }
  let timer: unknown;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeoutFn(resolve, timeoutMs);
  });
  try {
    await Promise.race([Promise.allSettled(promises), timeout]);
  } finally {
    if (timer !== undefined) {
      clearTimeoutFn(timer);
    }
  }
}

const DEFAULT_LOCAL_IPC_REGISTRY = new LocalIpcRegistry();

export function createLocalIpcRegistry(options: LocalIpcRegistryOptions = {}): LocalIpcRegistry {
  return new LocalIpcRegistry(options);
}

type OperationTerminalState = 'pending' | 'delivered' | 'unreachable';
interface RouteReservation {
  readonly key: string;
  readonly created: boolean;
  readonly terminal?: OperationTerminalState;
  readonly unreachableMessage?: string;
}

class LocalIpcBinding<
  Envelope extends TransportEnvelope,
  Response extends TransportOperationResponse,
> implements TransportBinding<LocalIpcEndpoint> {
  public readonly target: LocalIpcRuntimeTarget;
  private open = true;
  private closePromise: Promise<void> | undefined;

  public constructor(
    private readonly owner: LocalIpcTransport<Envelope, Response>,
    private readonly record: LocalIpcRegistryRecord,
  ) {
    this.target = record.target;
  }

  public close(): Promise<void> {
    if (this.closePromise !== undefined) {
      return this.closePromise;
    }
    this.open = false;
    this.closePromise = this.owner.closeBinding(this);
    return this.closePromise;
  }

  public get isOpen(): boolean {
    return this.open;
  }

  public get registryRecord(): LocalIpcRegistryRecord {
    return this.record;
  }
}

/**
 * Process-local implementation of the transport adapter boundary.
 *
 * A target is resolved by exact `(runtimeId, endpoint)` identity.  Missing or
 * stale targets never become successful sends: they return a typed,
 * retryable `unreachable` result.  The adapter also remembers which runtime
 * first received each operation ID and refuses to route that ID to a different
 * replacement runtime.
 */
export class LocalIpcTransport<
  Envelope extends TransportEnvelope = TransportEnvelope,
  Response extends TransportOperationResponse = TransportOperationResponse,
> implements TransportAdapter<Envelope, Response, LocalIpcEndpoint> {
  public readonly registry: LocalIpcRegistry;
  public readonly deliveryTimeoutMs: number;
  public readonly persistence: RuntimePersistence | undefined;

  private readonly bindings = new Set<LocalIpcBinding<Envelope, Response>>();
  private readonly inFlight = new Set<Promise<unknown>>();
  private readonly now: () => number;
  private readonly setTimeout: LocalIpcSetTimeout;
  private readonly clearTimeout: LocalIpcClearTimeout;
  private closedState = false;
  private closePromise: Promise<void> | undefined;

  public constructor(options: LocalIpcTransportOptions = {}) {
    if (
      options.persistence !== undefined &&
      options.runtimePersistence !== undefined &&
      options.persistence !== options.runtimePersistence
    ) {
      throw new LocalIpcBindingError(
        'identity_conflict',
        'persistence and runtimePersistence must reference the same boundary',
      );
    }
    const persistence = options.persistence ?? options.runtimePersistence;
    if (persistence !== undefined) {
      if (options.now !== undefined && options.now !== persistence.clock) {
        throw new LocalIpcBindingError(
          'identity_conflict',
          'local IPC and persistence clocks must be shared',
        );
      }
      if (options.setTimeout !== undefined && options.setTimeout !== persistence.timeoutScheduler) {
        throw new LocalIpcBindingError(
          'identity_conflict',
          'local IPC and persistence timer schedulers must be shared',
        );
      }
      if (
        options.clearTimeout !== undefined &&
        options.clearTimeout !== persistence.timeoutClearer
      ) {
        throw new LocalIpcBindingError(
          'identity_conflict',
          'local IPC and persistence timer clearers must be shared',
        );
      }
      if (
        options.retentionGraceMs !== undefined &&
        options.retentionGraceMs !== persistence.operationRetentionGraceMs
      ) {
        throw new LocalIpcBindingError(
          'identity_conflict',
          'local IPC and persistence retention grace must be shared',
        );
      }
      if (
        options.operationGuardState !== undefined &&
        options.operationGuardState !== persistence.operationGuardState
      ) {
        throw new LocalIpcBindingError(
          'identity_conflict',
          'local IPC and persistence operation guards must be shared',
        );
      }
      if (
        options.runtimeIdentityHistory !== undefined &&
        options.runtimeIdentityHistory !== persistence.runtimeIdentityHistory
      ) {
        throw new LocalIpcBindingError(
          'identity_conflict',
          'local IPC and persistence identity history must be shared',
        );
      }
      if (
        options.runtimeIdRetentionMs !== undefined &&
        options.runtimeIdRetentionMs !== persistence.runtimeIdentityHistory.retentionMs
      ) {
        throw new LocalIpcBindingError(
          'identity_conflict',
          'local IPC and persistence runtime ID retention must be shared',
        );
      }
    }
    const registry =
      options.registry ??
      new LocalIpcRegistry({
        now: options.now ?? persistence?.clock,
        setTimeout: options.setTimeout ?? persistence?.timeoutScheduler,
        clearTimeout: options.clearTimeout ?? persistence?.timeoutClearer,
        retentionGraceMs: options.retentionGraceMs ?? persistence?.operationRetentionGraceMs,
        runtimeIdRetentionMs:
          options.runtimeIdRetentionMs ?? persistence?.runtimeIdentityHistory.retentionMs,
        operationGuardState: options.operationGuardState ?? persistence?.operationGuardState,
        runtimeIdentityHistory:
          options.runtimeIdentityHistory ?? persistence?.runtimeIdentityHistory,
        currentRuntimeId: persistence?.runtimeId,
      });
    this.registry = registry;
    this.deliveryTimeoutMs = timeoutValue(options.deliveryTimeoutMs);
    this.persistence = persistence;
    this.now = options.now ?? registry.clock;
    this.setTimeout = options.setTimeout ?? registry.timerScheduler;
    this.clearTimeout = options.clearTimeout ?? registry.timerClearer;
    if (options.retentionGraceMs !== undefined) {
      validateRetention(options.retentionGraceMs, 'retentionGraceMs');
    }
    if (options.runtimeIdRetentionMs !== undefined) {
      validateRuntimeIdRetention(options.runtimeIdRetentionMs, 'runtimeIdRetentionMs');
    }
    if (
      options.now !== undefined &&
      options.registry !== undefined &&
      options.now !== registry.clock
    ) {
      throw new LocalIpcBindingError(
        'identity_conflict',
        'local IPC transport and registry clocks must be shared',
      );
    }
    if (
      options.setTimeout !== undefined &&
      options.registry !== undefined &&
      options.setTimeout !== registry.timerScheduler
    ) {
      throw new LocalIpcBindingError(
        'identity_conflict',
        'local IPC transport and registry timer schedulers must be shared',
      );
    }
    if (
      options.clearTimeout !== undefined &&
      options.registry !== undefined &&
      options.clearTimeout !== registry.timerClearer
    ) {
      throw new LocalIpcBindingError(
        'identity_conflict',
        'local IPC transport and registry timer clearers must be shared',
      );
    }
    if (
      options.retentionGraceMs !== undefined &&
      options.retentionGraceMs !== registry.operationRetentionGraceMs
    ) {
      throw new LocalIpcBindingError(
        'identity_conflict',
        'local IPC and registry retention grace must be shared',
      );
    }
    if (
      options.runtimeIdRetentionMs !== undefined &&
      options.runtimeIdRetentionMs !== registry.retiredRuntimeRetentionMs
    ) {
      throw new LocalIpcBindingError(
        'identity_conflict',
        'local IPC and registry runtime ID retention must be shared',
      );
    }
    if (
      options.operationGuardState !== undefined &&
      options.operationGuardState !== registry.operationGuardState
    ) {
      throw new LocalIpcBindingError(
        'identity_conflict',
        'local IPC and registry operation guards must be shared',
      );
    }
    if (
      options.runtimeIdentityHistory !== undefined &&
      options.runtimeIdentityHistory !== registry.runtimeIdentityHistory
    ) {
      throw new LocalIpcBindingError(
        'identity_conflict',
        'local IPC and registry identity history must be shared',
      );
    }
    if (persistence !== undefined) {
      if (registry.operationGuardState !== persistence.operationGuardState) {
        throw new LocalIpcBindingError(
          'identity_conflict',
          'local IPC registry and persistence operation guards must be shared',
        );
      }
      if (registry.runtimeIdentityHistory !== persistence.runtimeIdentityHistory) {
        throw new LocalIpcBindingError(
          'identity_conflict',
          'local IPC registry and persistence identity history must be shared',
        );
      }
      if (registry.operationRetentionGraceMs !== persistence.operationRetentionGraceMs) {
        throw new LocalIpcBindingError(
          'identity_conflict',
          'local IPC registry and persistence retention grace must be shared',
        );
      }
      if (registry.clock !== persistence.clock) {
        throw new LocalIpcBindingError(
          'identity_conflict',
          'local IPC registry and persistence clocks must be shared',
        );
      }
      if (registry.timerScheduler !== persistence.timeoutScheduler) {
        throw new LocalIpcBindingError(
          'identity_conflict',
          'local IPC registry and persistence timer schedulers must be shared',
        );
      }
      if (registry.timerClearer !== persistence.timeoutClearer) {
        throw new LocalIpcBindingError(
          'identity_conflict',
          'local IPC registry and persistence timer clearers must be shared',
        );
      }
    }
    finiteClock(this.now());
  }

  public get closed(): boolean {
    return this.closedState;
  }

  public get bound(): boolean {
    return this.bindings.size > 0;
  }

  public async bind(
    target: TransportRuntimeTarget<LocalIpcEndpoint>,
    hooks: LocalIpcInboundHooks<Envelope, Response>,
  ): Promise<TransportBinding<LocalIpcEndpoint>> {
    if (this.closedState) {
      throw new LocalIpcBindingError('closed', 'local IPC transport is closed');
    }
    const record = this.registry.register(target, hooks);
    const binding = new LocalIpcBinding(this, record);
    this.bindings.add(binding);
    return binding;
  }

  public sendEnvelope(
    target: TransportRuntimeTarget<LocalIpcEndpoint>,
    envelope: Envelope,
  ): Promise<TransportDeliveryResult<LocalIpcEndpoint>> {
    if (this.closedState) {
      let operationId: string | undefined;
      try {
        operationId = operationIdOf(envelope);
      } catch {
        operationId = undefined;
      }
      return Promise.resolve(
        failure('closed', 'local IPC transport is closed', target, operationId),
      );
    }
    if (this.inFlight.size >= MAX_IN_FLIGHT_DELIVERIES) {
      let operationId: string | undefined;
      try {
        operationId = operationIdOf(envelope);
      } catch {
        return Promise.resolve(
          failure(
            'invalid_target',
            'local IPC envelope identifiers are invalid',
            target,
            undefined,
          ),
        );
      }
      return Promise.resolve(
        failure(
          'unreachable',
          'local IPC delivery capacity is temporarily exhausted',
          target,
          operationId,
        ),
      );
    }
    return this.track(this.deliverEnvelope(target, envelope));
  }

  public sendResponse(
    target: TransportRuntimeTarget<LocalIpcEndpoint>,
    response: Response,
  ): Promise<TransportDeliveryResult<LocalIpcEndpoint>> {
    if (this.closedState) {
      let operationId: string | undefined;
      try {
        operationId = operationIdOf(response);
      } catch {
        operationId = undefined;
      }
      return Promise.resolve(
        failure('closed', 'local IPC transport is closed', target, operationId),
      );
    }
    if (this.inFlight.size >= MAX_IN_FLIGHT_DELIVERIES) {
      let operationId: string | undefined;
      try {
        operationId = operationIdOf(response);
      } catch {
        return Promise.resolve(
          failure('invalid_target', 'local IPC response identifier is invalid', target, undefined),
        );
      }
      return Promise.resolve(
        failure(
          'unreachable',
          'local IPC delivery capacity is temporarily exhausted',
          target,
          operationId,
        ),
      );
    }
    return this.track(this.deliverResponse(target, response));
  }

  public close(): Promise<void> {
    if (this.closePromise !== undefined) {
      return this.closePromise;
    }
    this.closedState = true;
    let resolveClose!: () => void;
    let rejectClose!: (error: unknown) => void;
    const closePromise = new Promise<void>((resolve, reject) => {
      resolveClose = resolve;
      rejectClose = reject;
    });
    // Publish the close latch before binding callbacks or hook drains run.
    this.closePromise = closePromise;
    void this.finishClose().then(resolveClose, rejectClose);
    return closePromise;
  }

  public shutdown(): Promise<void> {
    return this.close();
  }

  public dispose(): Promise<void> {
    return this.close();
  }

  private async finishClose(): Promise<void> {
    const bindings = [...this.bindings];
    await Promise.allSettled(bindings.map((binding) => binding.close()));
    await drainPromisesWithin(
      [...this.inFlight],
      this.deliveryTimeoutMs,
      this.setTimeout,
      this.clearTimeout,
    );
  }

  private async deliverEnvelope(
    target: TransportRuntimeTarget<LocalIpcEndpoint>,
    envelope: Envelope,
  ): Promise<TransportDeliveryResult<LocalIpcEndpoint>> {
    let operationId: string | undefined;
    let senderRuntimeId: string | undefined;
    try {
      operationId = operationIdOf(envelope);
      senderRuntimeId = senderRuntimeIdOf(envelope);
    } catch (error) {
      return failure(
        'invalid_target',
        'local IPC envelope identifiers are invalid',
        target,
        undefined,
        error,
      );
    }
    if (operationId === undefined || senderRuntimeId === undefined) {
      return failure(
        'invalid_target',
        'local IPC envelopes require operationId and sender.runtimeId',
        target,
        operationId,
      );
    }
    if (this.closedState) {
      return failure('closed', 'local IPC transport is closed', target, operationId);
    }

    let normalizedTarget: LocalIpcRuntimeTarget;
    try {
      normalizedTarget = validateTarget(target);
    } catch (error) {
      return failure('invalid_target', 'local IPC target is invalid', target, operationId, error);
    }
    try {
      operationDeadline(envelope.expiresAt, finiteClock(this.now()));
    } catch (error) {
      return failure(
        'invalid_target',
        'local IPC operation metadata is invalid',
        normalizedTarget,
        operationId,
        error,
      );
    }

    const terminalFailure = (
      message: string,
      cause?: unknown,
    ): TransportDeliveryResult<LocalIpcEndpoint> => {
      const terminal = this.markOperationUnreachable(
        senderRuntimeId,
        operationId,
        normalizedTarget,
        message,
        envelope.expiresAt,
      );
      if (terminal === 'delivered') {
        return delivered(operationId);
      }
      const immutableMessage =
        this.registry.operationUnreachableMessage(
          senderRuntimeId,
          operationId,
          normalizedTarget.runtimeId,
        ) ?? message;
      return this.unreachableFailure(
        immutableMessage,
        normalizedTarget,
        operationId,
        envelope.expiresAt,
        cause,
        senderRuntimeId,
      );
    };

    if (this.persistence !== undefined) {
      try {
        const cached = this.persistence.getUnreachable(operationId, senderRuntimeId);
        if (cached !== undefined && cached.recipientRuntimeId === normalizedTarget.runtimeId) {
          return failure(
            'unreachable',
            cached.error.message,
            normalizedTarget,
            operationId,
            cached.error,
          );
        }
        this.persistence.assertReplayAllowed(
          operationId,
          normalizedTarget.runtimeId,
          senderRuntimeId,
        );
      } catch (error) {
        if (error instanceof TypeError || error instanceof RangeError) {
          return failure(
            'invalid_target',
            'local IPC operation metadata is invalid',
            normalizedTarget,
            operationId,
            error,
          );
        }
        return this.unreachableFailure(
          'operationId belongs to an earlier runtime endpoint; create a new operationId',
          normalizedTarget,
          operationId,
          envelope.expiresAt,
          error,
          senderRuntimeId,
        );
      }
    }

    const record = this.registry.resolve(normalizedTarget);
    if (record === undefined) {
      return terminalFailure('local IPC runtime endpoint is not currently reachable');
    }
    if (!this.registry.isCurrent(record, normalizedTarget)) {
      return terminalFailure('local IPC runtime endpoint was replaced before delivery');
    }
    if (!this.registry.hasHookCapacity(record)) {
      return failure(
        'unreachable',
        'local IPC delivery hook capacity is temporarily exhausted',
        normalizedTarget,
        operationId,
      );
    }

    let reservation: RouteReservation | null;
    try {
      reservation = this.reserveOperation(
        senderRuntimeId,
        operationId,
        normalizedTarget.runtimeId,
        envelope.expiresAt,
      );
    } catch (error) {
      if (error instanceof LocalIpcBindingError) {
        return failure(
          'invalid_target',
          'local IPC operation metadata is invalid',
          normalizedTarget,
          operationId,
          error,
        );
      }
      return this.unreachableFailure(
        'operationId belongs to an earlier runtime endpoint; create a new operationId',
        normalizedTarget,
        operationId,
        envelope.expiresAt,
        error,
        senderRuntimeId,
      );
    }
    if (reservation === null) {
      return this.unreachableFailure(
        'operationId belongs to an earlier runtime endpoint; create a new operationId',
        normalizedTarget,
        operationId,
        envelope.expiresAt,
        new LocalIpcBindingError(
          'identity_conflict',
          'operationId is bound to a different destination',
        ),
        senderRuntimeId,
      );
    }
    if (reservation.terminal === 'delivered') {
      return delivered(operationId);
    }
    if (reservation.terminal === 'unreachable') {
      return this.unreachableFailure(
        reservation.unreachableMessage ?? 'local IPC delivery was previously unreachable',
        normalizedTarget,
        operationId,
        envelope.expiresAt,
        undefined,
        senderRuntimeId,
      );
    }

    if (this.persistence !== undefined) {
      try {
        this.persistence.recordAcceptedOperation(
          operationId,
          normalizedTarget.runtimeId,
          envelope.expiresAt,
          senderRuntimeId,
        );
      } catch (error) {
        if (error instanceof TypeError || error instanceof RangeError) {
          return failure(
            'invalid_target',
            'local IPC operation metadata is invalid',
            normalizedTarget,
            operationId,
            error,
          );
        }
        return this.unreachableFailure(
          'operationId belongs to an earlier runtime endpoint; create a new operationId',
          normalizedTarget,
          operationId,
          envelope.expiresAt,
          error,
          senderRuntimeId,
        );
      }
    }

    const source = sourceForRuntime(this.registry, senderRuntimeId, normalizedTarget);
    const fence = { active: true };
    const delivery: TransportInboundEnvelope<Envelope, Response, LocalIpcEndpoint> = {
      envelope,
      source,
      reply: (response) => {
        let responseOperationId: string | undefined;
        try {
          responseOperationId = operationIdOf(response);
        } catch {
          responseOperationId = undefined;
        }
        if (
          !fence.active ||
          this.closedState ||
          !this.registry.isCurrent(record, normalizedTarget)
        ) {
          return Promise.resolve(
            failure(
              'unreachable',
              'inbound response path belongs to a stale runtime generation',
              normalizedTarget,
              responseOperationId,
            ),
          );
        }
        return this.sendResponse(source, response);
      },
    };

    if (!this.registry.isCurrent(record, normalizedTarget)) {
      fence.active = false;
      return terminalFailure('local IPC runtime endpoint was replaced before hook invocation');
    }

    try {
      const underlyingHook = Promise.resolve().then(() => {
        if (!fence.active || !this.registry.isCurrent(record, normalizedTarget)) {
          throw new LocalIpcDeliveryStale();
        }
        return (
          record.hooks.onEnvelope as unknown as (
            inbound: TransportInboundEnvelope<Envelope, Response, LocalIpcEndpoint>,
          ) => void | PromiseLike<void>
        )(delivery);
      });
      const trackedHook = this.trackRecord(record, underlyingHook);
      if (trackedHook === undefined) {
        fence.active = false;
        return failure(
          'unreachable',
          'local IPC delivery hook capacity is temporarily exhausted',
          normalizedTarget,
          operationId,
        );
      }
      await waitForHook(
        () => trackedHook,
        this.deliveryTimeoutMs,
        this.setTimeout,
        this.clearTimeout,
      );
      if (!fence.active || !this.registry.isCurrent(record, normalizedTarget)) {
        fence.active = false;
        return terminalFailure('local IPC runtime endpoint closed during delivery');
      }
      const terminal = this.registry.markOperationDelivered(
        senderRuntimeId,
        operationId,
        normalizedTarget.runtimeId,
      );
      if (terminal === 'unreachable') {
        return terminalFailure(
          this.registry.operationUnreachableMessage(
            senderRuntimeId,
            operationId,
            normalizedTarget.runtimeId,
          ) ?? 'local IPC delivery was already unreachable',
        );
      }
      return delivered(operationId);
    } catch (error) {
      fence.active = false;
      const terminal = this.markOperationUnreachable(
        senderRuntimeId,
        operationId,
        normalizedTarget,
        'local IPC delivery hook could not be established',
        envelope.expiresAt,
      );
      if (terminal === 'delivered') {
        return delivered(operationId);
      }
      return this.unreachableFailure(
        this.registry.operationUnreachableMessage(
          senderRuntimeId,
          operationId,
          normalizedTarget.runtimeId,
        ) ?? 'local IPC delivery hook could not be established',
        normalizedTarget,
        operationId,
        envelope.expiresAt,
        error,
        senderRuntimeId,
      );
    }
  }

  private async deliverResponse(
    target: TransportRuntimeTarget<LocalIpcEndpoint>,
    response: Response,
  ): Promise<TransportDeliveryResult<LocalIpcEndpoint>> {
    let operationId: string | undefined;
    try {
      operationId = operationIdOf(response);
    } catch (error) {
      return failure(
        'invalid_target',
        'local IPC response identifier is invalid',
        target,
        undefined,
        error,
      );
    }
    if (operationId === undefined) {
      return failure(
        'invalid_target',
        'local IPC responses require operationId',
        target,
        operationId,
      );
    }
    if (this.closedState) {
      return failure('closed', 'local IPC transport is closed', target, operationId);
    }

    let normalizedTarget: LocalIpcRuntimeTarget;
    try {
      normalizedTarget = validateTarget(target);
    } catch (error) {
      return failure('invalid_target', 'local IPC target is invalid', target, operationId, error);
    }
    const localSource = this.firstBoundTarget() ?? normalizedTarget;
    const senderRuntimeId = localSource.runtimeId;
    const terminalFailure = (
      message: string,
      cause?: unknown,
    ): TransportDeliveryResult<LocalIpcEndpoint> => {
      const terminal = this.markOperationUnreachable(
        senderRuntimeId,
        operationId,
        normalizedTarget,
        message,
      );
      if (terminal === 'delivered') {
        return delivered(operationId);
      }
      const immutableMessage =
        this.registry.operationUnreachableMessage(
          senderRuntimeId,
          operationId,
          normalizedTarget.runtimeId,
        ) ?? message;
      return this.unreachableFailure(
        immutableMessage,
        normalizedTarget,
        operationId,
        undefined,
        cause,
        senderRuntimeId,
      );
    };

    if (this.persistence !== undefined) {
      try {
        const cached = this.persistence.getUnreachable(operationId, senderRuntimeId);
        if (cached !== undefined && cached.recipientRuntimeId === normalizedTarget.runtimeId) {
          return failure(
            'unreachable',
            cached.error.message,
            normalizedTarget,
            operationId,
            cached.error,
          );
        }
        this.persistence.assertReplayAllowed(
          operationId,
          normalizedTarget.runtimeId,
          senderRuntimeId,
        );
      } catch (error) {
        if (error instanceof TypeError || error instanceof RangeError) {
          return failure(
            'invalid_target',
            'local IPC operation metadata is invalid',
            normalizedTarget,
            operationId,
            error,
          );
        }
        return this.unreachableFailure(
          'operationId belongs to an earlier runtime endpoint; create a new operationId',
          normalizedTarget,
          operationId,
          undefined,
          error,
          senderRuntimeId,
        );
      }
    }

    const record = this.registry.resolve(normalizedTarget);
    if (record === undefined) {
      return terminalFailure('local IPC runtime endpoint is not currently reachable');
    }
    if (!this.registry.isCurrent(record, normalizedTarget)) {
      return terminalFailure('local IPC runtime endpoint was replaced before response delivery');
    }
    if (!this.registry.hasHookCapacity(record)) {
      return failure(
        'unreachable',
        'local IPC delivery hook capacity is temporarily exhausted',
        normalizedTarget,
        operationId,
      );
    }

    let reservation: RouteReservation | null;
    try {
      reservation = this.reserveOperation(senderRuntimeId, operationId, normalizedTarget.runtimeId);
    } catch (error) {
      if (error instanceof LocalIpcBindingError) {
        return failure(
          'invalid_target',
          'local IPC operation metadata is invalid',
          normalizedTarget,
          operationId,
          error,
        );
      }
      return this.unreachableFailure(
        'operationId belongs to an earlier runtime endpoint; create a new operationId',
        normalizedTarget,
        operationId,
        undefined,
        error,
        senderRuntimeId,
      );
    }
    if (reservation === null) {
      return this.unreachableFailure(
        'operationId belongs to an earlier runtime endpoint; create a new operationId',
        normalizedTarget,
        operationId,
        undefined,
        new LocalIpcBindingError(
          'identity_conflict',
          'operationId is bound to a different destination',
        ),
        senderRuntimeId,
      );
    }
    if (reservation.terminal === 'delivered') {
      return delivered(operationId);
    }
    if (reservation.terminal === 'unreachable') {
      return this.unreachableFailure(
        reservation.unreachableMessage ?? 'local IPC delivery was previously unreachable',
        normalizedTarget,
        operationId,
        undefined,
        undefined,
        senderRuntimeId,
      );
    }

    if (this.persistence !== undefined) {
      try {
        this.persistence.recordAcceptedOperation(
          operationId,
          normalizedTarget.runtimeId,
          undefined,
          senderRuntimeId,
        );
      } catch (error) {
        if (error instanceof TypeError || error instanceof RangeError) {
          return failure(
            'invalid_target',
            'local IPC operation metadata is invalid',
            normalizedTarget,
            operationId,
            error,
          );
        }
        return this.unreachableFailure(
          'operationId belongs to an earlier runtime endpoint; create a new operationId',
          normalizedTarget,
          operationId,
          undefined,
          error,
          senderRuntimeId,
        );
      }
    }

    const fence = { active: true };
    const delivery: TransportInboundResponse<Response, LocalIpcEndpoint> = {
      response,
      source: localSource,
    };
    if (!this.registry.isCurrent(record, normalizedTarget)) {
      fence.active = false;
      return terminalFailure(
        'local IPC runtime endpoint was replaced before response hook invocation',
      );
    }
    try {
      const underlyingHook = Promise.resolve().then(() => {
        if (!fence.active || !this.registry.isCurrent(record, normalizedTarget)) {
          throw new LocalIpcDeliveryStale();
        }
        return (
          record.hooks.onResponse as unknown as (
            inbound: TransportInboundResponse<Response, LocalIpcEndpoint>,
          ) => void | PromiseLike<void>
        )(delivery);
      });
      const trackedHook = this.trackRecord(record, underlyingHook);
      if (trackedHook === undefined) {
        fence.active = false;
        return failure(
          'unreachable',
          'local IPC delivery hook capacity is temporarily exhausted',
          normalizedTarget,
          operationId,
        );
      }
      await waitForHook(
        () => trackedHook,
        this.deliveryTimeoutMs,
        this.setTimeout,
        this.clearTimeout,
      );
      if (!fence.active || !this.registry.isCurrent(record, normalizedTarget)) {
        fence.active = false;
        return terminalFailure('local IPC runtime endpoint closed during response delivery');
      }
      const terminal = this.registry.markOperationDelivered(
        senderRuntimeId,
        operationId,
        normalizedTarget.runtimeId,
      );
      if (terminal === 'unreachable') {
        return terminalFailure(
          this.registry.operationUnreachableMessage(
            senderRuntimeId,
            operationId,
            normalizedTarget.runtimeId,
          ) ?? 'local IPC response was already unreachable',
        );
      }
      return delivered(operationId);
    } catch (error) {
      fence.active = false;
      const terminal = this.markOperationUnreachable(
        senderRuntimeId,
        operationId,
        normalizedTarget,
        'local IPC response hook could not be established',
      );
      if (terminal === 'delivered') {
        return delivered(operationId);
      }
      return this.unreachableFailure(
        this.registry.operationUnreachableMessage(
          senderRuntimeId,
          operationId,
          normalizedTarget.runtimeId,
        ) ?? 'local IPC response hook could not be established',
        normalizedTarget,
        operationId,
        undefined,
        error,
        senderRuntimeId,
      );
    }
  }

  private firstBoundTarget(): LocalIpcRuntimeTarget | undefined {
    for (const binding of this.bindings) {
      if (binding.isOpen) {
        return binding.target;
      }
    }
    return undefined;
  }
  private reserveOperation(
    senderRuntimeId: string,
    operationId: string,
    recipientRuntimeId: string,
    expiresAt?: unknown,
  ): RouteReservation | null {
    return this.registry.reserveOperation(
      senderRuntimeId,
      operationId,
      recipientRuntimeId,
      expiresAt,
    );
  }

  private markOperationUnreachable(
    senderRuntimeId: string | undefined,
    operationId: string | undefined,
    target: LocalIpcRuntimeTarget | undefined,
    message: string,
    expiresAt?: unknown,
  ): OperationTerminalState | undefined {
    if (senderRuntimeId === undefined || operationId === undefined || target === undefined) {
      return undefined;
    }
    try {
      return this.registry.markOperationUnreachable(
        senderRuntimeId,
        operationId,
        target.runtimeId,
        message,
        expiresAt,
      );
    } catch {
      // A shared guard may already contain an immutable/conflicting result.
      return undefined;
    }
  }

  private trackRecord<T>(
    record: LocalIpcRegistryRecord,
    promise: Promise<T>,
  ): Promise<T> | undefined {
    if (!this.registry.hasHookCapacity(record)) {
      return undefined;
    }
    const tracked = promise.finally(() => record.inFlight.delete(tracked));
    record.inFlight.add(tracked);
    return tracked;
  }

  private track<T>(promise: Promise<T>): Promise<T> {
    const tracked = promise.finally(() => this.inFlight.delete(tracked));
    this.inFlight.add(tracked);
    return tracked;
  }

  private unreachableFailure(
    message: string,
    target: LocalIpcRuntimeTarget | undefined,
    operationId: string | undefined,
    expiresAt?: unknown,
    cause?: unknown,
    senderRuntimeId?: string,
  ): TransportDeliveryFailure<LocalIpcEndpoint> {
    let effectiveMessage = message;
    let effectiveCause = cause;
    if (operationId !== undefined && this.persistence !== undefined) {
      const reportExpiry =
        typeof expiresAt === 'string' || typeof expiresAt === 'number' || expiresAt instanceof Date
          ? expiresAt
          : undefined;
      try {
        const result = this.persistence.reportUnreachable(
          operationId,
          target?.runtimeId,
          message,
          reportExpiry,
          senderRuntimeId,
        );
        effectiveMessage = result.error.message;
      } catch (error) {
        // Preserve identity conflicts instead of turning them into an opaque success/failure.
        effectiveCause ??= error;
      }
    }
    return failure('unreachable', effectiveMessage, target, operationId, effectiveCause);
  }

  public async closeBinding(binding: LocalIpcBinding<Envelope, Response>): Promise<void> {
    this.bindings.delete(binding);
    this.registry.deactivate(binding.registryRecord);
    const notice: LocalIpcShutdownNotice = {
      runtimeId: binding.target.runtimeId,
      endpoint: binding.target.endpoint,
      graceful: true,
      reason: 'runtime binding closed',
      source: binding.target,
    };
    await this.registry.unregister(binding.registryRecord, notice, this.deliveryTimeoutMs);
  }
}

/** Compatibility aliases for callers that use adapter/binding terminology. */
export const LocalIpcAdapter = LocalIpcTransport;
export const LocalIpcBindingAdapter = LocalIpcTransport;
export const InProcessLocalIpcTransport = LocalIpcTransport;
export const createLocalIpcTransport = <
  Envelope extends TransportEnvelope = TransportEnvelope,
  Response extends TransportOperationResponse = TransportOperationResponse,
>(
  options: LocalIpcTransportOptions = {},
): LocalIpcTransport<Envelope, Response> => new LocalIpcTransport<Envelope, Response>(options);

export const createLocalIpcAdapter = createLocalIpcTransport;
export const createLocalIpcBinding = createLocalIpcTransport;

/** Shared registry for tests or multiple adapter instances in one process. */
export const sharedLocalIpcRegistry = DEFAULT_LOCAL_IPC_REGISTRY;
