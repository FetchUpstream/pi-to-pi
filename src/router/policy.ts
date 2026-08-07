import { DEFAULT_QUEUE_LIMIT } from '../config.js';
import type { ProtocolLimits } from '../protocol/agent-card.js';
import {
  createProtocolError,
  type ProtocolError,
  type RetryableProtocolError,
} from '../protocol/errors.js';

/** The v1 default and maximum queue capacity. */
export const DEFAULT_QUEUE_CAPACITY = DEFAULT_QUEUE_LIMIT;

/** Values accepted for an absolute queue-entry deadline. */
export type QueueDeadline = number | Date | string;
export type QueueTime = number | Date;

/**
 * A transport- and executor-independent item that can be admitted by the
 * routing policy.  The policy retains only this reference; it does not clone,
 * serialize, or execute `value`.
 */
export interface RoutingQueueEntry<T> {
  /** An optional local identifier used when releasing or cancelling an item. */
  readonly id?: string;
  /** The protocol request identifier, when the item represents a request. */
  readonly requestId?: string;
  readonly value: T;
  /** An absolute deadline; the item is not runnable at or after this time. */
  readonly expiresAt: QueueDeadline;
  /** Static or externally observed cancellation state. */
  readonly cancelled?: boolean;
  readonly state?: string;
  readonly isCancelled?: () => boolean;
  readonly signal?: Pick<AbortSignal, 'aborted'>;
}

export type QueueEntry<T> = RoutingQueueEntry<T>;

export interface RoutingPolicyOptions<T = unknown> {
  /** Maximum number of retained admitted items, including active leases. */
  readonly capacity?: number;
  /** Alias for `capacity`. */
  readonly queueCapacity?: number;
  /** Alias for `capacity`, useful when passing configured protocol limits. */
  readonly maxQueueEntries?: number;
  /** A configured protocol limit may make the effective capacity stricter. */
  readonly limits?: Pick<ProtocolLimits, 'maxQueueEntries'>;
  /** Inject a deterministic clock for tests; values use the same units as deadlines. */
  readonly now?: () => number;
  /** Alias for `now`. */
  readonly clock?: () => number;
  /** Optional retry hint included in a `busy` error. */
  readonly retryAfterMs?: number;
  /** Called when the policy removes an expired retained item. */
  readonly onExpired?: (entry: RoutingQueueEntry<T>) => void;
}

export interface AdmissionOptions {
  /** Admit directly as `accepted`; otherwise retain the item as `queued`. */
  readonly startImmediately?: boolean;
  /** Override the injected clock for this admission. */
  readonly now?: QueueTime;
}

export interface QueueLease<T> {
  readonly id: string;
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

export type QueueHandle<T> = QueueLease<T> | RoutingQueueEntry<T> | string;

interface QueueRecord<T> {
  readonly token: number;
  readonly id: string;
  readonly entry: RoutingQueueEntry<T>;
  readonly deadline: number;
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

function resolveCapacity<T>(options: RoutingPolicyOptions<T>): number {
  const configured = [
    options.capacity,
    options.queueCapacity,
    options.maxQueueEntries,
    options.limits?.maxQueueEntries,
  ].filter((value): value is number => value !== undefined);

  const capacity = configured[0] ?? DEFAULT_QUEUE_CAPACITY;

  if (configured.some((value) => value !== capacity)) {
    throw new RangeError('queue capacity aliases must agree');
  }

  if (!Number.isSafeInteger(capacity) || capacity < 1) {
    throw new RangeError('queue capacity must be a positive safe integer');
  }

  if (capacity > DEFAULT_QUEUE_CAPACITY) {
    throw new RangeError(`queue capacity must not exceed ${DEFAULT_QUEUE_CAPACITY}`);
  }

  return capacity;
}

function validateRetryAfterMs(retryAfterMs: number | undefined): void {
  if (retryAfterMs !== undefined && (!Number.isFinite(retryAfterMs) || retryAfterMs <= 0)) {
    throw new RangeError('retryAfterMs must be a finite positive number');
  }
}

function entryIsCancelled<T>(entry: RoutingQueueEntry<T>): boolean {
  return (
    entry.cancelled === true ||
    entry.state === 'cancelled' ||
    entry.state === 'cancelling' ||
    entry.signal?.aborted === true ||
    entry.isCancelled?.() === true
  );
}

/**
 * A bounded, instance-scoped admission queue.
 *
 * `capacity` bounds all records retained by this object.  A direct accepted
 * item occupies one active lease, while a queued item occupies one queue
 * slot.  `busy` never creates a record, so retrying the same operation remains
 * possible until the caller's original deadline.
 */
export class RoutingPolicy<T = unknown> {
  readonly capacity: number;

