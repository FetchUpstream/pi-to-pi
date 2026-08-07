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
  sharedRuntimeOperationGuardState,
  type AcceptedOperationRecord,
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

interface OperationDestinationRecord {
  readonly recipientRuntimeId: string;
  readonly retainedUntil: number;
  stale: boolean;
  delivered: boolean;
  unreachableMessage?: string;
  timer?: unknown;
  clearTimeout?: LocalIpcClearTimeout;
}

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
const DEFAULT_RUNTIME_ID_RETENTION_MS = DEDUPE_RETENTION_GRACE_MS;
const SHARED_OPERATION_DESTINATIONS = new Map<string, OperationDestinationRecord>();
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
  if (!Number.isSafeInteger(value) || value < 0 || value > DEDUPE_RETENTION_GRACE_MS) {
    throw new RangeError(
      `${field} must be a non-negative safe integer no greater than ${DEDUPE_RETENTION_GRACE_MS}`,
    );
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
  operationId: string,
  record: AcceptedOperationRecord,
  clearTimeoutFn: LocalIpcClearTimeout,
): void {
  if (sharedRuntimeOperationGuardState.acceptedOperations.get(operationId) !== record) {
    return;
  }
  if (record.timer !== undefined) {
    (record.clearTimeout ?? clearTimeoutFn)(record.timer);
    record.timer = undefined;
  }
  sharedRuntimeOperationGuardState.acceptedOperations.delete(operationId);
}

function removeSharedUnreachableResult(
  operationId: string,
  record: UnreachableRecord,
  clearTimeoutFn: LocalIpcClearTimeout,
): void {
  if (sharedRuntimeOperationGuardState.unreachableResults.get(operationId) !== record) {
    return;
  }
  if (record.timer !== undefined) {
    (record.clearTimeout ?? clearTimeoutFn)(record.timer);
    record.timer = undefined;
  }
  sharedRuntimeOperationGuardState.unreachableResults.delete(operationId);
}

