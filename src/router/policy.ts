import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';

import { DEFAULT_QUEUE_LIMIT } from '../config.js';
import type { ProtocolLimits } from '../protocol/agent-card.js';
import {
  createProtocolError,
  type ProtocolError,
  type RetryableProtocolError,
} from '../protocol/errors.js';
import { isTerminalTaskState, TASK_STATES, type TaskState } from '../protocol/task-state.js';

/** The v1 default and maximum queued-request capacity. */
export const DEFAULT_QUEUE_CAPACITY = DEFAULT_QUEUE_LIMIT;

/** Values accepted for an absolute queue-entry deadline. */
export type QueueDeadline = number | Date | string;
export type QueueTime = number | Date;

/**
 * A transport- and executor-independent item that can be admitted by the
 * routing policy. The policy retains only this reference; it does not clone,
 * serialize, or execute `value`.
 */
export interface RoutingQueueEntry<T> {
  /** An optional caller identity; it is not used as an opaque queue handle. */
  readonly id?: string;
  /** The protocol request identifier, when the item represents a request. */
  readonly requestId?: string;
  readonly value: T;
  /** An absolute deadline; the item is not runnable at or after this time. */
  readonly expiresAt: QueueDeadline;
  /** Static or externally observed cancellation state. */
  readonly cancelled?: boolean;
  /** A task state observed by the policy before executor handoff. */
  readonly state?: string;
  /** Explicitly mark an entry as not runnable without changing task state. */
  readonly runnable?: boolean;
  /** Explicit abort marker for executors that do not expose an AbortSignal. */
  readonly aborted?: boolean;
  readonly isCancelled?: () => boolean;
  readonly signal?: Pick<AbortSignal, 'aborted'>;
}

export type QueueEntry<T> = RoutingQueueEntry<T>;

export interface RoutingPolicyOptions<T = unknown> {
  /** Maximum number of retained queued items; active leases do not consume it. */
  readonly capacity?: number;
  /** Alias for the queued-request capacity. */
  readonly queueCapacity?: number;
  /** Advertised protocol limit for queued inbound requests. */
  readonly maxQueueEntries?: number;
  /** A configured protocol limit may make the effective queue capacity stricter. */
  readonly limits?: Pick<ProtocolLimits, 'maxQueueEntries'>;
  /** Maximum number of active executor leases; defaults to queue capacity. */
  readonly activeCapacity?: number;
  /** Alias for `activeCapacity`. */
  readonly maxActiveEntries?: number;
  /**
   * Inject a monotonic clock for tests. Numeric deadlines and clock samples use
   * the same units. The default is a monotonic epoch projection, not Date.now().
   */
  readonly monotonicNow?: () => number;
  /** @deprecated Use `monotonicNow`; retained as a monotonic-clock alias. */
  readonly now?: () => number;
  /** @deprecated Use `monotonicNow`; retained as a monotonic-clock alias. */
  readonly clock?: () => number;
  /** Optional retry hint included in a `busy` error. */
  readonly retryAfterMs?: number;
  /**
   * Called once when an entry reaches expiry. Queued entries have already been
   * removed; active leases remain retained until `release` acknowledges stop.
   */
  readonly onExpired?: (entry: RoutingQueueEntry<T>) => void;
}

export interface AdmissionOptions {
  /** Admit directly as `accepted`; otherwise retain the item as `queued`. */
  readonly startImmediately?: boolean;
  /** @deprecated Override the monotonic clock only for deterministic tests. */
  readonly now?: QueueTime;
  /** Override the monotonic clock only for deterministic tests. */
  readonly monotonicNow?: QueueTime;
}

export interface QueueLease<T> {
  /** An opaque, unique handle for this retained record. */
  readonly id: string;
  /** Explicit spelling of the opaque handle; equal to `id`. */
  readonly handle: string;
  readonly requestId?: string;
  readonly value: T;
  readonly entry: RoutingQueueEntry<T>;
  readonly expiresAt: number;
  /** A lease returned by admission/dequeue is ready for executor ownership. */
  readonly state: 'working';
}