  private readonly now: () => number;
  private readonly retryAfterMs: number | undefined;
  private readonly onExpired: ((entry: RoutingQueueEntry<T>) => void) | undefined;
  private readonly queue: QueueRecord<T>[] = [];
  private readonly active = new Map<number, QueueRecord<T>>();
  private readonly leases = new WeakMap<object, QueueRecord<T>>();
  private nextToken = 1;

  constructor(options: RoutingPolicyOptions<T> = {}) {
    this.capacity = resolveCapacity(options);
    this.now = options.clock ?? options.now ?? Date.now;
    this.retryAfterMs = options.retryAfterMs;
    this.onExpired = options.onExpired;
    validateRetryAfterMs(this.retryAfterMs);

    if (!Number.isFinite(this.now())) {
      throw new RangeError('queue clock must return a finite number');
    }
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

  get availableCapacity(): number {
    return this.capacity - this.size;
  }

  /**
   * Admit an item.  By default it is queued; pass `startImmediately: true`
   * only when the caller has an executor slot ready for the returned lease.
   */
  admit(
    entry: RoutingQueueEntry<T>,
    options?: AdmissionOptions | boolean,
  ): QueueAdmissionDecision<T> {
    const admissionOptions =
      typeof options === 'boolean' ? { startImmediately: options } : (options ?? {});
    const now = this.resolveAdmissionTime(admissionOptions.now);

    this.expire(now);

    const record = this.createRecord(entry);

    if (record.deadline <= now) {
      return this.expiredDecision();
    }

    if (entryIsCancelled(entry)) {
      return this.cancelledDecision();
    }

    if (this.size >= this.capacity) {
      return this.busyDecision();
    }

    if (admissionOptions.startImmediately === true) {
      this.active.set(record.token, record);
      return {
        state: 'accepted',
        lease: this.createLease(record),
      };
    }

    this.queue.push(record);
    return {
      state: 'queued',
      entry,
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
   * Remove the oldest runnable item and return its active lease.  Expired or
   * cancelled items are removed before a lease is returned and can never be
   * handed to an executor.
   */
  dequeue(now?: QueueTime): QueueLease<T> | undefined {
    const resolvedNow = this.resolveAdmissionTime(now);
    this.expire(resolvedNow);

    while (this.queue.length > 0) {
      const record = this.queue.shift();

      if (record === undefined) {
        return undefined;
      }

      if (record.deadline <= resolvedNow) {
        this.notifyExpired(record);
        continue;
      }

      if (entryIsCancelled(record.entry)) {
        continue;
      }

      this.active.set(record.token, record);
      return this.createLease(record);
    }

    return undefined;
  }

  /**
   * Release an active lease (or remove a still-queued item) without starting
   * another item implicitly.  The caller can then call `dequeue` when its
   * executor has capacity.
   */
  release(target: QueueHandle<T>): boolean {
    const record = this.findRecord(target);

    if (record === undefined) {
      return false;
    }

    if (this.active.get(record.token) === record) {
      this.active.delete(record.token);
      return true;
    }

    const queueIndex = this.queue.indexOf(record);

    if (queueIndex >= 0) {
      this.queue.splice(queueIndex, 1);
      return true;
    }

    return false;
  }

  /** Remove a queued item before it can start. */
  cancel(target: QueueHandle<T>): boolean {
    const record = this.findRecord(target);

    if (record === undefined || this.active.get(record.token) === record) {
      return false;
    }

    const queueIndex = this.queue.indexOf(record);

    if (queueIndex < 0) {
      return false;
    }

    this.queue.splice(queueIndex, 1);
    return true;
  }

  /**
   * Remove all expired retained records and return the entries that were
   * expired.  Cancellation is intentionally not reported as expiry.
   */
  expire(now?: QueueTime): readonly RoutingQueueEntry<T>[] {
    const resolvedNow = this.resolveAdmissionTime(now);
    const expired: RoutingQueueEntry<T>[] = [];

    for (let index = this.queue.length - 1; index >= 0; index -= 1) {
      const record = this.queue[index];

      if (record.deadline <= resolvedNow) {
        this.queue.splice(index, 1);
        expired.push(record.entry);
        this.notifyExpired(record);
      } else if (entryIsCancelled(record.entry)) {
        this.queue.splice(index, 1);
      }
    }

    for (const [token, record] of this.active) {
      if (record.deadline <= resolvedNow) {
        this.active.delete(token);
        expired.push(record.entry);
        this.notifyExpired(record);
      }
    }

    return expired;
  }

  /** Alias for callers that use purge terminology. */
  purgeExpired(now?: QueueTime): readonly RoutingQueueEntry<T>[] {
    return this.expire(now);
  }

  /** Whether a retained item is still eligible to start at the supplied time. */
  isRunnable(target: QueueHandle<T>, now?: QueueTime): boolean {
    const record = this.findRecord(target);

    if (record === undefined) {
      return false;
    }

    const resolvedNow = this.resolveAdmissionTime(now);
    return record.deadline > resolvedNow && !entryIsCancelled(record.entry);
  }

  /** Return the next retained queue item without starting it. */
  peek(now?: QueueTime): RoutingQueueEntry<T> | undefined {
    const resolvedNow = this.resolveAdmissionTime(now);
    this.expire(resolvedNow);
    return this.queue[0]?.entry;
  }

  private resolveAdmissionTime(value: QueueTime | undefined): number {
    return value === undefined ? resolveTime(this.now()) : resolveTime(value);
  }

  private createRecord(entry: RoutingQueueEntry<T>): QueueRecord<T> {
    if (entry === null || typeof entry !== 'object') {
      throw new TypeError('queue entry must be an object');
    }

    const id = entry.id ?? entry.requestId ?? `queue-entry-${this.nextToken}`;

    if (typeof id !== 'string' || id.length === 0) {
      throw new TypeError('queue entry id or requestId must be a non-empty string');
    }

    const token = this.nextToken;
    this.nextToken += 1;

    return {
      token,
      id,
      entry,
      deadline: resolveDeadline(entry.expiresAt),
    };
  }

  private createLease(record: QueueRecord<T>): QueueLease<T> {
    const lease: QueueLease<T> = {
      id: record.id,
      ...(record.entry.requestId === undefined ? {} : { requestId: record.entry.requestId }),
      value: record.entry.value,
      entry: record.entry,
      expiresAt: record.deadline,
      state: 'working',
    };
    this.leases.set(lease, record);
    return lease;
  }

  private findRecord(target: QueueHandle<T>): QueueRecord<T> | undefined {
    if (typeof target === 'string') {
      return this.findById(target);
    }

    const leaseRecord = this.leases.get(target);

    if (leaseRecord !== undefined) {
      return leaseRecord;
    }

    for (const record of this.active.values()) {
      if (record.entry === target) {
        return record;
      }
    }

    return this.queue.find((record) => record.entry === target);
  }

  private findById(id: string): QueueRecord<T> | undefined {
    for (const record of this.active.values()) {
      if (record.id === id) {
        return record;
      }
    }

    return this.queue.find((record) => record.id === id);
  }

  private notifyExpired(record: QueueRecord<T>): void {
    this.onExpired?.(record.entry);
  }

  private busyDecision(): BusyAdmission {
    return {
      state: 'busy',
      error: createProtocolError('busy', 'Routing capacity is temporarily unavailable', {
        ...(this.retryAfterMs === undefined ? {} : { retryAfterMs: this.retryAfterMs }),
        details: {
          capacity: this.capacity,
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
      error: createProtocolError('cancelled', 'Queue entry has been cancelled'),
    };
  }
}

export function createRoutingPolicy<T = unknown>(
  options: RoutingPolicyOptions<T> = {},
): RoutingPolicy<T> {
  return new RoutingPolicy(options);
}
