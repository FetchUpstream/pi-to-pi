/**
 * Minimal local binding for the transport-independent adapter contract.
 *
 * The binding intentionally does not choose a socket, framing, serializer, or
 * authentication scheme.  Values are delivered directly to hooks registered in
 * one process, which gives lifecycle and integration code a deterministic
 * boundary without putting concrete framing into `transport.ts`.
 */

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

export interface LocalIpcTransportOptions {
  /** Inject a registry to connect multiple adapter instances in one process. */
  readonly registry?: LocalIpcRegistry;
  /** Bound hook wait time; a stalled hook is surfaced as `unreachable`. */
  readonly deliveryTimeoutMs?: number;
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

type StoredHooks = LocalIpcInboundHooks;

interface LocalIpcRegistryRecord {
  readonly key: string;
  readonly target: LocalIpcRuntimeTarget;
  readonly hooks: StoredHooks;
}

const MAX_ENDPOINT_LENGTH = 16_384;
const DEFAULT_DELIVERY_TIMEOUT_MS = 10_000;

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

  public get size(): number {
    return this.records.size;
  }

  public register<Envelope extends TransportEnvelope, Response extends TransportOperationResponse>(
    target: TransportRuntimeTarget<LocalIpcEndpoint>,
    hooks: LocalIpcInboundHooks<Envelope, Response>,
  ): LocalIpcRegistryRecord {
    const normalizedTarget = validateTarget(target);
    const key = targetKey(normalizedTarget);
    if (this.records.has(key) || this.runtimes.has(normalizedTarget.runtimeId)) {
      throw new LocalIpcBindingError(
        'duplicate',
        'one runtime may own only one live local IPC endpoint',
      );
    }
    const record: LocalIpcRegistryRecord = {
      key,
      target: normalizedTarget,
      hooks: hooks as unknown as StoredHooks,
    };
    this.records.set(key, record);
    this.runtimes.set(normalizedTarget.runtimeId, record);
    return record;
  }

  public resolve(
    target: TransportRuntimeTarget<LocalIpcEndpoint>,
  ): LocalIpcRegistryRecord | undefined {
    let normalizedTarget: LocalIpcRuntimeTarget;
    try {
      normalizedTarget = validateTarget(target);
    } catch {
      return undefined;
    }
    return this.records.get(targetKey(normalizedTarget));
  }

  public targetForRuntime(runtimeId: string): LocalIpcRuntimeTarget | undefined {
    return this.runtimes.get(runtimeId)?.target;
  }

  public list(): readonly LocalIpcRuntimeTarget[] {
    return Object.freeze([...this.records.values()].map((record) => record.target));
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
    this.records.delete(record.key);
    if (this.runtimes.get(record.target.runtimeId) === record) {
      this.runtimes.delete(record.target.runtimeId);
    }
    if (notice === undefined) {
      return true;
    }

    const peers = [...this.records.values()];
    await Promise.all(
      peers.map(async (peer) => {
        const onShutdown = peer.hooks.onShutdown;
        if (onShutdown === undefined) {
          return;
        }
        try {
          await waitForHook(() => onShutdown(notice), timeoutMs);
        } catch {
          // Shutdown notices are best effort; the closing runtime is already
          // detached and a peer hook cannot keep it alive indefinitely.
        }
      }),
    );
    return true;
  }

  public async closeAll(): Promise<void> {
    const records = [...this.records.values()];
    await Promise.all(records.map((record) => this.unregister(record)));
  }
}