export interface AcceptedAdmission<T> {
  readonly state: 'accepted';
  readonly lease: QueueLease<T>;
}

export interface QueuedAdmission<T> {
  readonly state: 'queued';
  readonly entry: RoutingQueueEntry<T>;
  /** Opaque handle to use when cancelling or releasing this queued record. */
  readonly handle: string;
  /** Alias for `handle`. */
  readonly id: string;
  /** One-based position at the time the item was enqueued. */
  readonly position: number;
}

export interface BusyAdmission {
  readonly state: 'busy';
  readonly error: RetryableProtocolError;
}

export interface ExpiredAdmission {
  readonly state: 'expired';
  readonly error: ProtocolError;
}

export interface CancelledAdmission {
  readonly state: 'cancelled';
  readonly error: ProtocolError;
}

export type QueueAdmissionDecision<T> =
  AcceptedAdmission<T> | QueuedAdmission<T> | BusyAdmission | ExpiredAdmission | CancelledAdmission;
export type AdmissionDecision<T> = QueueAdmissionDecision<T>;

/** A handle plus an optional request identity for unambiguous cancellation. */
export interface QueueHandleReference {
  readonly handle: string;
  readonly requestId?: string;
}

export type QueueHandle<T> = QueueLease<T> | RoutingQueueEntry<T> | QueueHandleReference | string;

export type QueueCancellationState =
  'cancelled' | 'cancelling' | 'expired' | 'not_found' | 'ambiguous' | 'not_cancelable';

interface QueueCancellationRecord<T> {
  readonly entry: RoutingQueueEntry<T>;
  readonly handle: string;
  readonly requestId?: string;
}

export interface CancelledQueueRecord<T> extends QueueCancellationRecord<T> {
  readonly state: 'cancelled';
  readonly error: ProtocolError;
}

export interface CancellingQueueRecord<T> extends QueueCancellationRecord<T> {
  readonly state: 'cancelling';
  readonly error: ProtocolError;
}

export interface ExpiredQueueRecord<T> extends QueueCancellationRecord<T> {
  readonly state: 'expired';
  readonly error: ProtocolError;
}

export interface NotCancelableQueueRecord<T> extends QueueCancellationRecord<T> {
  readonly state: 'not_cancelable';
  readonly error: ProtocolError;
}

export interface NotFoundQueueRecord {
  readonly state: 'not_found';
  readonly error: ProtocolError;
}

export interface AmbiguousQueueRecord {
  readonly state: 'ambiguous';
  readonly error: ProtocolError;
}

export type QueueCancellationDecision<T> =
  | CancelledQueueRecord<T>
  | CancellingQueueRecord<T>
  | ExpiredQueueRecord<T>
  | NotCancelableQueueRecord<T>
  | NotFoundQueueRecord
  | AmbiguousQueueRecord;

interface QueueRecord<T> {
  readonly token: number;
  readonly handle: string;
  readonly entry: RoutingQueueEntry<T>;
  readonly deadline: number;
  status: 'candidate' | 'queued' | 'active' | 'cancelled' | 'released';
  expired: boolean;
  expiryNotified: boolean;
  cancellationRequested: boolean;
  lease?: QueueLease<T>;
}

type RecordLookup<T> =
  | { readonly kind: 'found'; readonly record: QueueRecord<T> }
  | { readonly kind: 'not_found' }
  | { readonly kind: 'ambiguous' };

function monotonicEpochNow(): number {
  return performance.timeOrigin + performance.now();
}

function resolveTime(value: QueueTime): number {
  const resolved = value instanceof Date ? value.getTime() : value;

  if (!Number.isFinite(resolved)) {
    throw new RangeError('queue time must be a finite number or valid Date');
  }

  return resolved;
}

function resolveDeadline(value: QueueDeadline): number {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new RangeError('expiresAt must be a finite number');
    }

    return value;
  }

  if (value instanceof Date) {
    return resolveTime(value);
  }

  const resolved = Date.parse(value);

  if (!Number.isFinite(resolved)) {
    throw new RangeError('expiresAt must be a finite number, valid Date, or RFC 3339 timestamp');
  }

  return resolved;
}

