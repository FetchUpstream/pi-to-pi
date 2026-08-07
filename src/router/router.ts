import { randomBytes, randomUUID } from 'node:crypto';

import { DEFAULT_PROTOCOL_LIMITS } from '../config.js';
import {
  type BindingAuthenticationContext,
  type BindingAuthenticator,
  type RuntimeAdvertisement,
} from '../discovery/registry.js';
import type { SessionRuntimeIdentity } from '../identity.js';
import { RuntimePersistence, type RuntimePersistenceOptions } from '../pi/persistence.js';
import type {
  AgentCard,
  AgentCapabilities,
  ContentCapability,
  OperationCapability,
  ProtocolLimits,
} from '../protocol/agent-card.js';
import { createProtocolError, type ProtocolError } from '../protocol/errors.js';
import {
  asRoomId,
  asRuntimeId,
  asSessionId,
  asTraceId,
  asUtcTimestamp,
  asUuidV4,
  OPERATION_NAMES,
  PROTOCOL_VERSION,
  type Content,
  type ExpectedResponse,
  type JsonObject,
  type MessageReplyPayload,
  type MessageRequestEnvelope,
  type OperationId,
  type OperationName,
  type OperationResponse,
  type ProtocolEnvelope,
  type ProtocolVersion,
  type RequestId,
  type RoomId,
  type RuntimeId,
  type SenderIdentity,
  type TaskCancelEnvelope,
  type TaskStatusEnvelope,
  type UtcTimestamp,
} from '../protocol/messages.js';
import {
  validateEnvelope,
  validateOperationResponse,
  validateReplyContent,
  type ValidationResult,
} from '../protocol/validation.js';
import { isTerminalTaskState, type TaskSnapshot } from '../protocol/task-state.js';
import { RuntimeScopedDedupeStore, type DedupeDecision } from './dedupe.js';
import {
  RoutingPolicy,
  type QueueAdmissionDecision,
  type QueueLease,
  type RoutingQueueEntry,
} from './policy.js';
import {
  TaskStore,
  type CancellationRequestOptions,
  type TaskTransitionUpdate,
} from './task-store.js';
import type {
  TransportAdapter,
  TransportDeliveryFailure,
  TransportDeliveryResult,
  TransportEndpoint,
  TransportInboundEnvelope,
  TransportInboundResponse,
  TransportRuntimeTarget,
} from '../transport/transport.js';

/** Transport type used by the default router implementation. */
export type RouterTransport<Endpoint = TransportEndpoint> = TransportAdapter<
  ProtocolEnvelope,
  OperationResponse,
  Endpoint
>;

export type RouterTarget<Endpoint = TransportEndpoint> = TransportRuntimeTarget<Endpoint>;

export interface RuntimeDiscovery<Endpoint = TransportEndpoint> {
  readonly roomId?: RoomId;
  get?(
    runtimeId: RuntimeId,
  ): (Omit<RuntimeAdvertisement, 'endpoint'> & { readonly endpoint: Endpoint }) | undefined;
  currentEndpoint?(runtimeId?: RuntimeId): unknown;
  endpointFor?(runtimeId: RuntimeId): unknown;
}

export interface RouterRequestExecutorContext {
  readonly request: MessageRequestEnvelope;
  readonly requestId: RequestId;
  readonly snapshot: TaskSnapshot;
  readonly signal: AbortSignal;
  /** Complete this task with an explicit typed response. */
  readonly complete: (content: Content) => TaskSnapshot | undefined;
  /** Fail this task with a structured protocol error. */
  readonly fail: (error: ProtocolError) => TaskSnapshot | undefined;
  /** Reject this task before model execution completes. */
  readonly reject: (error: ProtocolError) => TaskSnapshot | undefined;
}

export type RouterRequestExecutorResult =
  | void
  | Content
  | {
      readonly content?: Content;
      readonly error?: ProtocolError;
      readonly outcome?: Exclude<MessageReplyPayload['outcome'], 'cancelled' | 'expired'>;
    };

export type RouterRequestExecutor = (
  context: RouterRequestExecutorContext,
) => RouterRequestExecutorResult | PromiseLike<RouterRequestExecutorResult>;

export interface RouterNotificationContext {
  readonly envelope: Extract<ProtocolEnvelope, { operation: 'message.notify' }>;
  readonly sender: SessionRuntimeIdentity;
}

export type RouterNotificationHandler = (
  context: RouterNotificationContext,
) => void | PromiseLike<void>;

export interface RouterOptions<Endpoint = TransportEndpoint> {
  readonly identity?: SessionRuntimeIdentity;
  readonly roomId?: RoomId;
  readonly transport: RouterTransport<Endpoint>;
  readonly endpoint?: Endpoint;
  readonly registry?: RuntimeDiscovery<Endpoint>;
  readonly targetResolver?: (
    runtimeId: RuntimeId,
  ) => RouterTarget<Endpoint> | undefined | PromiseLike<RouterTarget<Endpoint> | undefined>;
  readonly bindingAuthenticator?: BindingAuthenticator;
  readonly persistence?: RuntimePersistence;
  readonly taskStore?: TaskStore;
  readonly dedupeStore?: RuntimeScopedDedupeStore<OperationResponse, RequestId>;
  readonly routingPolicy?: RoutingPolicy<ProtocolEnvelope>;
  readonly limits?: Partial<ProtocolLimits>;
  readonly agentCard?: AgentCard;
  readonly name?: string;
  readonly description?: string;
  readonly supportsCancellation?: boolean;
  readonly supportsNotifications?: boolean;
  readonly requestExecutor?: RouterRequestExecutor;
  readonly onNotification?: RouterNotificationHandler;
  readonly onTaskStateChange?: (requestId: RequestId, snapshot: TaskSnapshot) => void;
  readonly onUnreachable?: (operationId: OperationId, error: ProtocolError) => void;
  readonly now?: () => number;
}

export interface RouterStartOptions<Endpoint = TransportEndpoint> {
  readonly target?: RouterTarget<Endpoint>;
}

export interface RouterRequestInput {
  readonly recipientRuntimeId: RuntimeId;
  readonly content: Content;
  readonly expectedResponse?: ExpectedResponse;
  readonly metadata?: JsonObject;
  readonly expiresAt?: UtcTimestamp | string | number | Date;
  readonly parentOperationId?: OperationId;
  readonly traceId?: string;
}

export interface RouterNotificationInput {
  readonly recipientRuntimeId: RuntimeId;
  readonly content: Content;
  readonly metadata?: JsonObject;
  readonly expiresAt?: UtcTimestamp | string | number | Date;
  readonly traceId?: string;
}

export interface RouterOperationInput {
  readonly recipientRuntimeId: RuntimeId;
  readonly requestId: RequestId;
  readonly expiresAt?: UtcTimestamp | string | number | Date;
  readonly traceId?: string;
  readonly parentOperationId?: OperationId;
}

export interface RouterRequestHandle<Endpoint = TransportEndpoint> {
  readonly requestId: RequestId;
  readonly operationId: OperationId;
  readonly envelope: MessageRequestEnvelope;
  readonly target: RouterTarget<Endpoint>;
  readonly admission: Promise<OperationResponse>;
  readonly completion: Promise<TaskSnapshot>;
}

export interface RouterTaskResult {
  readonly snapshot: TaskSnapshot;
  readonly reply?: ProtocolEnvelope;
}

export class RouterError extends Error {
  public readonly code: ProtocolError['code'];
  public readonly protocolError: ProtocolError;

  public constructor(error: ProtocolError) {
    super(error.message);
    this.name = 'RouterError';
    this.code = error.code;
    this.protocolError = error;
  }
}

interface PendingOperation {
  readonly operation: OperationName;
  readonly requestId?: RequestId;
  readonly resolve: (response: OperationResponse) => void;
  readonly reject: (error: unknown) => void;
}

interface OutboundRequestRecord<Endpoint> {
  readonly envelope: MessageRequestEnvelope;
  readonly target: RouterTarget<Endpoint>;
  readonly expectedResponse?: ExpectedResponse;
  readonly completion: Promise<TaskSnapshot>;
  readonly resolveCompletion: (snapshot: TaskSnapshot) => void;
  readonly rejectCompletion: (error: unknown) => void;
  admissionResolved: boolean;
  terminalSnapshot?: TaskSnapshot;
}

interface InboundRequestRecord<Endpoint> {
  readonly envelope: MessageRequestEnvelope;
  readonly target: RouterTarget<Endpoint>;
  readonly taskRequestTarget: RouterTarget<Endpoint>;
  readonly expectedResponse?: ExpectedResponse;
  readonly lease?: QueueLease<ProtocolEnvelope>;
  expiryTimer?: unknown;
  terminalSent: boolean;
}