async function waitForHook<T>(hook: () => T | PromiseLike<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new LocalIpcDeliveryTimeout()), timeoutMs);
    const unref = (timer as unknown as { unref?: () => void }).unref;
    unref?.call(timer);
  });
  try {
    return await Promise.race([Promise.resolve().then(hook), timeout]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

const DEFAULT_LOCAL_IPC_REGISTRY = new LocalIpcRegistry();

export function createLocalIpcRegistry(): LocalIpcRegistry {
  return new LocalIpcRegistry();
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

  public constructor(
    private readonly owner: LocalIpcTransport<Envelope, Response>,
    private readonly record: LocalIpcRegistryRecord,
  ) {
    this.target = record.target;
  }

  public async close(): Promise<void> {
    if (!this.open) {
      return;
    }
    this.open = false;
    await this.owner.closeBinding(this);
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

  private readonly bindings = new Set<LocalIpcBinding<Envelope, Response>>();
  private readonly operationDestinations = new Map<string, string>();
  private readonly inFlight = new Set<Promise<unknown>>();
  private closedState = false;

  public constructor(options: LocalIpcTransportOptions = {}) {
    this.registry = options.registry ?? DEFAULT_LOCAL_IPC_REGISTRY;
    this.deliveryTimeoutMs = timeoutValue(options.deliveryTimeoutMs);
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

  public async close(): Promise<void> {
    if (this.closedState) {
      return;
    }
    this.closedState = true;
    const bindings = [...this.bindings];
    await Promise.all(bindings.map((binding) => binding.close()));
    await Promise.all([...this.inFlight]);
    this.operationDestinations.clear();
  }

  public async shutdown(): Promise<void> {
    await this.close();
  }

  public async dispose(): Promise<void> {
    await this.close();
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
      return failure(
        'unreachable',
        'local IPC runtime endpoint is not currently reachable',
        normalizedTarget,
        operationId,
      );
    }

    const senderRuntimeId = senderRuntimeIdOf(envelope);
    const reservation =
      senderRuntimeId === undefined || operationId === undefined
        ? undefined
        : this.reserveOperation(senderRuntimeId, operationId, normalizedTarget.runtimeId);
    if (reservation === null) {
      return failure(
        'unreachable',
        'operationId belongs to an earlier runtime endpoint; create a new operationId',
        normalizedTarget,
        operationId,
      );
    }

    const source = sourceForRuntime(this.registry, senderRuntimeId, normalizedTarget);
    const delivery: TransportInboundEnvelope<Envelope, Response, LocalIpcEndpoint> = {
      envelope,
      source,
      reply: (response) => this.sendResponse(source, response),
    };

    try {
      await waitForHook(
        () =>
          (
            record.hooks.onEnvelope as unknown as (
              inbound: TransportInboundEnvelope<Envelope, Response, LocalIpcEndpoint>,
            ) => void | PromiseLike<void>
          )(delivery),
        this.deliveryTimeoutMs,
      );
      return delivered(operationId);
    } catch (error) {
      if (reservation?.created === true) {
        this.operationDestinations.delete(reservation.key);
      }
      return failure(
        'unreachable',
        'local IPC delivery hook could not be established',
        normalizedTarget,
        operationId,
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
      return failure(
        'unreachable',
        'local IPC runtime endpoint is not currently reachable',
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
      return failure(
        'unreachable',
        'operationId belongs to an earlier runtime endpoint; create a new operationId',
        normalizedTarget,
        operationId,
      );
    }

    const delivery: TransportInboundResponse<Response, LocalIpcEndpoint> = {
      response,
      source: localSource,
    };
    try {
      await waitForHook(
        () =>
          (
            record.hooks.onResponse as unknown as (
              inbound: TransportInboundResponse<Response, LocalIpcEndpoint>,
            ) => void | PromiseLike<void>
          )(delivery),
        this.deliveryTimeoutMs,
      );
      return delivered(operationId);
    } catch (error) {
      if (reservation?.created === true) {
        this.operationDestinations.delete(reservation.key);
      }
      return failure(
        'unreachable',
        'local IPC response hook could not be established',
        normalizedTarget,
        operationId,
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
  ): RouteReservation | null {
    const key = `${senderRuntimeId}\u0000${operationId}`;
    const previous = this.operationDestinations.get(key);
    if (previous !== undefined && previous !== recipientRuntimeId) {
      return null;
    }
    if (previous === undefined) {
      this.operationDestinations.set(key, recipientRuntimeId);
      return { key, created: true };
    }
    return { key, created: false };
  }

  private track<T>(promise: Promise<T>): Promise<T> {
    const tracked = promise.finally(() => this.inFlight.delete(tracked));
    this.inFlight.add(tracked);
    return tracked;
  }

  public async closeBinding(binding: LocalIpcBinding<Envelope, Response>): Promise<void> {
    this.bindings.delete(binding);
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