function pruneSharedOperationGuards(nowMs: number, clearTimeoutFn: LocalIpcClearTimeout): void {
  for (const [operationId, record] of sharedRuntimeOperationGuardState.acceptedOperations) {
    if (record.retainedUntil <= nowMs) {
      removeSharedAcceptedOperation(operationId, record, clearTimeoutFn);
    }
  }
  for (const [operationId, record] of sharedRuntimeOperationGuardState.unreachableResults) {
    if (record.retainedUntil <= nowMs) {
      removeSharedUnreachableResult(operationId, record, clearTimeoutFn);
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
  private readonly operationDestinations = SHARED_OPERATION_DESTINATIONS;
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
    this.retentionGraceMs = validateRetention(
      options.retentionGraceMs ?? DEDUPE_RETENTION_GRACE_MS,
      'retentionGraceMs',
    );
    this.runtimeIdRetentionMs = validateRetention(
      options.runtimeIdRetentionMs ?? DEFAULT_RUNTIME_ID_RETENTION_MS,
      'runtimeIdRetentionMs',
    );
    finiteClock(this.now());
  }

  public get size(): number {
    return this.records.size;
  }

  public register<Envelope extends TransportEnvelope, Response extends TransportOperationResponse>(
    target: TransportRuntimeTarget<LocalIpcEndpoint>,
    hooks: LocalIpcInboundHooks<Envelope, Response>,
  ): LocalIpcRegistryRecord {
    this.prune();
    const normalizedTarget = validateTarget(target);
    const key = targetKey(normalizedTarget);
    const issued = this.issuedRuntimeIds.get(normalizedTarget.runtimeId);
    if (
      this.records.has(key) ||
      this.runtimes.has(normalizedTarget.runtimeId) ||
      (issued !== undefined && (!issued.retired || issued.retainedUntil > finiteClock(this.now())))
    ) {
      throw new LocalIpcBindingError(
        'duplicate',
        'one runtime may own only one live local IPC endpoint and retired runtime IDs cannot be reused',
      );
    }
    if (issued !== undefined) {
      this.removeIssuedRuntimeId(normalizedTarget.runtimeId, issued);
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
    this.prune();
    const nowMs = finiteClock(this.now());
    const retainedUntil = retentionDeadline(expiresAt, nowMs, this.retentionGraceMs);
    const key = `${normalizedSender}\u0000${normalizedOperation}`;
    const sharedUnreachable =
      sharedRuntimeOperationGuardState.unreachableResults.get(normalizedOperation);
    if (sharedUnreachable !== undefined) {
      if (sharedUnreachable.recipientRuntimeId !== normalizedRecipient) {
        return null;
      }
      return {
        key,
        created: false,
        unreachableMessage: sharedUnreachable.message,
      };
    }
    const sharedAccepted =
      sharedRuntimeOperationGuardState.acceptedOperations.get(normalizedOperation);
    if (sharedAccepted !== undefined) {
      if (sharedAccepted.stale || sharedAccepted.value.recipientRuntimeId !== normalizedRecipient) {
        sharedAccepted.stale = true;
        return null;
      }
    }
    const previous = this.operationDestinations.get(key);
    if (previous !== undefined) {
      if (previous.stale || previous.recipientRuntimeId !== normalizedRecipient) {
        previous.stale = true;
        if (sharedAccepted !== undefined) {
          sharedAccepted.stale = true;
        }
        return null;
      }
      return {
        key,
        created: false,
        ...(previous.unreachableMessage === undefined
          ? {}
          : { unreachableMessage: previous.unreachableMessage }),
      };
    }
    const record: OperationDestinationRecord = {
      recipientRuntimeId: normalizedRecipient,
      retainedUntil: sharedAccepted?.retainedUntil ?? retainedUntil,
      stale: false,
      delivered: false,
    };
    this.operationDestinations.set(key, record);
    this.scheduleOperationDestination(key, record);
    if (sharedAccepted === undefined) {
      const accepted: AcceptedOperationRecord = {
        value: Object.freeze({
          operationId: normalizedOperation,
          recipientRuntimeId: normalizedRecipient,
        }),
        retainedUntil,
        stale: false,
      };
      sharedRuntimeOperationGuardState.acceptedOperations.set(normalizedOperation, accepted);
      this.scheduleSharedAcceptedOperation(normalizedOperation, accepted);
    } else if (sharedAccepted.timer === undefined) {
      this.scheduleSharedAcceptedOperation(normalizedOperation, sharedAccepted);
    }
    return { key, created: sharedAccepted === undefined };
  }

  public markOperationUnreachable(
    senderRuntimeId: string,
    operationId: string,
    recipientRuntimeId: string,
    message: string,
    expiresAt?: unknown,
  ): void {
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
    const normalizedOperation = validateIdentifier(operationId, 'operationId');
    const normalizedRecipient = validateIdentifier(recipientRuntimeId, 'recipient runtimeId');
    const normalizedMessage = validateIdentifier(message, 'unreachable message');
    const sharedPrevious =
      sharedRuntimeOperationGuardState.unreachableResults.get(normalizedOperation);
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
      return;
    }
    const record = this.operationDestinations.get(reservation.key);
    if (record?.delivered) {
      return;
    }
    if (record !== undefined) {
      if (
        record.unreachableMessage !== undefined &&
        record.unreachableMessage !== normalizedMessage
      ) {
        throw new LocalIpcBindingError(
          'identity_conflict',
          'unreachable result is immutable for this operation destination',
        );
      }
      record.unreachableMessage = normalizedMessage;
    }
    const accepted = sharedRuntimeOperationGuardState.acceptedOperations.get(normalizedOperation);
    const retainedUntil =
      accepted?.retainedUntil ??
      record?.retainedUntil ??
      retentionDeadline(expiresAt, finiteClock(this.now()), this.retentionGraceMs);
    const error = createProtocolError('unreachable', normalizedMessage, {
      details: { recipientRuntimeId: normalizedRecipient },
    });
    const result: RuntimeUnreachableResult = Object.freeze({
      status: 'unreachable',
      operationId: normalizedOperation,
      error: error as RuntimeUnreachableResult['error'],
      recipientRuntimeId: normalizedRecipient,
    });
    const sharedRecord: UnreachableRecord = {
      value: result,
      recipientRuntimeId: normalizedRecipient,
      message: normalizedMessage,
      retainedUntil,
    };
    sharedRuntimeOperationGuardState.unreachableResults.set(normalizedOperation, sharedRecord);
    this.scheduleSharedUnreachableResult(normalizedOperation, sharedRecord);
  }

  public markOperationDelivered(
    senderRuntimeId: string,
    operationId: string,
    recipientRuntimeId: string,
  ): void {
    const key = `${validateIdentifier(
      senderRuntimeId,
      'sender runtimeId',
    )}\u0000${validateIdentifier(operationId, 'operationId')}`;
    const record = this.operationDestinations.get(key);
    if (record?.recipientRuntimeId === recipientRuntimeId && !record.stale) {
      record.delivered = true;
    }
  }

  public prune(nowMs = finiteClock(this.now())): number {
    if (!Number.isFinite(nowMs)) {
      throw new RangeError('local IPC clock must return a finite number');
    }
    let removed = 0;
    pruneSharedOperationGuards(nowMs, this.clearTimeout);
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
        if (onShutdown === undefined) {
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
        hookPromises.push(tracked.catch(() => undefined));
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
  private trackRecord<T>(record: LocalIpcRegistryRecord, promise: Promise<T>): Promise<T> {
    const tracked = promise.finally(() => record.inFlight.delete(tracked));
    record.inFlight.add(tracked);
    return tracked;
  }

  private async drainRecord(record: LocalIpcRegistryRecord, timeoutMs: number): Promise<void> {
    await drainPromisesWithin([...record.inFlight], timeoutMs, this.setTimeout, this.clearTimeout);
  }

  private scheduleSharedAcceptedOperation(
    operationId: string,
    record: AcceptedOperationRecord,
  ): void {
    if (record.timer !== undefined) {
      return;
    }
    const delay = record.retainedUntil - finiteClock(this.now());
    if (delay <= 0) {
      removeSharedAcceptedOperation(operationId, record, this.clearTimeout);
      return;
    }
    record.clearTimeout = this.clearTimeout;
    record.timer = this.setTimeout(
      () => {
        record.timer = undefined;
        if (sharedRuntimeOperationGuardState.acceptedOperations.get(operationId) !== record) {
          return;
        }
        if (record.retainedUntil <= finiteClock(this.now())) {
          removeSharedAcceptedOperation(operationId, record, this.clearTimeout);
        } else {
          this.scheduleSharedAcceptedOperation(operationId, record);
        }
      },
      Math.min(delay, MAX_TIMER_DELAY_MS),
    );
    unrefTimer(record.timer);
  }

  private scheduleSharedUnreachableResult(operationId: string, record: UnreachableRecord): void {
    if (record.timer !== undefined) {
      return;
    }
    const delay = record.retainedUntil - finiteClock(this.now());
    if (delay <= 0) {
      removeSharedUnreachableResult(operationId, record, this.clearTimeout);
      return;
    }
    record.clearTimeout = this.clearTimeout;
    record.timer = this.setTimeout(
      () => {
        record.timer = undefined;
        if (sharedRuntimeOperationGuardState.unreachableResults.get(operationId) !== record) {
          return;
        }
        if (record.retainedUntil <= finiteClock(this.now())) {
          removeSharedUnreachableResult(operationId, record, this.clearTimeout);
        } else {
          this.scheduleSharedUnreachableResult(operationId, record);
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
      retainedUntil: nowMs + this.runtimeIdRetentionMs,
    };
    const previous = this.issuedRuntimeIds.get(runtimeId);
    if (previous?.timer !== undefined) {
      (previous.clearTimeout ?? this.clearTimeout)(previous.timer);
    }
    this.issuedRuntimeIds.set(runtimeId, record);
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

interface RouteReservation {
  readonly key: string;
  readonly created: boolean;
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
    this.registry = options.registry ?? DEFAULT_LOCAL_IPC_REGISTRY;
    this.deliveryTimeoutMs = timeoutValue(options.deliveryTimeoutMs);
    this.persistence = options.persistence ?? options.runtimePersistence;
    this.now = options.now ?? (() => Date.now());
    this.setTimeout = options.setTimeout ?? defaultSetTimeout;
    this.clearTimeout = options.clearTimeout ?? defaultClearTimeout;
    if (options.retentionGraceMs !== undefined) {
      validateRetention(options.retentionGraceMs, 'retentionGraceMs');
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
    return this.track(this.deliverEnvelope(target, envelope));
  }

  public sendResponse(
    target: TransportRuntimeTarget<LocalIpcEndpoint>,
    response: Response,
  ): Promise<TransportDeliveryResult<LocalIpcEndpoint>> {
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

    let reservation: RouteReservation | null = null;
    if (senderRuntimeId !== undefined && operationId !== undefined) {
      try {
        const cached = this.persistence?.getUnreachable(operationId);
        if (cached !== undefined && cached.recipientRuntimeId === normalizedTarget.runtimeId) {
          return failure(
            'unreachable',
            cached.error.message,
            normalizedTarget,
            operationId,
            cached.error,
          );
        }
        this.persistence?.assertReplayAllowed(operationId, normalizedTarget.runtimeId);
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
        );
      }
      if (reservation.unreachableMessage !== undefined) {
        return failure(
          'unreachable',
          reservation.unreachableMessage,
          normalizedTarget,
          operationId,
        );
      }
    }

    const record = this.registry.resolve(normalizedTarget);
    if (record === undefined) {
      this.markOperationUnreachable(
        senderRuntimeId,
        operationId,
        normalizedTarget,
        'local IPC runtime endpoint is not currently reachable',
        envelope.expiresAt,
      );
      return this.unreachableFailure(
        'local IPC runtime endpoint is not currently reachable',
        normalizedTarget,
        operationId,
        envelope.expiresAt,
      );
    }
    if (!this.registry.isCurrent(record, normalizedTarget)) {
      this.markOperationUnreachable(
        senderRuntimeId,
        operationId,
        normalizedTarget,
        'local IPC runtime endpoint was replaced before delivery',
        envelope.expiresAt,
      );
      return this.unreachableFailure(
        'local IPC runtime endpoint was replaced before delivery',
        normalizedTarget,
        operationId,
        envelope.expiresAt,
      );
    }

    if (operationId !== undefined && this.persistence !== undefined) {
      try {
        this.persistence.recordAcceptedOperation(
          operationId,
          normalizedTarget.runtimeId,
          envelope.expiresAt,
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
        );
      }
    }

    const source = sourceForRuntime(this.registry, senderRuntimeId, normalizedTarget);
    const delivery: TransportInboundEnvelope<Envelope, Response, LocalIpcEndpoint> = {
      envelope,
      source,
      reply: (response) => {
        if (this.closedState || !this.registry.isCurrent(record, normalizedTarget)) {
          return Promise.resolve(
            this.unreachableFailure(
              'inbound response path belongs to a stale runtime generation',
              normalizedTarget,
              operationIdOf(response),
            ),
          );
        }
        return this.sendResponse(source, response);
      },
    };

    if (!this.registry.isCurrent(record, normalizedTarget)) {
      this.markOperationUnreachable(
        senderRuntimeId,
        operationId,
        normalizedTarget,
        'local IPC runtime endpoint was replaced before hook invocation',
        envelope.expiresAt,
      );
      return this.unreachableFailure(
        'local IPC runtime endpoint was replaced before hook invocation',
        normalizedTarget,
        operationId,
        envelope.expiresAt,
      );
    }

    try {
      const underlyingHook = Promise.resolve().then(() => {
        if (!this.registry.isCurrent(record, normalizedTarget)) {
          throw new LocalIpcDeliveryStale();
        }
        return (
          record.hooks.onEnvelope as unknown as (
            inbound: TransportInboundEnvelope<Envelope, Response, LocalIpcEndpoint>,
          ) => void | PromiseLike<void>
        )(delivery);
      });
      const trackedHook = this.trackRecord(record, underlyingHook);
      await waitForHook(
        () => trackedHook,
        this.deliveryTimeoutMs,
        this.setTimeout,
        this.clearTimeout,
      );
      if (!this.registry.isCurrent(record, normalizedTarget)) {
        this.markOperationUnreachable(
          senderRuntimeId,
          operationId,
          normalizedTarget,
          'local IPC runtime endpoint closed during delivery',
          envelope.expiresAt,
        );
        return this.unreachableFailure(
          'local IPC runtime endpoint closed during delivery',
          normalizedTarget,
          operationId,
          envelope.expiresAt,
        );
      }
      if (senderRuntimeId !== undefined && operationId !== undefined) {
        this.registry.markOperationDelivered(
          senderRuntimeId,
          operationId,
          normalizedTarget.runtimeId,
        );
      }
      return delivered(operationId);
    } catch (error) {
      this.markOperationUnreachable(
        senderRuntimeId,
        operationId,
        normalizedTarget,
        'local IPC delivery hook could not be established',
        envelope.expiresAt,
      );
      return this.unreachableFailure(
        'local IPC delivery hook could not be established',
        normalizedTarget,
        operationId,
        envelope.expiresAt,
        error,
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
    let reservation: RouteReservation | null = null;
    if (operationId !== undefined) {
      try {
        const cached = this.persistence?.getUnreachable(operationId);
        if (cached !== undefined && cached.recipientRuntimeId === normalizedTarget.runtimeId) {
          return failure(
            'unreachable',
            cached.error.message,
            normalizedTarget,
            operationId,
            cached.error,
          );
        }
        this.persistence?.assertReplayAllowed(operationId, normalizedTarget.runtimeId);
        reservation = this.reserveOperation(
          senderRuntimeId,
          operationId,
          normalizedTarget.runtimeId,
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
          undefined,
          error,
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
        );
      }
      if (reservation.unreachableMessage !== undefined) {
        return failure(
          'unreachable',
          reservation.unreachableMessage,
          normalizedTarget,
          operationId,
        );
      }
    }

    const record = this.registry.resolve(normalizedTarget);
    if (record === undefined) {
      this.markOperationUnreachable(
        senderRuntimeId,
        operationId,
        normalizedTarget,
        'local IPC runtime endpoint is not currently reachable',
      );
      return this.unreachableFailure(
        'local IPC runtime endpoint is not currently reachable',
        normalizedTarget,
        operationId,
      );
    }
    if (!this.registry.isCurrent(record, normalizedTarget)) {
      this.markOperationUnreachable(
        senderRuntimeId,
        operationId,
        normalizedTarget,
        'local IPC runtime endpoint was replaced before response delivery',
      );
      return this.unreachableFailure(
        'local IPC runtime endpoint was replaced before response delivery',
        normalizedTarget,
        operationId,
      );
    }

    if (operationId !== undefined && this.persistence !== undefined) {
      try {
        this.persistence.recordAcceptedOperation(operationId, normalizedTarget.runtimeId);
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
        );
      }
    }

    const delivery: TransportInboundResponse<Response, LocalIpcEndpoint> = {
      response,
      source: localSource,
    };
    if (!this.registry.isCurrent(record, normalizedTarget)) {
      this.markOperationUnreachable(
        senderRuntimeId,
        operationId,
        normalizedTarget,
        'local IPC runtime endpoint was replaced before response hook invocation',
      );
      return this.unreachableFailure(
        'local IPC runtime endpoint was replaced before response hook invocation',
        normalizedTarget,
        operationId,
      );
    }
    try {
      const underlyingHook = Promise.resolve().then(() => {
        if (!this.registry.isCurrent(record, normalizedTarget)) {
          throw new LocalIpcDeliveryStale();
        }
        return (
          record.hooks.onResponse as unknown as (
            inbound: TransportInboundResponse<Response, LocalIpcEndpoint>,
          ) => void | PromiseLike<void>
        )(delivery);
      });
      const trackedHook = this.trackRecord(record, underlyingHook);
      await waitForHook(
        () => trackedHook,
        this.deliveryTimeoutMs,
        this.setTimeout,
        this.clearTimeout,
      );
      if (!this.registry.isCurrent(record, normalizedTarget)) {
        this.markOperationUnreachable(
          senderRuntimeId,
          operationId,
          normalizedTarget,
          'local IPC runtime endpoint closed during response delivery',
        );
        return this.unreachableFailure(
          'local IPC runtime endpoint closed during response delivery',
          normalizedTarget,
          operationId,
        );
      }
      if (operationId !== undefined) {
        this.registry.markOperationDelivered(
          senderRuntimeId,
          operationId,
          normalizedTarget.runtimeId,
        );
      }
      return delivered(operationId);
    } catch (error) {
      this.markOperationUnreachable(
        senderRuntimeId,
        operationId,
        normalizedTarget,
        'local IPC response hook could not be established',
      );
      return this.unreachableFailure(
        'local IPC response hook could not be established',
        normalizedTarget,
        operationId,
        undefined,
        error,
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
  ): void {
    if (senderRuntimeId === undefined || operationId === undefined || target === undefined) {
      return;
    }
    try {
      this.registry.markOperationUnreachable(
        senderRuntimeId,
        operationId,
        target.runtimeId,
        message,
        expiresAt,
      );
    } catch {
      // A shared guard may already contain an immutable/conflicting result.
    }
  }

  private trackRecord<T>(record: LocalIpcRegistryRecord, promise: Promise<T>): Promise<T> {
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