function resolveConfiguredCapacity(
  values: readonly (number | undefined)[],
  label: string,
): number | undefined {
  const configured = values.filter((value): value is number => value !== undefined);
  const capacity = configured[0];

  if (capacity !== undefined && configured.some((value) => value !== capacity)) {
    throw new RangeError(`${label} aliases must agree`);
  }

  return capacity;
}

function validateCapacity(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${label} must be a positive safe integer`);
  }

  if (value > DEFAULT_QUEUE_CAPACITY) {
    throw new RangeError(`${label} must not exceed ${DEFAULT_QUEUE_CAPACITY}`);
  }

  return value;
}

function resolveQueueCapacity<T>(options: RoutingPolicyOptions<T>): number {
  const configured = resolveConfiguredCapacity(
    [
      options.capacity,
      options.queueCapacity,
      options.maxQueueEntries,
      options.limits?.maxQueueEntries,
    ],
    'queue capacity',
  );

  return validateCapacity(configured ?? DEFAULT_QUEUE_CAPACITY, 'queue capacity');
}

function resolveActiveCapacity<T>(options: RoutingPolicyOptions<T>, queueCapacity: number): number {
  const configured = resolveConfiguredCapacity(
    [options.activeCapacity, options.maxActiveEntries],
    'active capacity',
  );

  return validateCapacity(configured ?? queueCapacity, 'active capacity');
}

function validateRetryAfterMs(retryAfterMs: number | undefined): void {
  if (retryAfterMs !== undefined && (!Number.isFinite(retryAfterMs) || retryAfterMs <= 0)) {
    throw new RangeError('retryAfterMs must be a finite positive number');
  }
}

function isRunnableState(state: string | undefined): boolean {
  if (state === undefined) {
    return true;
  }

  if (state === 'aborted' || !TASK_STATES.includes(state as TaskState)) {
    return false;
  }

  const taskState = state as TaskState;
  return taskState === 'accepted' || taskState === 'queued';
}

function isEntryCancellationRequested<T>(entry: RoutingQueueEntry<T>): boolean {
  return (
    entry.cancelled === true ||
    entry.aborted === true ||
    entry.state === 'cancelled' ||
    entry.state === 'cancelling' ||
    entry.signal?.aborted === true ||
    entry.isCancelled?.() === true
  );
}

function isTerminalOrAbortedState(state: string | undefined): boolean {
  if (state === 'aborted') {
    return true;
  }

  return state !== undefined && TASK_STATES.includes(state as TaskState)
    ? isTerminalTaskState(state as TaskState)
    : false;
}

/**
 * The single execution guard used by admission, dequeue, expiry cleanup, and
 * public runnable checks. A record must pass this predicate immediately before
 * it is moved to the active map and handed to an executor.
 */
function isRunnableRecord<T>(record: QueueRecord<T>, now: number): boolean {
  return (
    (record.status === 'candidate' || record.status === 'queued') &&
    !record.expired &&
    !record.cancellationRequested &&
    record.entry.runnable !== false &&
    record.deadline > now &&
    isRunnableState(record.entry.state) &&
    !isEntryCancellationRequested(record.entry)
  );
}

function isQueueHandleReference(value: object): value is QueueHandleReference {
  return 'handle' in value && typeof value.handle === 'string';
}

/**
 * A bounded, instance-scoped admission queue.
 *
 * `queueCapacity` bounds queued records and is the meaning of the advertised
 * `maxQueueEntries` limit. Active leases use a separately accounted
 * `activeCapacity`; an active lease never consumes a queued slot.
 */
export class RoutingPolicy<T = unknown> {
  /** Compatibility alias for the queued-request capacity. */
  readonly capacity: number;
  readonly queueCapacity: number;
  readonly activeCapacity: number;

  private readonly monotonicNow: () => number;
  private readonly retryAfterMs: number | undefined;
  private readonly onExpired: ((entry: RoutingQueueEntry<T>) => void) | undefined;
  private readonly queue: QueueRecord<T>[] = [];
  private readonly active = new Map<number, QueueRecord<T>>();
  private readonly handles = new Map<string, QueueRecord<T>>();
  private readonly entries = new WeakMap<object, Set<QueueRecord<T>>>();
  /** Legacy caller IDs remain safe only when they resolve uniquely. */
  private readonly entryIds = new Map<string, Set<QueueRecord<T>>>();
  private readonly requestIds = new Map<string, Set<QueueRecord<T>>>();
  private readonly leases = new WeakMap<object, QueueRecord<T>>();
  private nextToken = 1;
  private lastObservedNow = Number.NEGATIVE_INFINITY;

  constructor(options: RoutingPolicyOptions<T> = {}) {
    this.queueCapacity = resolveQueueCapacity(options);
    this.capacity = this.queueCapacity;
    this.activeCapacity = resolveActiveCapacity(options, this.queueCapacity);
    this.monotonicNow = options.monotonicNow ?? options.clock ?? options.now ?? monotonicEpochNow;
    this.retryAfterMs = options.retryAfterMs;
    this.onExpired = options.onExpired;
    validateRetryAfterMs(this.retryAfterMs);

    this.readMonotonicNow();
  }

  /** Number of retained active and queued entries. */
  get size(): number {
    return this.queue.length + this.active.size;
  }

  get queuedCount(): number {
    return this.queue.length;
  }

  get activeCount(): number {
    return this.active.size;
  }

  /** Number of queued slots not currently retained. */
  get availableCapacity(): number {
    return this.queueCapacity - this.queue.length;
  }

  get availableQueueCapacity(): number {
    return this.queueCapacity - this.queue.length;
  }

  /** Number of executor slots not currently leased. */
  get availableActiveCapacity(): number {
    return this.activeCapacity - this.active.size;
  }

  /**
   * Admit an item. By default it is queued; pass `startImmediately: true` only
   * when the caller has an executor slot ready for the returned lease.
   */
  admit(
    entry: RoutingQueueEntry<T>,
    options?: AdmissionOptions | boolean,
  ): QueueAdmissionDecision<T> {
    const admissionOptions =
      typeof options === 'boolean' ? { startImmediately: options } : (options ?? {});
    const requestedNow = admissionOptions.monotonicNow ?? admissionOptions.now;
    const now = this.resolveAdmissionTime(requestedNow);

    this.expire(now);

    const record = this.createRecord(entry);
    if (!isRunnableRecord(record, now)) {
      return this.admissionDecisionFor(record, now);
    }

    if (admissionOptions.startImmediately === true) {
      if (this.active.size >= this.activeCapacity) {
        return this.busyDecision();
      }

      this.registerRecord(record);
      const lease = this.claimRecord(record);
      if (lease !== undefined) {
        return { state: 'accepted', lease };
      }

      const observedNow = this.lastObservedNow;
      const decision = this.admissionDecisionFor(record, observedNow);
      this.removeRecord(record);
      return decision;
    }

    const queueNow = this.readMonotonicNow();
    this.expire(queueNow);
    if (!isRunnableRecord(record, queueNow)) {
      return this.admissionDecisionFor(record, queueNow);
    }

    if (this.queue.length >= this.queueCapacity) {
      return this.busyDecision();
    }

    this.registerRecord(record);
    record.status = 'queued';
    this.queue.push(record);

    return {
      state: 'queued',
      entry,
      handle: record.handle,
      id: record.handle,
      position: this.queue.length,
    };
  }

  /** Enqueue without allowing an immediate start. */
  enqueue(entry: RoutingQueueEntry<T>, now?: QueueTime): QueueAdmissionDecision<T> {
    return this.admit(entry, { now, startImmediately: false });
  }

  /** Admit directly to an active lease when the caller can start work now. */
  accept(entry: RoutingQueueEntry<T>, now?: QueueTime): QueueAdmissionDecision<T> {
    return this.admit(entry, { now, startImmediately: true });
  }

  /**
   * Remove the oldest runnable item and return its active lease. Expired,
   * cancelled, terminal, working, and otherwise non-runnable items are removed
   * without ever being handed to an executor.
   */
  dequeue(now?: QueueTime): QueueLease<T> | undefined {
    const resolvedNow = this.resolveAdmissionTime(now);
    this.expire(resolvedNow);

    if (this.active.size >= this.activeCapacity) {
      return undefined;
    }

    while (this.queue.length > 0) {
      const record = this.queue.shift();
      if (record === undefined) {
        return undefined;
      }

      const lease = this.claimRecord(record);
      if (lease !== undefined) {
        return lease;
      }

      if (this.active.size >= this.activeCapacity) {
        this.queue.unshift(record);
        return undefined;
      }

      const observedNow = this.lastObservedNow;
      if (record.deadline <= observedNow || record.expired) {
        this.markExpired(record);
      }

      this.removeRecord(record);
    }

    return undefined;
  }

  /**
   * Release an active lease (or remove a still-queued item) without starting
   * another item implicitly. Releasing an expired active lease is the explicit
   * executor stop/release acknowledgment that frees its active capacity.
   */
  release(target: QueueHandle<T>, requestId?: string): boolean {
    const lookup = this.findRecord(target, requestId);
    if (lookup.kind !== 'found') {
      return false;
    }

    if (lookup.record.status !== 'active' && lookup.record.status !== 'queued') {
      return false;
    }

    this.removeRecord(lookup.record);
    return true;
  }

  /**
   * Cancel one retained record and return an explicit outcome. Queued
   * cancellation is linearized by checking expiry immediately before marking
   * the record cancelled and removing it. Active cancellation only requests
   * cooperative stop; it never frees the active slot.
   */
  cancel(target: QueueHandle<T>, requestId?: string): QueueCancellationDecision<T> {
    const lookup = this.findRecord(target, requestId);
    if (lookup.kind === 'not_found') {
      return this.notFoundCancellation();
    }
    if (lookup.kind === 'ambiguous') {
      return this.ambiguousCancellation();
    }

    return this.cancelRecord(lookup.record);
  }

  /** Cancel by request identity only when that identity resolves uniquely. */
  cancelByRequestId(requestId: string): QueueCancellationDecision<T> {
    const records = this.requestIds.get(requestId);
    if (records === undefined || records.size === 0) {
      return this.notFoundCancellation();
    }
    if (records.size !== 1) {
      return this.ambiguousCancellation();
    }

    const record = records.values().next().value as QueueRecord<T> | undefined;
    return record === undefined ? this.notFoundCancellation() : this.cancelRecord(record);
  }

  /**
   * Remove expired queued records and mark expired active records. Active
   * records remain retained and continue consuming active capacity until
   * `release` is called.
   */
  expire(now?: QueueTime): readonly RoutingQueueEntry<T>[] {
    const resolvedNow = this.resolveAdmissionTime(now);
    const expired: RoutingQueueEntry<T>[] = [];

    for (let index = this.queue.length - 1; index >= 0; index -= 1) {
      const record = this.queue[index];

      if (record.deadline <= resolvedNow) {
        this.removeRecord(record);
        this.markExpired(record);
        expired.push(record.entry);
      } else if (!isRunnableRecord(record, resolvedNow)) {
        this.removeRecord(record);
      }
    }

    for (const record of this.active.values()) {
      if (record.deadline <= resolvedNow && !record.expired) {
        record.expired = true;
        this.markExpired(record);
        expired.push(record.entry);
      }
    }

    return expired;
  }

  /** Alias for callers that use purge terminology. */
  purgeExpired(now?: QueueTime): readonly RoutingQueueEntry<T>[] {
    return this.expire(now);
  }

  /** Whether a retained queued item is still eligible to start. */
  isRunnable(target: QueueHandle<T>, now?: QueueTime): boolean {
    const resolvedNow = this.resolveAdmissionTime(now);
    this.expire(resolvedNow);

    const lookup = this.findRecord(target);
    return lookup.kind === 'found' && isRunnableRecord(lookup.record, this.lastObservedNow);
  }

  /** Return the next retained queue item without starting it. */
  peek(now?: QueueTime): RoutingQueueEntry<T> | undefined {
    const resolvedNow = this.resolveAdmissionTime(now);
    this.expire(resolvedNow);
    return this.queue[0]?.entry;
  }

  private resolveAdmissionTime(value: QueueTime | undefined): number {
    return this.readMonotonicNow(value);
  }

  private readMonotonicNow(override?: QueueTime): number {
    const candidate =
      override === undefined ? resolveTime(this.monotonicNow()) : resolveTime(override);

    if (candidate < this.lastObservedNow) {
      return this.lastObservedNow;
    }

    this.lastObservedNow = candidate;
    return candidate;
  }

  private createRecord(entry: RoutingQueueEntry<T>): QueueRecord<T> {
    if (entry === null || typeof entry !== 'object') {
      throw new TypeError('queue entry must be an object');
    }

    if (
      (entry.id !== undefined && (typeof entry.id !== 'string' || entry.id.length === 0)) ||
      (entry.requestId !== undefined &&
        (typeof entry.requestId !== 'string' || entry.requestId.length === 0))
    ) {
      throw new TypeError('queue entry id and requestId must be non-empty strings when provided');
    }

    let handle: string;
    do {
      handle = `queue:${randomUUID()}`;
    } while (this.handles.has(handle));

    return {
      token: this.nextToken++,
      handle,
      entry,
      deadline: resolveDeadline(entry.expiresAt),
      status: 'candidate',
      expired: false,
      expiryNotified: false,
      cancellationRequested: false,
    };
  }

  private registerRecord(record: QueueRecord<T>): void {
    this.handles.set(record.handle, record);

    const entryRecords = this.entries.get(record.entry);
    if (entryRecords === undefined) {
      this.entries.set(record.entry, new Set([record]));
    } else {
      entryRecords.add(record);
    }

    if (record.entry.id !== undefined) {
      const idRecords = this.entryIds.get(record.entry.id);
      if (idRecords === undefined) {
        this.entryIds.set(record.entry.id, new Set([record]));
      } else {
        idRecords.add(record);
      }
    }

    if (record.entry.requestId !== undefined) {
      const requestRecords = this.requestIds.get(record.entry.requestId);
      if (requestRecords === undefined) {
        this.requestIds.set(record.entry.requestId, new Set([record]));
      } else {
        requestRecords.add(record);
      }
    }
  }

  private claimRecord(record: QueueRecord<T>): QueueLease<T> | undefined {
    if (this.active.size >= this.activeCapacity) {
      return undefined;
    }

    if (!isRunnableRecord(record, this.readMonotonicNow())) {
      return undefined;
    }

    // This second check is deliberately adjacent to the active handoff. It
    // closes the expiry/cancellation race between admission and execution.
    if (!isRunnableRecord(record, this.readMonotonicNow())) {
      return undefined;
    }

    if (this.active.size >= this.activeCapacity) {
      return undefined;
    }

    record.status = 'active';
    this.active.set(record.token, record);
    return this.createLease(record);
  }

  private createLease(record: QueueRecord<T>): QueueLease<T> {
    if (record.lease !== undefined) {
      return record.lease;
    }

    const lease: QueueLease<T> = {
      id: record.handle,
      handle: record.handle,
      ...(record.entry.requestId === undefined ? {} : { requestId: record.entry.requestId }),
      value: record.entry.value,
      entry: record.entry,
      expiresAt: record.deadline,
      state: 'working',
    };
    record.lease = lease;
    this.leases.set(lease, record);
    return lease;
  }

  private findRecord(target: QueueHandle<T>, requestId?: string): RecordLookup<T> {
    let lookup: RecordLookup<T>;

    if (typeof target === 'string') {
      const handleRecord = this.handles.get(target);
      if (handleRecord !== undefined) {
        lookup = { kind: 'found', record: handleRecord };
      } else {
        const idRecords = this.entryIds.get(target);
        const requestRecords = this.requestIds.get(target);
        const identityRecords = idRecords ?? requestRecords;
        lookup =
          identityRecords === undefined
            ? { kind: 'not_found' }
            : this.lookupEntryRecords(identityRecords, requestId);
      }
    } else {
      const leaseRecord = this.leases.get(target);
      if (leaseRecord !== undefined) {
        lookup = { kind: 'found', record: leaseRecord };
      } else {
        const entryRecords = this.entries.get(target);
        if (entryRecords !== undefined) {
          lookup = this.lookupEntryRecords(entryRecords, requestId);
        } else if (isQueueHandleReference(target)) {
          const record = this.handles.get(target.handle);
          lookup = record === undefined ? { kind: 'not_found' } : { kind: 'found', record };
          if (
            lookup.kind === 'found' &&
            target.requestId !== undefined &&
            lookup.record.entry.requestId !== target.requestId
          ) {
            lookup = { kind: 'not_found' };
          }
        } else {
          lookup = { kind: 'not_found' };
        }
      }
    }

    if (
      requestId !== undefined &&
      lookup.kind === 'found' &&
      lookup.record.entry.requestId !== requestId
    ) {
      return { kind: 'not_found' };
    }

    return lookup;
  }

  private lookupEntryRecords(records: Set<QueueRecord<T>>, requestId?: string): RecordLookup<T> {
    const candidates =
      requestId === undefined
        ? [...records]
        : [...records].filter((record) => record.entry.requestId === requestId);

    if (candidates.length === 0) {
      return { kind: 'not_found' };
    }
    if (candidates.length !== 1) {
      return { kind: 'ambiguous' };
    }

    return { kind: 'found', record: candidates[0] };
  }

  private removeRecord(record: QueueRecord<T>): void {
    if (this.active.get(record.token) === record) {
      this.active.delete(record.token);
    } else {
      const queueIndex = this.queue.indexOf(record);
      if (queueIndex >= 0) {
        this.queue.splice(queueIndex, 1);
      }
    }

    if (this.handles.get(record.handle) === record) {
      this.handles.delete(record.handle);
    }

    const entryRecords = this.entries.get(record.entry);
    if (entryRecords !== undefined) {
      entryRecords.delete(record);
      if (entryRecords.size === 0) {
        this.entries.delete(record.entry);
      }
    }

    if (record.entry.id !== undefined) {
      const idRecords = this.entryIds.get(record.entry.id);
      if (idRecords !== undefined) {
        idRecords.delete(record);
        if (idRecords.size === 0) {
          this.entryIds.delete(record.entry.id);
        }
      }
    }

    if (record.entry.requestId !== undefined) {
      const requestRecords = this.requestIds.get(record.entry.requestId);
      if (requestRecords !== undefined) {
        requestRecords.delete(record);
        if (requestRecords.size === 0) {
          this.requestIds.delete(record.entry.requestId);
        }
      }
    }

    if (record.lease !== undefined) {
      this.leases.delete(record.lease);
      record.lease = undefined;
    }

    record.status = 'released';
  }

  private markExpired(record: QueueRecord<T>): void {
    record.expired = true;
    if (record.expiryNotified) {
      return;
    }

    record.expiryNotified = true;
    this.onExpired?.(record.entry);
  }

  private cancelRecord(record: QueueRecord<T>): QueueCancellationDecision<T> {
    let now = this.readMonotonicNow();
    if (record.expired || record.deadline <= now) {
      if (record.status !== 'active') {
        this.removeRecord(record);
      }
      this.markExpired(record);
      return this.expiredCancellation(record);
    }

    if (record.status === 'active') {
      now = this.readMonotonicNow();
      if (record.deadline <= now) {
        this.markExpired(record);
        return this.expiredCancellation(record);
      }
      if (record.cancellationRequested || isEntryCancellationRequested(record.entry)) {
        record.cancellationRequested = true;
        return this.cancellingCancellation(record);
      }
      if (isTerminalOrAbortedState(record.entry.state)) {
        return this.notCancelable(record);
      }

      record.cancellationRequested = true;
      return this.cancellingCancellation(record);
    }

    if (record.status !== 'queued') {
      return this.notCancelable(record);
    }

    if (isEntryCancellationRequested(record.entry)) {
      // The external cancellation marker is observed before this policy's
      // removal, so the cancellation outcome remains explicit and linearized.
      record.cancellationRequested = true;
      record.status = 'cancelled';
      const outcome = this.cancelledCancellation(record);
      this.removeRecord(record);
      return outcome;
    }

    // Read the monotonic source at the cancellation commit point, not only at
    // lookup time. Expiry wins if the deadline passed while resolving the
    // cancellation target.
    now = this.readMonotonicNow();
    if (record.deadline <= now) {
      this.removeRecord(record);
      this.markExpired(record);
      return this.expiredCancellation(record);
    }

    if (!isRunnableRecord(record, now)) {
      if (isEntryCancellationRequested(record.entry)) {
        record.cancellationRequested = true;
        record.status = 'cancelled';
        const outcome = this.cancelledCancellation(record);
        this.removeRecord(record);
        return outcome;
      }

      const outcome = this.notCancelable(record);
      this.removeRecord(record);
      return outcome;
    }

    record.cancellationRequested = true;
    record.status = 'cancelled';
    const outcome = this.cancelledCancellation(record);
    this.removeRecord(record);
    return outcome;
  }

  private cancellationRecord(record: QueueRecord<T>): QueueCancellationRecord<T> {
    return {
      entry: record.entry,
      handle: record.handle,
      ...(record.entry.requestId === undefined ? {} : { requestId: record.entry.requestId }),
    };
  }

  private cancelledCancellation(record: QueueRecord<T>): CancelledQueueRecord<T> {
    return {
      state: 'cancelled',
      ...this.cancellationRecord(record),
      error: createProtocolError('cancelled', 'Queue entry was cancelled'),
    };
  }

  private cancellingCancellation(record: QueueRecord<T>): CancellingQueueRecord<T> {
    return {
      state: 'cancelling',
      ...this.cancellationRecord(record),
      error: createProtocolError('cancelled', 'Active queue lease cancellation was requested'),
    };
  }

  private expiredCancellation(record: QueueRecord<T>): ExpiredQueueRecord<T> {
    return {
      state: 'expired',
      ...this.cancellationRecord(record),
      error: createProtocolError('expired', 'Queue entry has expired'),
    };
  }

  private notCancelable(record: QueueRecord<T>): NotCancelableQueueRecord<T> {
    return {
      state: 'not_cancelable',
      ...this.cancellationRecord(record),
      error: createProtocolError('not_cancelable', 'Queue entry is no longer cancelable'),
    };
  }

  private notFoundCancellation(): NotFoundQueueRecord {
    return {
      state: 'not_found',
      error: createProtocolError('not_found', 'Queue entry was not found'),
    };
  }

  private ambiguousCancellation(): AmbiguousQueueRecord {
    return {
      state: 'ambiguous',
      error: createProtocolError('ambiguous', 'Queue handle identifies multiple queue entries'),
    };
  }

  private admissionDecisionFor(
    record: QueueRecord<T>,
    now: number,
  ): ExpiredAdmission | CancelledAdmission {
    if (record.expired || record.deadline <= now) {
      return this.expiredDecision();
    }

    return this.cancelledDecision();
  }

  private busyDecision(): BusyAdmission {
    return {
      state: 'busy',
      error: createProtocolError('busy', 'Routing capacity is temporarily unavailable', {
        ...(this.retryAfterMs === undefined ? {} : { retryAfterMs: this.retryAfterMs }),
        details: {
          capacity: this.queueCapacity,
          queueCapacity: this.queueCapacity,
          activeCapacity: this.activeCapacity,
          queued: this.queue.length,
          active: this.active.size,
        },
      }),
    };
  }

  private expiredDecision(): ExpiredAdmission {
    return {
      state: 'expired',
      error: createProtocolError('expired', 'Queue entry has expired'),
    };
  }

  private cancelledDecision(): CancelledAdmission {
    return {
      state: 'cancelled',
      error: createProtocolError('cancelled', 'Queue entry is not runnable'),
    };
  }
}

export function createRoutingPolicy<T = unknown>(
  options: RoutingPolicyOptions<T> = {},
): RoutingPolicy<T> {
  return new RoutingPolicy(options);
}
