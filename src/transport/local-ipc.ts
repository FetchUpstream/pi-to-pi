/**
 * Minimal local binding for the transport-independent adapter contract.
 *
 * The binding intentionally does not choose a socket, framing, serializer, or
 * authentication scheme.  Values are delivered directly to hooks registered in
 * one process, which gives lifecycle and integration code a deterministic
 * boundary without putting concrete framing into `transport.ts`.
 */
import { DEFAULT_REQUEST_TTL_MS, DEDUPE_RETENTION_GRACE_MS } from '../config.js';
import type { RuntimePersistence } from '../pi/persistence.js';

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

export type LocalIpcBindingErrorCode = 'closed' | 'invalid_target' | 'duplicate';

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
  timer?: unknown;
}

interface IssuedRuntimeRecord {
  readonly retired: boolean;
  readonly retainedUntil: number;
  timer?: unknown;
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
const DEFAULT_DELIVERY_TIMEOUT_MS = 10_000;
const MAX_TIMER_DELAY_MS = 2_147_483_647;
const DEFAULT_RUNTIME_ID_RETENTION_MS = DEDUPE_RETENTION_GRACE_MS;

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

function operationDeadline(value: unknown, nowMs: number): number {
  if (typeof value !== 'string' && typeof value !== 'number' && !(value instanceof Date)) {
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
  return Number.isFinite(parsed) ? parsed : nowMs + DEFAULT_REQUEST_TTL_MS;
}

function retentionDeadline(value: unknown, nowMs: number, graceMs: number): number {
  const retainedUntil = operationDeadline(value, nowMs) + graceMs;
  return Number.isFinite(retainedUntil) ? retainedUntil : nowMs + DEFAULT_REQUEST_TTL_MS + graceMs;
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
  if (
    typeof candidate.runtimeId !== 'string' ||
    candidate.runtimeId.length === 0 ||
    /\p{C}/u.test(candidate.runtimeId)
  ) {
    throw new LocalIpcBindingError(
      'invalid_target',
      'local IPC target runtimeId must be non-empty text without control characters',
    );
  }
  const endpoint = validateEndpoint(candidate.endpoint);
  return Object.freeze({
    runtimeId: candidate.runtimeId,
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
  const operationId = (value as { readonly operationId?: unknown }).operationId;
  return typeof operationId === 'string' && operationId.length > 0 ? operationId : undefined;
}

function senderRuntimeIdOf(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null || !('sender' in value)) {
    return undefined;
  }
  const sender = (value as { readonly sender?: unknown }).sender;
  if (typeof sender !== 'object' || sender === null || !('runtimeId' in sender)) {
    return undefined;
  }
  const runtimeId = (sender as { readonly runtimeId?: unknown }).runtimeId;
  return typeof runtimeId === 'string' && runtimeId.length > 0 ? runtimeId : undefined;
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
  if (!Number.isFinite(timeout) || timeout <= 0) {
    throw new RangeError('deliveryTimeoutMs must be a finite positive number');
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
  private readonly operationDestinations = new Map<string, OperationDestinationRecord>();
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
    this.retentionGraceMs = options.retentionGraceMs ?? DEDUPE_RETENTION_GRACE_MS;
    this.runtimeIdRetentionMs = options.runtimeIdRetentionMs ?? DEFAULT_RUNTIME_ID_RETENTION_MS;
    if (!Number.isFinite(this.retentionGraceMs) || this.retentionGraceMs < 0) {
      throw new RangeError('retentionGraceMs must be a finite non-negative number');
    }
    if (!Number.isFinite(this.runtimeIdRetentionMs) || this.runtimeIdRetentionMs < 0) {
      throw new RangeError('runtimeIdRetentionMs must be a finite non-negative number');
    }
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
    this.prune();
    const key = `${senderRuntimeId}\u0000${operationId}`;
    const previous = this.operationDestinations.get(key);
    if (previous !== undefined) {
      if (previous.stale || previous.recipientRuntimeId !== recipientRuntimeId) {
        previous.stale = true;
        return null;
      }
      return { key, created: false };
    }
    const nowMs = finiteClock(this.now());
    const record: OperationDestinationRecord = {
      recipientRuntimeId,
      retainedUntil: retentionDeadline(expiresAt, nowMs, this.retentionGraceMs),
      stale: false,
    };
    this.operationDestinations.set(key, record);
    this.scheduleOperationDestination(key, record);
    return { key, created: true };
  }

  public prune(nowMs = finiteClock(this.now())): number {
    if (!Number.isFinite(nowMs)) {
      throw new RangeError('local IPC clock must return a finite number');
    }
    let removed = 0;
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
    if (this.records.get(record.key) !== record) {
      return false;
    }
    this.deactivate(record);
    this.records.delete(record.key);
    if (this.runtimes.get(record.target.runtimeId) === record) {
      this.runtimes.delete(record.target.runtimeId);
    }
    this.retireRuntimeId(record.target.runtimeId);
    if (notice === undefined) {
      return true;
    }

    const peers = [...this.records.values()].filter((peer) => this.isCurrent(peer));
    await Promise.all(
      peers.map(async (peer) => {
        const onShutdown = peer.hooks.onShutdown;
        if (onShutdown === undefined) {
          return;
        }
        try {
          await waitForHook(
            () => onShutdown(notice),
            timeoutMs,
            this.setTimeout,
            this.clearTimeout,
          );
        } catch {
          // Shutdown notices are best effort; a peer hook cannot keep the
          // closing runtime alive indefinitely.
        }
      }),
    );
    return true;
  }

  public async closeAll(): Promise<void> {
    const records = [...this.records.values()];
    await Promise.all(records.map((record) => this.unregister(record)));
  }

  private retireRuntimeId(runtimeId: string): void {
    const nowMs = finiteClock(this.now());
    const record: IssuedRuntimeRecord = {
      retired: true,
      retainedUntil: nowMs + this.runtimeIdRetentionMs,
    };
    const previous = this.issuedRuntimeIds.get(runtimeId);
    if (previous?.timer !== undefined) {
      this.clearTimeout(previous.timer);
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
      this.clearTimeout(record.timer);
      record.timer = undefined;
    }
    this.issuedRuntimeIds.delete(runtimeId);
  }

  private removeOperationDestination(key: string, record: OperationDestinationRecord): void {
    if (this.operationDestinations.get(key) !== record) {
      return;
    }
    if (record.timer !== undefined) {
      this.clearTimeout(record.timer);
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
  let timer: unknown;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeoutFn(() => reject(new LocalIpcDeliveryTimeout()), timeoutMs);
  });
  try {
    return await Promise.race([Promise.resolve().then(hook), timeout]);
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
  /** Per-adapter guard; the registry carries the process-shared copy. */
  private readonly operationDestinations = new Map<string, OperationDestinationRecord>();
  private readonly inFlight = new Set<Promise<unknown>>();
  private readonly now: () => number;
  private readonly setTimeout: LocalIpcSetTimeout;
  private readonly clearTimeout: LocalIpcClearTimeout;
  private readonly retentionGraceMs: number;
  private closedState = false;
  private closePromise: Promise<void> | undefined;

  public constructor(options: LocalIpcTransportOptions = {}) {
    this.registry = options.registry ?? DEFAULT_LOCAL_IPC_REGISTRY;
    this.deliveryTimeoutMs = timeoutValue(options.deliveryTimeoutMs);
    this.persistence = options.persistence ?? options.runtimePersistence;
    this.now = options.now ?? (() => Date.now());
    this.setTimeout = options.setTimeout ?? defaultSetTimeout;
    this.clearTimeout = options.clearTimeout ?? defaultClearTimeout;
    this.retentionGraceMs = options.retentionGraceMs ?? DEDUPE_RETENTION_GRACE_MS;
    if (!Number.isFinite(this.retentionGraceMs) || this.retentionGraceMs < 0) {
      throw new RangeError('retentionGraceMs must be a finite non-negative number');
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
    while (this.inFlight.size > 0) {
      await Promise.allSettled([...this.inFlight]);
    }
    this.pruneOperationDestinations(finiteClock(this.now()));
  }

  private async deliverEnvelope(
    target: TransportRuntimeTarget<LocalIpcEndpoint>,
    envelope: Envelope,
  ): Promise<TransportDeliveryResult<LocalIpcEndpoint>> {
    const operationId = operationIdOf(envelope);
    if (this.closedState) {
      return failure('closed', 'local IPC transport is closed', target, operationId);
    }

    let normalizedTarget: LocalIpcRuntimeTarget;
    try {
      normalizedTarget = validateTarget(target);
    } catch (error) {
      return failure('invalid_target', 'local IPC target is invalid', target, operationId, error);
    }

    const record = this.registry.resolve(normalizedTarget);
    if (record === undefined) {
      return this.unreachableFailure(
        'local IPC runtime endpoint is not currently reachable',
        normalizedTarget,
        operationId,
        envelope.expiresAt,
      );
    }
    if (!this.registry.isCurrent(record, normalizedTarget)) {
      return this.unreachableFailure(
        'local IPC runtime endpoint was replaced before delivery',
        normalizedTarget,
        operationId,
        envelope.expiresAt,
      );
    }

    const senderRuntimeId = senderRuntimeIdOf(envelope);
    const reservation =
      senderRuntimeId === undefined || operationId === undefined
        ? undefined
        : this.reserveOperation(
            senderRuntimeId,
            operationId,
            normalizedTarget.runtimeId,
            envelope.expiresAt,
          );
    if (reservation === null) {
      return this.unreachableFailure(
        'operationId belongs to an earlier runtime endpoint; create a new operationId',
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
      return this.unreachableFailure(
        'local IPC runtime endpoint was replaced before hook invocation',
        normalizedTarget,
        operationId,
        envelope.expiresAt,
      );
    }

    try {
      const hook = waitForHook(
        () => {
          if (!this.registry.isCurrent(record, normalizedTarget)) {
            throw new LocalIpcDeliveryStale();
          }
          return (
            record.hooks.onEnvelope as unknown as (
              inbound: TransportInboundEnvelope<Envelope, Response, LocalIpcEndpoint>,
            ) => void | PromiseLike<void>
          )(delivery);
        },
        this.deliveryTimeoutMs,
        this.setTimeout,
        this.clearTimeout,
      );
      await this.trackRecord(record, hook);
      if (!this.registry.isCurrent(record, normalizedTarget)) {
        return this.unreachableFailure(
          'local IPC runtime endpoint closed during delivery',
          normalizedTarget,
          operationId,
          envelope.expiresAt,
        );
      }
      return delivered(operationId);
    } catch (error) {
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
    const operationId = operationIdOf(response);
    if (this.closedState) {
      return failure('closed', 'local IPC transport is closed', target, operationId);
    }

    let normalizedTarget: LocalIpcRuntimeTarget;
    try {
      normalizedTarget = validateTarget(target);
    } catch (error) {
      return failure('invalid_target', 'local IPC target is invalid', target, operationId, error);
    }

    const record = this.registry.resolve(normalizedTarget);
    if (record === undefined) {
      return this.unreachableFailure(
        'local IPC runtime endpoint is not currently reachable',
        normalizedTarget,
        operationId,
      );
    }
    if (!this.registry.isCurrent(record, normalizedTarget)) {
      return this.unreachableFailure(
        'local IPC runtime endpoint was replaced before response delivery',
        normalizedTarget,
        operationId,
      );
    }

    const localSource = this.firstBoundTarget() ?? normalizedTarget;
    const reservation =
      operationId === undefined
        ? undefined
        : this.reserveOperation(localSource.runtimeId, operationId, normalizedTarget.runtimeId);
    if (reservation === null) {
      return this.unreachableFailure(
        'operationId belongs to an earlier runtime endpoint; create a new operationId',
        normalizedTarget,
        operationId,
      );
    }
    if (operationId !== undefined && this.persistence !== undefined) {
      try {
        this.persistence.recordAcceptedOperation(operationId, normalizedTarget.runtimeId);
      } catch (error) {
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
      return this.unreachableFailure(
        'local IPC runtime endpoint was replaced before response hook invocation',
        normalizedTarget,
        operationId,
      );
    }
    try {
      const hook = waitForHook(
        () => {
          if (!this.registry.isCurrent(record, normalizedTarget)) {
            throw new LocalIpcDeliveryStale();
          }
          return (
            record.hooks.onResponse as unknown as (
              inbound: TransportInboundResponse<Response, LocalIpcEndpoint>,
            ) => void | PromiseLike<void>
          )(delivery);
        },
        this.deliveryTimeoutMs,
        this.setTimeout,
        this.clearTimeout,
      );
      await this.trackRecord(record, hook);
      if (!this.registry.isCurrent(record, normalizedTarget)) {
        return this.unreachableFailure(
          'local IPC runtime endpoint closed during response delivery',
          normalizedTarget,
          operationId,
        );
      }
      return delivered(operationId);
    } catch (error) {
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
    const shared = this.registry.reserveOperation(
      senderRuntimeId,
      operationId,
      recipientRuntimeId,
      expiresAt,
    );
    if (shared === null) {
      return null;
    }
    this.pruneOperationDestinations(finiteClock(this.now()));
    const key = `${senderRuntimeId}\u0000${operationId}`;
    const previous = this.operationDestinations.get(key);
    if (previous !== undefined) {
      if (previous.stale || previous.recipientRuntimeId !== recipientRuntimeId) {
        previous.stale = true;
        return null;
      }
      return { key, created: false };
    }
    const nowMs = finiteClock(this.now());
    const record: OperationDestinationRecord = {
      recipientRuntimeId,
      retainedUntil: retentionDeadline(expiresAt, nowMs, this.retentionGraceMs),
      stale: false,
    };
    this.operationDestinations.set(key, record);
    this.scheduleOperationDestination(key, record);
    return { key, created: true };
  }

  private pruneOperationDestinations(nowMs: number): number {
    let removed = 0;
    for (const [key, record] of this.operationDestinations) {
      if (record.retainedUntil <= nowMs) {
        this.removeOperationDestination(key, record);
        removed += 1;
      }
    }
    return removed;
  }

  private scheduleOperationDestination(key: string, record: OperationDestinationRecord): void {
    const delay = record.retainedUntil - finiteClock(this.now());
    if (delay <= 0) {
      this.removeOperationDestination(key, record);
      return;
    }
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

  private removeOperationDestination(key: string, record: OperationDestinationRecord): void {
    if (this.operationDestinations.get(key) !== record) {
      return;
    }
    if (record.timer !== undefined) {
      this.clearTimeout(record.timer);
      record.timer = undefined;
    }
    this.operationDestinations.delete(key);
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
    if (operationId !== undefined && this.persistence !== undefined) {
      const reportExpiry =
        typeof expiresAt === 'string' || typeof expiresAt === 'number' || expiresAt instanceof Date
          ? expiresAt
          : undefined;
      try {
        this.persistence.reportUnreachable(operationId, target?.runtimeId, message, reportExpiry);
      } catch {
        // A closed persistence boundary must not resurrect state from a late
        // transport failure; the transport result remains authoritative.
      }
    }
    return failure('unreachable', message, target, operationId, cause);
  }

  private async drainRecord(record: LocalIpcRegistryRecord): Promise<void> {
    while (record.inFlight.size > 0) {
      await Promise.allSettled([...record.inFlight]);
    }
  }

  public async closeBinding(binding: LocalIpcBinding<Envelope, Response>): Promise<void> {
    this.bindings.delete(binding);
    this.registry.deactivate(binding.registryRecord);
    await this.drainRecord(binding.registryRecord);
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