interface RawEnvelopeFields {
  readonly operation?: unknown;
  readonly operationId?: unknown;
  readonly requestId?: unknown;
  readonly sender?: unknown;
  readonly recipientRuntimeId?: unknown;
  readonly roomId?: unknown;
  readonly traceId?: unknown;
}

const ZERO_TRACE_ID = '0'.repeat(32);
const MAX_PENDING_OPERATIONS = 4096;
const MAX_TRACKED_TASKS = 4096;
const MAX_TIMER_DELAY_MS = 2_147_483_647;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isProtocolOperation(value: unknown): value is OperationName {
  return typeof value === 'string' && (OPERATION_NAMES as readonly string[]).includes(value);
}

function isUuid(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)
  );
}

function protocolTimestamp(value: Date | number | string | undefined): UtcTimestamp {
  const date = value === undefined ? new Date() : value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new RangeError('protocol timestamp must be a finite date');
  }
  return asUtcTimestamp(date.toISOString());
}

function nowMs(clock: () => number): number {
  const value = clock();
  if (!Number.isFinite(value)) {
    throw new RangeError('router clock must return a finite epoch');
  }
  return value;
}

function deadlineValue(
  value: UtcTimestamp | string | number | Date | undefined,
  now: number,
  maximumMs: number,
): UtcTimestamp {
  const deadline =
    value === undefined
      ? now + maximumMs
      : value instanceof Date
        ? value.getTime()
        : typeof value === 'number'
          ? value
          : Date.parse(value);
  if (!Number.isFinite(deadline) || !Number.isSafeInteger(deadline)) {
    throw new RangeError('operation expiry must be a finite safe timestamp');
  }
  if (deadline <= now) {
    throw new RangeError('operation expiry must be in the future');
  }
  if (deadline - now > maximumMs) {
    throw new RangeError('operation expiry exceeds the v1 operation limit');
  }
  return protocolTimestamp(deadline);
}

function traceValue(value: string | undefined): ReturnType<typeof asTraceId> {
  if (value !== undefined && /^[0-9a-f]{32}$/u.test(value)) {
    return asTraceId(value);
  }
  return asTraceId(randomBytes(16).toString('hex'));
}

function cloneProtocolError(error: ProtocolError): ProtocolError {
  return {
    ...error,
    ...(error.details === undefined ? {} : { details: { ...error.details } }),
  };
}

function responseFor(
  envelope: RawEnvelopeFields,
  resultOrError: { readonly result: unknown } | { readonly error: ProtocolError },
): OperationResponse {
  const operation = isProtocolOperation(envelope.operation) ? envelope.operation : 'peer.describe';
  const operationId = isUuid(envelope.operationId)
    ? asUuidV4(envelope.operationId)
    : asUuidV4(randomUUID());
  const traceId =
    typeof envelope.traceId === 'string' && /^[0-9a-f]{32}$/u.test(envelope.traceId)
      ? asTraceId(envelope.traceId)
      : asTraceId(ZERO_TRACE_ID);
  return {
    protocolVersion: PROTOCOL_VERSION,
    operation,
    operationId,
    traceId,
    ...(resultOrError as object),
  } as OperationResponse;
}

function errorResponse(envelope: RawEnvelopeFields, error: ProtocolError): OperationResponse {
  return responseFor(envelope, { error: cloneProtocolError(error) });
}

function successResponse(envelope: ProtocolEnvelope, result: unknown): OperationResponse {
  return responseFor(envelope, { result });
}

function transportFailureError<Endpoint>(
  failure: TransportDeliveryFailure<Endpoint>,
): ProtocolError {
  const code = failure.error.code === 'ambiguous' ? 'ambiguous' : 'unreachable';
  return createProtocolError(code, failure.error.message, {
    ...(failure.error.retryAfterMs === undefined
      ? {}
      : { retryAfterMs: failure.error.retryAfterMs }),
  });
}

function identitySender(identity: SessionRuntimeIdentity): SenderIdentity {
  return {
    sessionId: identity.sessionId,
    runtimeId: identity.runtimeId,
  };
}

function isTerminalSnapshot(snapshot: TaskSnapshot | undefined): snapshot is TaskSnapshot {
  return snapshot !== undefined && isTerminalTaskState(snapshot.state);
}

function taskUpdateForExecutorResult(result: RouterRequestExecutorResult): TaskTransitionUpdate {
  if (result === undefined) {
    return {};
  }
  if (typeof result === 'object' && result !== null && 'outcome' in result) {
    if (result.outcome === 'failed') {
      return { error: result.error ?? createProtocolError('internal', 'request executor failed') };
    }
    if (result.outcome === 'rejected') {
      return { error: result.error ?? createProtocolError('malformed', 'request was rejected') };
    }
    return result.content === undefined ? {} : { content: result.content };
  }
  if (typeof result === 'object' && result !== null && ('content' in result || 'error' in result)) {
    return {
      ...(result.content === undefined ? {} : { content: result.content }),
      ...(result.error === undefined ? {} : { error: result.error }),
    };
  }
  return { content: result as Content };
}

/**
 * The v1 operation router.  It is deliberately independent from a Pi agent
 * lifecycle: model execution is an injected per-request callback and replies
 * always carry the logical request ID they complete.
 */
export class MessageRouter<Endpoint = TransportEndpoint> {
  public readonly identity: SessionRuntimeIdentity;
  public readonly sessionId: SessionRuntimeIdentity['sessionId'];
  public readonly runtimeId: RuntimeId;
  public readonly roomId: RoomId;
  public readonly limits: ProtocolLimits;
  public readonly transport: RouterTransport<Endpoint>;
  public readonly taskStore: TaskStore;
  public readonly tasks: TaskStore;
  public readonly dedupeStore: RuntimeScopedDedupeStore<OperationResponse, RequestId>;
  public readonly dedupe: RuntimeScopedDedupeStore<OperationResponse, RequestId>;
  public readonly policy: RoutingPolicy<ProtocolEnvelope>;

  private readonly endpoint: Endpoint | undefined;
  private readonly registry: RuntimeDiscovery<Endpoint> | undefined;
  private readonly targetResolver:
    | ((
        runtimeId: RuntimeId,
      ) => RouterTarget<Endpoint> | undefined | PromiseLike<RouterTarget<Endpoint> | undefined>)
    | undefined;
  private readonly bindingAuthenticator: BindingAuthenticator | undefined;
  private readonly persistence: RuntimePersistence | undefined;
  private readonly requestExecutor: RouterRequestExecutor | undefined;
  private readonly onNotification: RouterNotificationHandler | undefined;
  private readonly onTaskStateChange:
    ((requestId: RequestId, snapshot: TaskSnapshot) => void) | undefined;
  private readonly onUnreachable:
    ((operationId: OperationId, error: ProtocolError) => void) | undefined;
  private readonly now: () => number;
  private readonly agentCard: AgentCard;
  private readonly pending = new Map<string, PendingOperation>();
  private readonly outboundRequests = new Map<string, OutboundRequestRecord<Endpoint>>();
  private readonly inboundRequests = new Map<string, InboundRequestRecord<Endpoint>>();
  private readonly leases = new Map<string, QueueLease<ProtocolEnvelope>>();
  private binding: { close(): Promise<void> } | undefined;
  private started = false;
  private closed = false;

  public constructor(options: RouterOptions<Endpoint>) {
    const persistence = options.persistence;
    const identity = options.identity ?? persistence?.identity;
    const roomId = options.roomId ?? options.registry?.roomId;
    if (identity === undefined) {
      throw new TypeError('router identity is required');
    }
    if (roomId === undefined) {
      throw new TypeError('router roomId is required');
    }
    if (!options.transport) {
      throw new TypeError('router transport is required');
    }
    if (persistence !== undefined && persistence.runtimeId !== identity.runtimeId) {
      throw new TypeError('router identity must match runtime persistence');
    }
    this.identity = Object.freeze({
      sessionId: asSessionId(identity.sessionId),
      runtimeId: asRuntimeId(identity.runtimeId),
    });
    this.sessionId = this.identity.sessionId;
    this.runtimeId = this.identity.runtimeId;
    this.roomId = asRoomId(roomId);
    this.transport = options.transport;
    this.endpoint = options.endpoint;
    this.registry = options.registry;
    this.targetResolver = options.targetResolver;
    this.bindingAuthenticator = options.bindingAuthenticator;
    this.persistence = persistence;
    this.requestExecutor = options.requestExecutor;
    this.onNotification = options.onNotification;
    this.onTaskStateChange = options.onTaskStateChange;
    this.onUnreachable = options.onUnreachable;
    this.now = options.now ?? persistence?.clock ?? (() => Date.now());
    this.limits = Object.freeze({
      ...DEFAULT_PROTOCOL_LIMITS,
      ...(options.limits ?? {}),
    });

    if (
      options.taskStore !== undefined &&
      persistence !== undefined &&
      options.taskStore !== persistence.taskStore
    ) {
      throw new TypeError('router taskStore must match persistence.taskStore');
    }
    if (
      options.dedupeStore !== undefined &&
      persistence !== undefined &&
      options.dedupeStore !== persistence.dedupeStore
    ) {
      throw new TypeError('router dedupeStore must match persistence.dedupeStore');
    }
    if (options.routingPolicy !== undefined) {
      this.policy = options.routingPolicy;
    } else {
      this.policy = new RoutingPolicy<ProtocolEnvelope>({
        maxQueueEntries: this.limits.maxQueueEntries,
      });
    }
    this.taskStore =
      options.taskStore ??
      persistence?.taskStore ??
      new TaskStore({
        localOwnerRuntimeId: this.runtimeId,
      });
    this.tasks = this.taskStore;
    this.dedupeStore =
      options.dedupeStore ??
      (persistence?.dedupeStore as
        RuntimeScopedDedupeStore<OperationResponse, RequestId> | undefined) ??
      new RuntimeScopedDedupeStore<OperationResponse, RequestId>({
        runtimeId: this.runtimeId,
      });
    this.dedupe = this.dedupeStore;
    this.agentCard = options.agentCard ?? this.createAgentCard(options);
  }

  public get isStarted(): boolean {
    return this.started && !this.closed;
  }

  public get isClosed(): boolean {
    return this.closed;
  }

  public get card(): AgentCard {
    return this.agentCard;
  }

  public get agent(): AgentCard {
    return this.agentCard;
  }

  /** Bind inbound envelope and response hooks to the selected transport. */
  public async start(options: RouterStartOptions<Endpoint> = {}): Promise<void> {
    this.ensureOpen();
    if (this.binding !== undefined) {
      this.started = true;
      return;
    }
    const target =
      options.target ??
      (this.endpoint === undefined
        ? undefined
        : {
            runtimeId: this.runtimeId,
            endpoint: this.endpoint,
          });
    if (target === undefined) {
      throw new TypeError('router endpoint/target is required to start the transport binding');
    }
    if (target.runtimeId !== this.runtimeId) {
      throw new TypeError('router binding target must use the local runtime ID');
    }
    this.binding = await this.transport.bind(target, {
      onEnvelope: (delivery) => this.handleInbound(delivery),
      onResponse: (delivery) => this.handleInboundResponse(delivery),
    });
    this.started = true;
  }

  public async bind(options: RouterStartOptions<Endpoint> = {}): Promise<void> {
    return this.start(options);
  }

  public async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.started = false;
    const binding = this.binding;
    this.binding = undefined;
    if (binding !== undefined) {
      await binding.close();
    }
    for (const pending of this.pending.values()) {
      pending.reject(new RouterError(createProtocolError('unreachable', 'router is closed')));
    }
    this.pending.clear();
    this.policy.expire();
  }

  public async shutdown(): Promise<void> {
    return this.close();
  }

  public async dispose(): Promise<void> {
    return this.close();
  }

  /** Public inbound hook for fake transports and conformance tests. */
  public async handleInbound(
    delivery: TransportInboundEnvelope<ProtocolEnvelope, OperationResponse, Endpoint>,
  ): Promise<void> {
    const response = await this.processInbound(delivery.envelope, delivery.source);
    try {
      await delivery.reply(response);
    } catch (error) {
      this.reportUnreachable(delivery.envelope.operationId, error);
    }
  }

  public async handleEnvelope(
    delivery: TransportInboundEnvelope<ProtocolEnvelope, OperationResponse, Endpoint>,
  ): Promise<OperationResponse> {
    return this.processInbound(delivery.envelope, delivery.source);
  }

  /** Public response hook for fake transports and conformance tests. */
  public async handleInboundResponse(
    delivery: TransportInboundResponse<OperationResponse, Endpoint>,
  ): Promise<void> {
    const responseResult = validateOperationResponse(delivery.response);
    if (!responseResult.ok) {
      const pending = this.pending.get(String(delivery.response.operationId));
      pending?.reject(new RouterError(responseResult.error));
      if (pending !== undefined) {
        this.pending.delete(String(delivery.response.operationId));
      }
      return;
    }
    this.applyResponse(responseResult.value);
  }

  public async processResponse(response: OperationResponse): Promise<void> {
    await this.handleInboundResponse({
      response,
      source: { runtimeId: this.runtimeId, endpoint: undefined as Endpoint },
    });
  }

  /** Send an already constructed protocol envelope to an exact target. */
  public async sendEnvelope(
    envelope: ProtocolEnvelope,
    target?: RouterTarget<Endpoint>,
  ): Promise<TransportDeliveryResult<Endpoint>> {
    this.ensureOpen();
    const validation = this.validateOutbound(envelope);
    if (!validation.ok) {
      return {
        status: 'failed',
        operationId: String((envelope as RawEnvelopeFields).operationId ?? ''),
        error: {
          code: validation.error.code === 'expired' ? 'timeout' : 'invalid_target',
          message: validation.error.message,
          retryable: validation.error.retryable,
          cause: validation.error,
        },
      } as TransportDeliveryFailure<Endpoint>;
    }
    const resolvedTarget = target ?? (await this.resolveTarget(envelope.recipientRuntimeId));
    if (resolvedTarget === undefined || resolvedTarget.runtimeId !== envelope.recipientRuntimeId) {
      const failure: TransportDeliveryFailure<Endpoint> = {
        status: 'failed',
        operationId: envelope.operationId,
        error: {
          code: 'unreachable',
          message: 'no current routing endpoint is known for the recipient runtime',
          retryable: true,
          target: resolvedTarget,
        },
      };
      this.reportUnreachable(envelope.operationId, failure.error);
      return failure;
    }
    const result = await this.transport.sendEnvelope(resolvedTarget, validation.value);
    if (result.status === 'failed') {
      this.reportUnreachable(envelope.operationId, result.error);
    } else if (this.persistence !== undefined) {
      try {
        this.persistence.recordAcceptedOperation(
          envelope.operationId,
          envelope.recipientRuntimeId,
          envelope.expiresAt,
          envelope.sender.runtimeId,
        );
      } catch (error) {
        const protocolError =
          error instanceof RouterError
            ? error.protocolError
            : createProtocolError(
                'unreachable',
                error instanceof Error ? error.message : 'operation delivery was fenced',
              );
        this.reportUnreachable(envelope.operationId, protocolError);
        return {
          status: 'failed',
          operationId: envelope.operationId,
          error: {
            code: 'unreachable',
            message: protocolError.message,
            retryable: true,
            cause: error,
          },
        } as TransportDeliveryFailure<Endpoint>;
      }
    }
    return result;
  }

  public async send(
    envelope: ProtocolEnvelope,
    target?: RouterTarget<Endpoint>,
  ): Promise<TransportDeliveryResult<Endpoint>> {
    return this.sendEnvelope(envelope, target);
  }

  /** Create a request envelope and a per-request completion handle. */
  public async createRequest(
    input: RouterRequestInput,
    target?: RouterTarget<Endpoint>,
  ): Promise<RouterRequestHandle<Endpoint>> {
    this.ensureOpen();
    const envelope = this.buildRequestEnvelope(input);
    const resolvedTarget = target ?? (await this.resolveTarget(envelope.recipientRuntimeId));
    if (resolvedTarget === undefined) {
      throw new RouterError(
        createProtocolError(
          'unreachable',
          'no current routing endpoint is known for the recipient runtime',
        ),
      );
    }
    const requestId = envelope.requestId;
    if (this.outboundRequests.size >= MAX_TRACKED_TASKS) {
      throw new RouterError(
        createProtocolError('busy', 'router request capacity is temporarily exhausted'),
      );
    }
    this.taskStore.createTask({
      requestId,
      operationId: envelope.operationId,
      owner: identitySender(this.identity),
      createdAt: envelope.createdAt,
      expiresAt: envelope.expiresAt,
      initialState: 'created',
    });
    let resolveCompletion!: (snapshot: TaskSnapshot) => void;
    let rejectCompletion!: (error: unknown) => void;
    const completion = new Promise<TaskSnapshot>((resolve, reject) => {
      resolveCompletion = resolve;
      rejectCompletion = reject;
    });
    const record: OutboundRequestRecord<Endpoint> = {
      envelope,
      target: resolvedTarget,
      ...(input.expectedResponse === undefined ? {} : { expectedResponse: input.expectedResponse }),
      completion,
      resolveCompletion,
      rejectCompletion,
      admissionResolved: false,
    };
    this.outboundRequests.set(requestId, record);
    const admission = this.sendAndWait(envelope, resolvedTarget, requestId);
    return Object.freeze({
      requestId,
      operationId: envelope.operationId,
      envelope,
      target: resolvedTarget,
      admission,
      completion,
    });
  }

  /** Build, send, and await the admission response for a request. */
  public async sendRequest(
    input: RouterRequestInput | MessageRequestEnvelope,
    target?: RouterTarget<Endpoint>,
  ): Promise<OperationResponse> {
    if (this.isMessageRequestEnvelope(input)) {
      const resolvedTarget = target ?? (await this.resolveTarget(input.recipientRuntimeId));
      if (resolvedTarget === undefined) {
        throw new RouterError(
          createProtocolError(
            'unreachable',
            'no current routing endpoint is known for the recipient runtime',
          ),
        );
      }
      if (!this.outboundRequests.has(input.requestId)) {
        this.taskStore.createTask({
          requestId: input.requestId,
          operationId: input.operationId,
          owner: identitySender(this.identity),
          createdAt: input.createdAt,
          expiresAt: input.expiresAt,
          initialState: 'created',
        });
        let resolveCompletion!: (snapshot: TaskSnapshot) => void;
        let rejectCompletion!: (error: unknown) => void;
        const completion = new Promise<TaskSnapshot>((resolve, reject) => {
          resolveCompletion = resolve;
          rejectCompletion = reject;
        });
        this.outboundRequests.set(input.requestId, {
          envelope: input,
          target: resolvedTarget,
          ...(input.payload.expectedResponse === undefined
            ? {}
            : { expectedResponse: input.payload.expectedResponse }),
          completion,
          resolveCompletion,
          rejectCompletion,
          admissionResolved: false,
        });
      }
      return this.sendAndWait(input, resolvedTarget, input.requestId);
    }
    const handle = await this.createRequest(input, target);
    return handle.admission;
  }

  public async request(
    input: RouterRequestInput | MessageRequestEnvelope,
    target?: RouterTarget<Endpoint>,
  ): Promise<OperationResponse> {
    return this.sendRequest(input, target);
  }

  public async describe(
    recipientRuntimeId: RuntimeId,
    target?: RouterTarget<Endpoint>,
  ): Promise<OperationResponse> {
    const envelope = this.buildDescribeEnvelope(recipientRuntimeId);
    const resolvedTarget = target ?? (await this.resolveTarget(envelope.recipientRuntimeId));
    if (resolvedTarget === undefined) {
      throw new RouterError(
        createProtocolError(
          'unreachable',
          'no current routing endpoint is known for the recipient runtime',
        ),
      );
    }
    return this.sendAndWait(envelope, resolvedTarget, undefined);
  }

  public async peerDescribe(
    recipientRuntimeId: RuntimeId,
    target?: RouterTarget<Endpoint>,
  ): Promise<OperationResponse> {
    return this.describe(recipientRuntimeId, target);
  }

  public async notify(
    input: RouterNotificationInput | Extract<ProtocolEnvelope, { operation: 'message.notify' }>,
    target?: RouterTarget<Endpoint>,
  ): Promise<OperationResponse> {
    const envelope = this.isMessageNotifyEnvelope(input) ? input : this.buildNotifyEnvelope(input);
    const resolvedTarget = target ?? (await this.resolveTarget(envelope.recipientRuntimeId));
    if (resolvedTarget === undefined) {
      throw new RouterError(
        createProtocolError(
          'unreachable',
          'no current routing endpoint is known for the recipient runtime',
        ),
      );
    }
    return this.sendAndWait(envelope, resolvedTarget, undefined);
  }

  public async sendNotification(
    input: RouterNotificationInput | Extract<ProtocolEnvelope, { operation: 'message.notify' }>,
    target?: RouterTarget<Endpoint>,
  ): Promise<OperationResponse> {
    return this.notify(input, target);
  }

  public async status(
    input: RouterOperationInput | TaskStatusEnvelope,
    target?: RouterTarget<Endpoint>,
  ): Promise<OperationResponse> {
    const envelope = this.isTaskStatusEnvelope(input) ? input : this.buildStatusEnvelope(input);
    const resolvedTarget = target ?? (await this.resolveTarget(envelope.recipientRuntimeId));
    if (resolvedTarget === undefined) {
      throw new RouterError(
        createProtocolError(
          'unreachable',
          'no current routing endpoint is known for the recipient runtime',
        ),
      );
    }
    return this.sendAndWait(envelope, resolvedTarget, envelope.requestId);
  }

  public async cancel(
    input: (RouterOperationInput & { readonly reason?: string }) | TaskCancelEnvelope,
    target?: RouterTarget<Endpoint>,
  ): Promise<OperationResponse> {
    const envelope = this.isTaskCancelEnvelope(input) ? input : this.buildCancelEnvelope(input);
    const resolvedTarget = target ?? (await this.resolveTarget(envelope.recipientRuntimeId));
    if (resolvedTarget === undefined) {
      throw new RouterError(
        createProtocolError(
          'unreachable',
          'no current routing endpoint is known for the recipient runtime',
        ),
      );
    }
    return this.sendAndWait(envelope, resolvedTarget, envelope.requestId);
  }

  public async sendStatus(
    input: RouterOperationInput | TaskStatusEnvelope,
    target?: RouterTarget<Endpoint>,
  ): Promise<OperationResponse> {
    return this.status(input, target);
  }

  public async sendCancel(
    input: (RouterOperationInput & { readonly reason?: string }) | TaskCancelEnvelope,
    target?: RouterTarget<Endpoint>,
  ): Promise<OperationResponse> {
    return this.cancel(input, target);
  }

  /** Complete a task admitted from a peer; no lifecycle event is inferred. */
  public completeTask(requestId: RequestId, content: Content): RouterTaskResult | undefined {
    return this.finishTask(requestId, this.taskStore.completeTask(requestId, content));
  }

  public failTask(requestId: RequestId, error: ProtocolError): RouterTaskResult | undefined {
    return this.finishTask(requestId, this.taskStore.failTask(requestId, error));
  }

  public rejectTask(requestId: RequestId, error: ProtocolError): RouterTaskResult | undefined {
    return this.finishTask(requestId, this.taskStore.rejectTask(requestId, error));
  }

  public cancelTask(
    requestId: RequestId,
    options?: CancellationRequestOptions,
  ): RouterTaskResult | undefined {
    const result = this.taskStore.cancelTask(requestId, options);
    return this.finishTask(requestId, result.ok ? result.snapshot : result.snapshot);
  }

  public taskSnapshot(requestId: RequestId): TaskSnapshot | undefined {
    return this.taskStore.getTask(requestId, { includeTerminalResponse: true });
  }

  private async processInbound(
    rawEnvelope: ProtocolEnvelope,
    source: RouterTarget<Endpoint>,
  ): Promise<OperationResponse> {
    this.ensureOpen();
    const raw = rawEnvelope as unknown as RawEnvelopeFields;
    const authError = await this.authorizeInbound(raw, source);
    if (authError !== undefined) {
      return errorResponse(raw, authError);
    }

    let expectedRequestExpiresAt: UtcTimestamp | undefined;
    if (raw.operation === 'message.reply' && typeof raw.requestId === 'string') {
      const task = this.outboundRequests.get(raw.requestId);
      expectedRequestExpiresAt = task?.envelope.expiresAt;
    }
    const validation = validateEnvelope(rawEnvelope, {
      now: this.now(),
      ...(expectedRequestExpiresAt === undefined ? {} : { expectedRequestExpiresAt }),
      limits: this.limits,
    });
    if (!validation.ok) {
      return errorResponse(raw, validation.error);
    }
    const envelope = validation.value;
    switch (envelope.operation) {
      case 'peer.describe':
        return this.processDescribe(envelope);
      case 'message.request':
        return this.processMessageRequest(envelope, source);
      case 'message.reply':
        return this.processMessageReply(envelope, source);
      case 'message.notify':
        return this.processMessageNotify(envelope);
      case 'task.status':
        return this.processTaskStatus(envelope);
      case 'task.cancel':
        return this.processTaskCancel(envelope);
      default:
        return errorResponse(
          envelope,
          createProtocolError('incompatible', 'operation is unsupported'),
        );
    }
  }

  private async authorizeInbound(
    envelope: RawEnvelopeFields,
    source: RouterTarget<Endpoint>,
  ): Promise<ProtocolError | undefined> {
    const sender = isRecord(envelope.sender) ? envelope.sender : undefined;
    const senderRuntimeId = typeof sender?.runtimeId === 'string' ? sender.runtimeId : undefined;
    const claimedSessionId = typeof sender?.sessionId === 'string' ? sender.sessionId : undefined;
    const roomId = typeof envelope.roomId === 'string' ? envelope.roomId : undefined;
    if (source.runtimeId !== senderRuntimeId) {
      return createProtocolError(
        'unauthorized',
        'binding credentials do not match the claimed sender',
      );
    }
    if (this.bindingAuthenticator !== undefined) {
      if (senderRuntimeId === undefined || claimedSessionId === undefined || roomId === undefined) {
        return createProtocolError('unauthorized', 'binding credentials do not identify a sender');
      }
      const context: BindingAuthenticationContext = {
        claimedSender: {
          sessionId: asSessionId(claimedSessionId),
          runtimeId: asRuntimeId(senderRuntimeId),
        },
        recipientRuntimeId: asRuntimeId(
          typeof envelope.recipientRuntimeId === 'string'
            ? envelope.recipientRuntimeId
            : this.runtimeId,
        ),
        roomId: asRoomId(roomId),
        localRuntimeId: this.runtimeId,
        localRoomId: this.roomId,
      };
      try {
        const authenticator =
          this.bindingAuthenticator.authenticate ?? this.bindingAuthenticator.verify;
        if (authenticator === undefined) {
          return createProtocolError('unauthorized', 'binding authenticator is not configured');
        }
        const result = await authenticator(
          source as unknown as Readonly<Record<string, unknown>>,
          context,
        );
        if (
          !result.authenticated ||
          result.identity.runtimeId !== senderRuntimeId ||
          result.identity.sessionId !== claimedSessionId
        ) {
          return createProtocolError(
            'unauthorized',
            'binding credentials do not match the claimed sender',
          );
        }
      } catch {
        return createProtocolError('unauthorized', 'binding authentication failed');
      }
    }
    if (roomId !== undefined && roomId !== this.roomId) {
      return createProtocolError('cross_room', 'operation belongs to a different room');
    }
    if (
      envelope.recipientRuntimeId !== undefined &&
      envelope.recipientRuntimeId !== this.runtimeId
    ) {
      return createProtocolError('unauthorized', 'operation is addressed to another runtime');
    }
    if (this.registry?.get !== undefined && senderRuntimeId !== undefined) {
      try {
        const advertisement = this.registry.get(asRuntimeId(senderRuntimeId));
        if (advertisement !== undefined && claimedSessionId !== advertisement.sessionId) {
          return createProtocolError('unauthorized', 'sender runtime identity is stale');
        }
      } catch {
        return createProtocolError('unauthorized', 'sender runtime identity could not be verified');
      }
    }
    return undefined;
  }

  private processDescribe(
    envelope: Extract<ProtocolEnvelope, { operation: 'peer.describe' }>,
  ): OperationResponse {
    return successResponse(envelope, { agentCard: this.agentCard });
  }

  private processMessageRequest(
    envelope: MessageRequestEnvelope,
    source: RouterTarget<Endpoint>,
  ): OperationResponse {
    const existing = this.dedupeStore.inspect(envelope);
    const existingResponse = this.dedupeResponse(existing);
    if (existingResponse !== undefined) {
      return existingResponse;
    }
    if (existing.kind === 'duplicate') {
      return errorResponse(
        envelope,
        existing.error ?? createProtocolError('duplicate', 'operationId was reused'),
      );
    }
    if (existing.kind === 'pending') {
      return errorResponse(
        envelope,
        createProtocolError('busy', 'operation admission is already in progress'),
      );
    }

    const requestId = envelope.requestId;
    if (this.inboundRequests.size >= MAX_TRACKED_TASKS) {
      return errorResponse(
        envelope,
        createProtocolError('busy', 'task capacity is temporarily exhausted'),
      );
    }
    const queueEntry: RoutingQueueEntry<ProtocolEnvelope> = {
      id: requestId,
      requestId,
      value: envelope,
      expiresAt: envelope.expiresAt,
      state: 'queued',
      isCancelled: () => {
        const snapshot = this.taskStore.getTask(requestId);
        return snapshot?.state === 'cancelled' || snapshot?.state === 'cancelling';
      },
    };
    const admission = this.admitRequest(queueEntry);
    if (
      admission.state === 'busy' ||
      admission.state === 'expired' ||
      admission.state === 'cancelled'
    ) {
      return errorResponse(envelope, admission.error);
    }
    const reservation = this.dedupeStore.reserve(envelope);
    const replay = this.dedupeResponse(reservation);
    if (replay !== undefined) {
      if (reservation.reservation !== undefined) {
        this.dedupeStore.release(reservation.reservation);
      }
      if (admission.state === 'accepted') {
        this.policy.release(admission.lease);
      } else {
        this.policy.release(admission.handle);
      }
      return replay;
    }
    if (reservation.kind !== 'new' || reservation.reservation === undefined) {
      if (admission.state === 'accepted') {
        this.policy.release(admission.lease);
      } else {
        this.policy.release(admission.handle);
      }
      return errorResponse(
        envelope,
        reservation.error ?? createProtocolError('busy', 'operation admission is temporarily busy'),
      );
    }

    let snapshot: TaskSnapshot;
    try {
      snapshot = this.taskStore.createTask({
        requestId,
        operationId: envelope.operationId,
        owner: envelope.sender,
        createdAt: envelope.createdAt,
        expiresAt: envelope.expiresAt,
        initialState: admission.state === 'accepted' ? 'accepted' : 'queued',
      });
    } catch (error) {
      this.dedupeStore.release(reservation.reservation);
      this.releaseAdmission(admission);
      const protocolError =
        error instanceof Error
          ? createProtocolError('internal', error.message)
          : createProtocolError('internal', 'task admission failed');
      return errorResponse(envelope, protocolError);
    }
    const response = successResponse(envelope, {
      requestId,
      state: snapshot.state as 'accepted' | 'queued',
    });
    this.dedupeStore.commit(reservation.reservation, response, requestId);
    const record: InboundRequestRecord<Endpoint> = {
      envelope,
      target: source,
      taskRequestTarget: source,
      expectedResponse: envelope.payload.expectedResponse,
      ...(admission.state === 'accepted' ? { lease: admission.lease } : {}),
      terminalSent: false,
    };
    this.inboundRequests.set(requestId, record);
    if (admission.state === 'accepted') {
      this.leases.set(requestId, admission.lease);
      this.dispatchLease(requestId, admission.lease);
    } else {
      this.scheduleTaskExpiry(requestId, envelope.expiresAt);
    }
    return response;
  }

  private async processMessageNotify(
    envelope: Extract<ProtocolEnvelope, { operation: 'message.notify' }>,
  ): Promise<OperationResponse> {
    const existing = this.dedupeStore.inspect(envelope);
    const replay = this.dedupeResponse(existing);
    if (replay !== undefined) {
      return replay;
    }
    if (existing.kind === 'duplicate') {
      return errorResponse(
        envelope,
        existing.error ?? createProtocolError('duplicate', 'operationId was reused'),
      );
    }
    const reservation = this.dedupeStore.reserve(envelope);
    const reservationReplay = this.dedupeResponse(reservation);
    if (reservationReplay !== undefined) {
      return reservationReplay;
    }
    if (reservation.reservation === undefined) {
      return errorResponse(
        envelope,
        reservation.error ??
          createProtocolError('busy', 'notification admission is temporarily busy'),
      );
    }
    let error: ProtocolError | undefined;
    try {
      await this.onNotification?.({
        envelope,
        sender: {
          sessionId: envelope.sender.sessionId,
          runtimeId: envelope.sender.runtimeId,
        },
      });
    } catch (caught) {
      error = createProtocolError(
        'internal',
        caught instanceof Error ? caught.message : 'notification handler failed',
      );
    }
    const response =
      error === undefined
        ? successResponse(envelope, { delivered: true })
        : errorResponse(envelope, error);
    this.dedupeStore.commit(reservation.reservation, response);
    return response;
  }

  private processMessageReply(
    envelope: Extract<ProtocolEnvelope, { operation: 'message.reply' }>,
    source: RouterTarget<Endpoint>,
  ): OperationResponse {
    const request = this.outboundRequests.get(envelope.requestId);
    if (request === undefined) {
      return errorResponse(
        envelope,
        createProtocolError('not_found', 'logical request was not found'),
      );
    }
    if (
      request.target.runtimeId !== envelope.sender.runtimeId ||
      source.runtimeId !== envelope.sender.runtimeId
    ) {
      return errorResponse(
        envelope,
        createProtocolError('unauthorized', 'reply sender is not the expected recipient'),
      );
    }
    const validation = validateReplyContentForRequest(
      envelope.payload,
      request.expectedResponse,
      request.envelope.expiresAt,
      this.now(),
    );
    if (!validation.ok) {
      return errorResponse(envelope, validation.error);
    }
    const existing = this.dedupeStore.inspect(envelope, {
      expectedRequestExpiresAt: request.envelope.expiresAt,
    });
    const replay = this.dedupeResponse(existing);
    if (replay !== undefined) {
      return replay;
    }
    if (existing.kind === 'duplicate') {
      return errorResponse(
        envelope,
        existing.error ?? createProtocolError('duplicate', 'operationId was reused'),
      );
    }
    const reservation = this.dedupeStore.reserve(envelope, {
      expectedRequestExpiresAt: request.envelope.expiresAt,
    });
    const reservationReplay = this.dedupeResponse(reservation);
    if (reservationReplay !== undefined) {
      return reservationReplay;
    }
    if (reservation.reservation === undefined) {
      return errorResponse(
        envelope,
        reservation.error ?? createProtocolError('busy', 'reply delivery is temporarily busy'),
      );
    }
    let current = this.taskStore.getTask(envelope.requestId, { includeTerminalResponse: true });
    if (current === undefined) {
      this.dedupeStore.release(reservation.reservation);
      return errorResponse(
        envelope,
        createProtocolError('not_found', 'logical request was not found'),
      );
    }
    // A fast destination can finish before the admission acknowledgment has
    // traversed the transport. The explicit terminal reply proves admission;
    // linearize the sender-local task at accepted before applying the reply.
    if (current.state === 'created' || current.state === 'accepted' || current.state === 'queued') {
      current = this.taskStore.transition(envelope.requestId, 'working') ?? current;
      request.admissionResolved = true;
    }
    if (isTerminalTaskState(current.state)) {
      this.dedupeStore.release(reservation.reservation);
      const code = current.state === 'cancelled' ? 'cancelled' : 'not_cancelable';
      return errorResponse(
        envelope,
        createProtocolError(code, 'logical request is already terminal'),
      );
    }
    if (envelope.payload.outcome === 'cancelled' && current.state === 'working') {
      current =
        this.taskStore.transition(envelope.requestId, 'cancelling', {
          cancellationRequested: true,
        }) ?? current;
    }
    let snapshot: TaskSnapshot | undefined;
    const payload = envelope.payload;
    if (payload.outcome === 'completed') {
      snapshot = this.taskStore.completeTask(envelope.requestId, payload.content);
    } else if (payload.outcome === 'failed') {
      snapshot = this.taskStore.failTask(envelope.requestId, payload.error);
    } else if (payload.outcome === 'rejected') {
      snapshot = this.taskStore.rejectTask(envelope.requestId, payload.error);
    } else if (payload.outcome === 'cancelled') {
      snapshot = this.taskStore.transition(envelope.requestId, 'cancelled', {
        cancellationRequested: true,
        error: payload.error ?? createProtocolError('cancelled', 'request was cancelled'),
      });
    } else {
      snapshot = this.taskStore.expireTask(envelope.requestId);
    }
    if (snapshot === undefined) {
      this.dedupeStore.release(reservation.reservation);
      return errorResponse(
        envelope,
        createProtocolError('not_cancelable', 'logical request could not transition'),
      );
    }
    this.finishOutboundRequest(envelope.requestId, snapshot);
    const response = successResponse(envelope, {
      requestId: envelope.requestId,
      outcome: payload.outcome,
      delivered: true,
    });
    this.dedupeStore.commit(reservation.reservation, response, envelope.requestId);
    return response;
  }

  private processTaskStatus(
    envelope: Extract<ProtocolEnvelope, { operation: 'task.status' }>,
  ): OperationResponse {
    const result = this.taskStore.getStatusResult(envelope.requestId, {
      caller: envelope.sender,
      includeTerminalResponse: envelope.payload.includeTerminalResponse ?? true,
    });
    if (!result.ok) {
      return errorResponse(
        envelope,
        result.code === 'unauthorized'
          ? createProtocolError('unauthorized', 'task status is not available')
          : createProtocolError('not_found', 'logical request was not found'),
      );
    }
    return successResponse(envelope, { snapshot: result.snapshot });
  }

  private processTaskCancel(
    envelope: Extract<ProtocolEnvelope, { operation: 'task.cancel' }>,
  ): OperationResponse {
    const existing = this.dedupeStore.inspect(envelope);
    const replay = this.dedupeResponse(existing);
    if (replay !== undefined) {
      return replay;
    }
    if (existing.kind === 'duplicate') {
      return errorResponse(
        envelope,
        existing.error ?? createProtocolError('duplicate', 'operationId was reused'),
      );
    }
    const reservation = this.dedupeStore.reserve(envelope);
    const reservationReplay = this.dedupeResponse(reservation);
    if (reservationReplay !== undefined) {
      return reservationReplay;
    }
    if (reservation.reservation === undefined) {
      return errorResponse(
        envelope,
        reservation.error ??
          createProtocolError('busy', 'cancellation admission is temporarily busy'),
      );
    }
    const result = this.taskStore.cancelTask(envelope.requestId, {
      caller: envelope.sender,
      reason: envelope.payload.reason,
    });
    if (!result.ok) {
      this.dedupeStore.release(reservation.reservation);
      const errorCode =
        result.code === 'unauthorized'
          ? 'unauthorized'
          : result.code === 'not_found'
            ? 'not_found'
            : 'not_cancelable';
      return errorResponse(
        envelope,
        createProtocolError(errorCode, `task cancellation failed: ${result.code}`),
      );
    }
    if (result.state === 'cancelled') {
      this.finishTask(envelope.requestId, result.snapshot);
    }
    const response = successResponse(envelope, { snapshot: result.snapshot });
    this.dedupeStore.commit(reservation.reservation, response, envelope.requestId);
    return response;
  }

  private admitRequest(
    entry: RoutingQueueEntry<ProtocolEnvelope>,
  ): QueueAdmissionDecision<ProtocolEnvelope> {
    if (this.policy.availableActiveCapacity > 0) {
      return this.policy.accept(entry);
    }
    return this.policy.enqueue(entry);
  }

  private dispatchLease(requestId: RequestId, lease: QueueLease<ProtocolEnvelope>): void {
    const task = this.taskStore.beginExecution(requestId);
    if (task === undefined) {
      this.policy.release(lease);
      this.leases.delete(requestId);
      return;
    }
    this.scheduleTaskExpiry(requestId, task.snapshot.expiresAt);
    if (this.requestExecutor === undefined) {
      this.policy.release(lease);
      this.leases.delete(requestId);
      return;
    }
    void Promise.resolve()
      .then(() =>
        this.requestExecutor?.({
          request: lease.value as MessageRequestEnvelope,
          requestId,
          snapshot: task.snapshot,
          signal: task.signal,
          complete: (content) => this.taskStore.completeTask(requestId, content),
          fail: (error) => this.taskStore.failTask(requestId, error),
          reject: (error) => this.taskStore.rejectTask(requestId, error),
        }),
      )
      .then((result) => {
        const current = this.taskStore.getTask(requestId, { includeTerminalResponse: true });
        if (current === undefined || isTerminalTaskState(current.state)) {
          this.finishTask(requestId, current);
          return;
        }
        if (isRecord(result) && result.outcome === 'rejected') {
          this.finishTask(
            requestId,
            this.taskStore.rejectTask(
              requestId,
              result.error ?? createProtocolError('malformed', 'request was rejected'),
            ),
          );
          return;
        }
        const update = taskUpdateForExecutorResult(result);
        if (update.content !== undefined) {
          this.finishTask(requestId, this.taskStore.completeTask(requestId, update.content));
        } else if (update.error !== undefined) {
          this.finishTask(requestId, this.taskStore.failTask(requestId, update.error));
        }
      })
      .catch((error: unknown) => {
        const current = this.taskStore.getTask(requestId, { includeTerminalResponse: true });
        if (current?.state === 'cancelling') {
          this.finishTask(
            requestId,
            this.taskStore.transition(requestId, 'cancelled', {
              cancellationRequested: true,
              error: createProtocolError('cancelled', 'request executor acknowledged cancellation'),
            }),
          );
        } else if (current !== undefined && !isTerminalTaskState(current.state)) {
          this.finishTask(
            requestId,
            this.taskStore.failTask(
              requestId,
              createProtocolError(
                'internal',
                error instanceof Error ? error.message : 'request executor failed',
              ),
            ),
          );
        }
      });
  }

  private drainQueue(): void {
    while (this.policy.availableActiveCapacity > 0) {
      const lease = this.policy.dequeue();
      if (lease === undefined) {
        return;
      }
      const requestId = lease.requestId as RequestId | undefined;
      if (requestId === undefined) {
        this.policy.release(lease);
        continue;
      }
      this.leases.set(requestId, lease);
      this.dispatchLease(requestId, lease);
    }
  }

  private finishTask(
    requestId: RequestId,
    snapshot: TaskSnapshot | undefined,
  ): RouterTaskResult | undefined {
    if (snapshot === undefined) {
      return undefined;
    }
    this.onTaskStateChange?.(requestId, snapshot);
    if (!isTerminalTaskState(snapshot.state)) {
      return { snapshot };
    }
    const lease = this.leases.get(requestId);
    if (lease !== undefined) {
      this.policy.release(lease);
      this.leases.delete(requestId);
      this.drainQueue();
    } else {
      this.policy.cancelByRequestId(requestId);
      this.drainQueue();
    }
    this.clearTaskExpiry(requestId);
    const record = this.inboundRequests.get(requestId);
    if (record !== undefined && !record.terminalSent) {
      record.terminalSent = true;
      void this.sendTerminalReply(record, snapshot);
    }
    return { snapshot };
  }

  private finishOutboundRequest(requestId: RequestId, snapshot: TaskSnapshot): void {
    const record = this.outboundRequests.get(requestId);
    if (record === undefined || !isTerminalSnapshot(snapshot)) {
      return;
    }
    if (record.terminalSnapshot === undefined) {
      record.terminalSnapshot = snapshot;
      record.resolveCompletion(snapshot);
    }
  }

  private async sendTerminalReply(
    record: InboundRequestRecord<Endpoint>,
    snapshot: TaskSnapshot,
  ): Promise<void> {
    if (!isTerminalTaskState(snapshot.state)) {
      return;
    }
    const now = nowMs(this.now);
    const expiresAtMs = Date.parse(record.envelope.expiresAt);
    const createdAtMs = Math.min(now, Math.max(0, expiresAtMs - 1));
    const payload: MessageReplyPayload =
      snapshot.state === 'completed'
        ? { outcome: 'completed', content: snapshot.content ?? { type: 'text', text: '' } }
        : snapshot.state === 'failed'
          ? {
              outcome: 'failed',
              error: snapshot.error ?? createProtocolError('internal', 'task failed'),
            }
          : snapshot.state === 'rejected'
            ? {
                outcome: 'rejected',
                error: snapshot.error ?? createProtocolError('malformed', 'task rejected'),
              }
            : snapshot.state === 'cancelled'
              ? {
                  outcome: 'cancelled',
                  error: snapshot.error ?? createProtocolError('cancelled', 'task cancelled'),
                }
              : {
                  outcome: 'expired',
                  error: snapshot.error ?? createProtocolError('expired', 'task expired'),
                };
    const envelope: ProtocolEnvelope = {
      protocolVersion: PROTOCOL_VERSION,
      operation: 'message.reply',
      operationId: asUuidV4(randomUUID()),
      requestId: record.envelope.requestId,
      sender: identitySender(this.identity),
      recipientRuntimeId: record.envelope.sender.runtimeId,
      roomId: this.roomId,
      createdAt: asUtcTimestamp(new Date(createdAtMs).toISOString()),
      expiresAt: record.envelope.expiresAt,
      traceId: record.envelope.traceId,
      parentOperationId: record.envelope.operationId,
      payload,
    } as ProtocolEnvelope;
    const target = record.taskRequestTarget;
    const result = await this.sendEnvelope(envelope, target);
    if (result.status === 'failed') {
      this.reportUnreachable(envelope.operationId, result.error);
    }
    this.inboundRequests.delete(record.envelope.requestId);
  }

  private scheduleTaskExpiry(requestId: RequestId, expiresAt: UtcTimestamp): void {
    const record = this.inboundRequests.get(requestId);
    if (record === undefined || record.expiryTimer !== undefined) {
      return;
    }
    const delay = Math.max(0, Date.parse(expiresAt) - nowMs(this.now));
    const timer = setTimeout(
      () => {
        record.expiryTimer = undefined;
        const snapshot = this.taskStore.expireTask(requestId);
        this.finishTask(requestId, snapshot);
      },
      Math.min(delay, MAX_TIMER_DELAY_MS),
    );
    const unref = (timer as unknown as { unref?: () => void }).unref;
    unref?.call(timer);
    record.expiryTimer = timer;
  }

  private clearTaskExpiry(requestId: RequestId): void {
    const record = this.inboundRequests.get(requestId);
    if (record?.expiryTimer !== undefined) {
      clearTimeout(record.expiryTimer as ReturnType<typeof setTimeout>);
      record.expiryTimer = undefined;
    }
  }

  private releaseAdmission(admission: QueueAdmissionDecision<ProtocolEnvelope>): void {
    if (admission.state === 'accepted') {
      this.policy.release(admission.lease);
    } else if (admission.state === 'queued') {
      this.policy.release(admission.handle);
    }
  }

  private dedupeResponse(
    decision: DedupeDecision<OperationResponse, RequestId>,
  ): OperationResponse | undefined {
    return decision.action === 'replay' && decision.result !== undefined
      ? decision.result
      : undefined;
  }

  private validateOutbound(envelope: ProtocolEnvelope): ValidationResult<ProtocolEnvelope> {
    const expectedRequestExpiresAt =
      envelope.operation === 'message.reply'
        ? (this.outboundRequests.get(envelope.requestId)?.envelope.expiresAt ??
          this.inboundRequests.get(envelope.requestId)?.envelope.expiresAt)
        : undefined;
    return validateEnvelope(envelope, {
      now: this.now(),
      limits: this.limits,
      ...(expectedRequestExpiresAt === undefined ? {} : { expectedRequestExpiresAt }),
    });
  }

  private async sendAndWait(
    envelope: ProtocolEnvelope,
    target: RouterTarget<Endpoint>,
    requestId: RequestId | undefined,
  ): Promise<OperationResponse> {
    if (this.pending.size >= MAX_PENDING_OPERATIONS) {
      throw new RouterError(
        createProtocolError('busy', 'router response capacity is temporarily exhausted'),
      );
    }
    const operationId = String(envelope.operationId);
    const responsePromise = new Promise<OperationResponse>((resolve, reject) => {
      this.pending.set(operationId, {
        operation: envelope.operation,
        ...(requestId === undefined ? {} : { requestId }),
        resolve,
        reject,
      });
    });
    const delivery = await this.sendEnvelope(envelope, target);
    if (delivery.status === 'failed') {
      this.pending.delete(operationId);
      throw new RouterError(transportFailureError(delivery));
    }
    return responsePromise;
  }

  private applyResponse(response: OperationResponse): void {
    const pending = this.pending.get(String(response.operationId));
    if (pending === undefined) {
      return;
    }
    this.pending.delete(String(response.operationId));
    if (!('result' in response) || response.result === undefined) {
      pending.reject(new RouterError(response.error));
      return;
    }
    if (response.operation === 'message.request') {
      const requestId = pending.requestId;
      const record = requestId === undefined ? undefined : this.outboundRequests.get(requestId);
      if (record !== undefined && response.result.requestId === requestId) {
        const transitioned = this.taskStore.transition(requestId, response.result.state, {});
        if (transitioned !== undefined) {
          record.admissionResolved = true;
        }
      }
    }
    pending.resolve(response);
  }

  private buildRequestEnvelope(input: RouterRequestInput): MessageRequestEnvelope {
    const operationId = asUuidV4(randomUUID());
    const now = nowMs(this.now);
    const envelope = {
      protocolVersion: PROTOCOL_VERSION,
      operation: 'message.request',
      operationId,
      requestId: operationId,
      sender: identitySender(this.identity),
      recipientRuntimeId: asRuntimeId(input.recipientRuntimeId),
      roomId: this.roomId,
      createdAt: protocolTimestamp(now),
      expiresAt: deadlineValue(input.expiresAt, now, this.limits.maxRequestTtlMs),
      traceId: traceValue(input.traceId),
      ...(input.parentOperationId === undefined
        ? {}
        : { parentOperationId: input.parentOperationId }),
      payload: {
        content: input.content,
        ...(input.expectedResponse === undefined
          ? {}
          : { expectedResponse: input.expectedResponse }),
        ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
      },
    } as unknown as ProtocolEnvelope;
    const validation = validateEnvelope(envelope, { now, limits: this.limits });
    if (!validation.ok) {
      throw new RouterError(validation.error);
    }
    return validation.value as MessageRequestEnvelope;
  }

  private buildDescribeEnvelope(
    recipientRuntimeId: RuntimeId,
  ): Extract<ProtocolEnvelope, { operation: 'peer.describe' }> {
    const now = nowMs(this.now);
    const envelope = {
      protocolVersion: PROTOCOL_VERSION,
      operation: 'peer.describe',
      operationId: asUuidV4(randomUUID()),
      sender: identitySender(this.identity),
      recipientRuntimeId: asRuntimeId(recipientRuntimeId),
      roomId: this.roomId,
      createdAt: protocolTimestamp(now),
      expiresAt: deadlineValue(undefined, now, this.limits.maxControlTtlMs),
      traceId: traceValue(undefined),
      payload: {},
    } as unknown as ProtocolEnvelope;
    const validation = validateEnvelope(envelope, { now, limits: this.limits });
    if (!validation.ok) {
      throw new RouterError(validation.error);
    }
    return validation.value as Extract<ProtocolEnvelope, { operation: 'peer.describe' }>;
  }
  private buildNotifyEnvelope(
    input: RouterNotificationInput,
  ): Extract<ProtocolEnvelope, { operation: 'message.notify' }> {
    const now = nowMs(this.now);
    const envelope: ProtocolEnvelope = {
      protocolVersion: PROTOCOL_VERSION,
      operation: 'message.notify',
      operationId: asUuidV4(randomUUID()),
      sender: identitySender(this.identity),
      recipientRuntimeId: asRuntimeId(input.recipientRuntimeId),
      roomId: this.roomId,
      createdAt: protocolTimestamp(now),
      expiresAt: deadlineValue(input.expiresAt, now, this.limits.maxRequestTtlMs),
      traceId: traceValue(input.traceId),
      payload: {
        content: input.content,
        ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
      },
    };
    const validation = validateEnvelope(envelope, { now, limits: this.limits });
    if (!validation.ok) {
      throw new RouterError(validation.error);
    }
    return validation.value as Extract<ProtocolEnvelope, { operation: 'message.notify' }>;
  }

  private buildStatusEnvelope(input: RouterOperationInput): TaskStatusEnvelope {
    return this.buildControlEnvelope('task.status', input, {} as never) as TaskStatusEnvelope;
  }

  private buildCancelEnvelope(
    input: RouterOperationInput & { readonly reason?: string },
  ): TaskCancelEnvelope {
    return this.buildControlEnvelope('task.cancel', input, {
      ...(input.reason === undefined ? {} : { reason: input.reason }),
    }) as TaskCancelEnvelope;
  }

  private buildControlEnvelope(
    operation: 'task.status' | 'task.cancel',
    input: RouterOperationInput,
    payload: unknown,
  ): ProtocolEnvelope {
    const now = nowMs(this.now);
    const envelope = {
      protocolVersion: PROTOCOL_VERSION,
      operation,
      operationId: asUuidV4(randomUUID()),
      requestId: asUuidV4(input.requestId),
      sender: identitySender(this.identity),
      recipientRuntimeId: asRuntimeId(input.recipientRuntimeId),
      roomId: this.roomId,
      createdAt: protocolTimestamp(now),
      expiresAt: deadlineValue(input.expiresAt, now, this.limits.maxControlTtlMs),
      traceId: traceValue(input.traceId),
      ...(input.parentOperationId === undefined
        ? {}
        : { parentOperationId: input.parentOperationId }),
      payload: payload as never,
    } as unknown as ProtocolEnvelope;
    const validation = validateEnvelope(envelope, { now, limits: this.limits });
    if (!validation.ok) {
      throw new RouterError(validation.error);
    }
    return validation.value;
  }

  private async resolveTarget(runtimeId: RuntimeId): Promise<RouterTarget<Endpoint> | undefined> {
    if (this.targetResolver !== undefined) {
      const target = await this.targetResolver(runtimeId);
      if (target !== undefined) {
        return target;
      }
    }
    const registryTarget = this.registry?.get?.(runtimeId);
    const endpoint =
      registryTarget?.endpoint ??
      this.registry?.endpointFor?.(runtimeId) ??
      this.registry?.currentEndpoint?.(runtimeId);
    if (endpoint === undefined) {
      return undefined;
    }
    const address =
      typeof endpoint === 'string'
        ? endpoint
        : isRecord(endpoint) && typeof endpoint.address === 'string'
          ? endpoint.address
          : endpoint;
    return {
      runtimeId,
      endpoint: address as Endpoint,
    };
  }

  private createAgentCard(options: RouterOptions<Endpoint>): AgentCard {
    const operations: readonly OperationCapability[] = OPERATION_NAMES.map((operation) => ({
      operation,
    }));
    const contentCapabilities: readonly ContentCapability[] = [
      { type: 'text' },
      { type: 'json', supportsSchema: true },
    ];
    const capabilities: AgentCapabilities = {
      supportsCancellation: options.supportsCancellation ?? true,
      supportsNotifications: options.supportsNotifications ?? true,
    };
    return Object.freeze({
      name: options.name ?? 'pi-to-pi-runtime',
      ...(options.description === undefined ? {} : { description: options.description }),
      sessionId: this.identity.sessionId,
      runtimeId: this.runtimeId,
      supportedProtocolVersions: [PROTOCOL_VERSION as ProtocolVersion],
      operations,
      contentCapabilities,
      capabilities,
      limits: this.limits,
    });
  }

  private isMessageRequestEnvelope(
    value: RouterRequestInput | MessageRequestEnvelope,
  ): value is MessageRequestEnvelope {
    return isRecord(value) && value.operation === 'message.request';
  }

  private isMessageNotifyEnvelope(
    value: RouterNotificationInput | Extract<ProtocolEnvelope, { operation: 'message.notify' }>,
  ): value is Extract<ProtocolEnvelope, { operation: 'message.notify' }> {
    return isRecord(value) && value.operation === 'message.notify';
  }

  private isTaskStatusEnvelope(
    value: RouterOperationInput | TaskStatusEnvelope,
  ): value is TaskStatusEnvelope {
    return isRecord(value) && value.operation === 'task.status';
  }

  private isTaskCancelEnvelope(
    value: (RouterOperationInput & { readonly reason?: string }) | TaskCancelEnvelope,
  ): value is TaskCancelEnvelope {
    return isRecord(value) && value.operation === 'task.cancel';
  }

  private reportUnreachable(operationId: OperationId, cause: unknown): void {
    const error =
      cause instanceof Error && cause.name === 'RouterError'
        ? (cause as RouterError).protocolError
        : cause instanceof Error &&
            'code' in cause &&
            (cause as { code?: unknown }).code === 'unreachable'
          ? createProtocolError('unreachable', cause.message)
          : createProtocolError(
              'unreachable',
              cause instanceof Error ? cause.message : 'delivery could not be established',
            );
    this.onUnreachable?.(operationId, error);
  }

  private ensureOpen(): void {
    if (this.closed) {
      throw new RouterError(createProtocolError('unreachable', 'router is closed'));
    }
  }
}

function validateReplyContentForRequest(
  payload: MessageReplyPayload,
  expectedResponse: ExpectedResponse | undefined,
  requestExpiresAt: UtcTimestamp,
  now: number,
): ValidationResult<MessageReplyPayload> {
  if (payload.outcome !== 'completed' || expectedResponse === undefined) {
    return { ok: true, value: payload };
  }
  const result = validateReplyContent(payload.content, expectedResponse, {
    now,
    expectedRequestExpiresAt: requestExpiresAt,
  });
  if (!result.ok) {
    return result as ValidationResult<MessageReplyPayload>;
  }
  return { ok: true, value: payload };
}

/** Compatibility aliases for callers that use the shorter router name. */
export const Router = MessageRouter;
export const OperationRouter = MessageRouter;
export const createRouter = <Endpoint = TransportEndpoint>(
  options: RouterOptions<Endpoint>,
): MessageRouter<Endpoint> => new MessageRouter(options);
export const createMessageRouter = createRouter;

/** Build a persistence boundary for router consumers that only have runtime options. */
export function createRouterPersistence(options: RuntimePersistenceOptions): RuntimePersistence {
  return new RuntimePersistence(options);
}
