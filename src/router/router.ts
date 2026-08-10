import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';

import { createProtocolConfig } from '../config.js';
import { DEFAULT_LEASE_TTL_MS, type AgentCard } from '../protocol/agent-card.js';
import { createPeerDescribeResult } from '../protocol/capabilities.js';
import { createProtocolError, type ProtocolError } from '../protocol/errors.js';
import type {
  BindingAuthenticationResult,
  BindingAuthenticator,
  OutboundDelivery,
  OutboundDeliveryResult,
  ProtocolAwaitable,
  ProtocolClock,
  ProtocolClockPair,
  TaskExecutor,
  TaskExecutorResult,
} from '../protocol/interfaces.js';
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
  type ProtocolLimits,
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
  validateSerializedEnvelope,
  type ValidationResult,
} from '../protocol/validation.js';
import { isTerminalTaskState, type TaskSnapshot } from '../protocol/task-state.js';
import { RuntimeScopedDedupeStore, type DedupeDecision } from './dedupe.js';
import {
  RoutingPolicy,
  type QueueAdmissionDecision,
  type QueueLease,
  type RoutingPolicyOptions,
  type RoutingQueueEntry,
} from './policy.js';
import {
  TaskStore,
  type CancellationRequestOptions,
  type TaskStoreOptions,
  type TaskTransitionUpdate,
} from './task-store.js';

/** Re-export the transport/Pi-independent seams at the router boundary. */
export type {
  AuthenticatedBindingContext,
  BindingAuthenticationFailure,
  BindingAuthenticationResult,
  BindingAuthenticator,
  BindingIdentity,
  CancellationSignal,
  Delivery,
  OutboundDelivery,
  OutboundDeliveryFailure,
  OutboundDeliveryResult,
  OutboundDeliverySuccess,
  ProtocolAwaitable,
  ProtocolClock,
  ProtocolClockPair,
  ProtocolTaskExecutor,
  TaskCancellation,
  TaskExecutor,
  TaskExecutorContext,
  TaskExecutorResult,
} from '../protocol/interfaces.js';

/** A minimal sender identity accepted by router construction helpers. */
export interface RouterIdentity {
  readonly sessionId: string;
  readonly runtimeId: string;
}

/** A callback used for notifications; notifications never create task records. */
export interface RouterNotificationContext {
  readonly envelope: Extract<ProtocolEnvelope, { operation: 'message.notify' }>;
  readonly sender: SenderIdentity;
}

export type RouterNotificationHandler = (
  context: RouterNotificationContext,
) => ProtocolAwaitable<void>;

/** Compatibility delivery shape for adapters that call the method sendEnvelope. */
export interface RouterEnvelopeDelivery {
  readonly sendEnvelope?: (envelope: ProtocolEnvelope) => ProtocolAwaitable<OutboundDeliveryResult>;
  readonly send?: (envelope: ProtocolEnvelope) => ProtocolAwaitable<OutboundDeliveryResult>;
  readonly sendResponse?: (
    response: OperationResponse,
    recipientRuntimeId: RuntimeId,
    roomId: RoomId,
  ) => ProtocolAwaitable<OutboundDeliveryResult>;
}

export type RouterDelivery =
  | OutboundDelivery
  | RouterEnvelopeDelivery
  | ((envelope: ProtocolEnvelope) => ProtocolAwaitable<OutboundDeliveryResult>);

/** An inbound operation and optional authenticated binding metadata. */
export interface RouterInboundEnvelope {
  readonly envelope: unknown;
  readonly binding?: unknown;
  readonly source?: unknown;
  readonly reply?: (response: OperationResponse) => ProtocolAwaitable<unknown>;
}

export interface RouterRequestExecutorContext {
  readonly request: MessageRequestEnvelope;
  readonly requestId: RequestId;
  readonly snapshot: TaskSnapshot;
  readonly signal: AbortSignal;
  readonly complete: (content: Content) => TaskSnapshot | undefined;
  readonly fail: (error: ProtocolError) => TaskSnapshot | undefined;
  readonly reject: (error: ProtocolError) => TaskSnapshot | undefined;
}

export type RouterRequestExecutorResult = TaskExecutorResult;
export type RouterRequestExecutor = TaskExecutor;

export interface RouterRequestInput {
  readonly recipientRuntimeId: RuntimeId | string;
  readonly content: Content;
  readonly expectedResponse?: ExpectedResponse;
  readonly metadata?: JsonObject;
  readonly expiresAt?: UtcTimestamp | string | number | Date;
  readonly parentOperationId?: OperationId;
  readonly traceId?: string;
}

export interface RouterNotificationInput {
  readonly recipientRuntimeId: RuntimeId | string;
  readonly content: Content;
  readonly metadata?: JsonObject;
  readonly expiresAt?: UtcTimestamp | string | number | Date;
  readonly traceId?: string;
}

export interface RouterOperationInput {
  readonly recipientRuntimeId: RuntimeId | string;
  readonly requestId: RequestId | string;
  readonly expiresAt?: UtcTimestamp | string | number | Date;
  readonly traceId?: string;
  readonly parentOperationId?: OperationId;
}

export interface RouterRequestHandle {
  readonly requestId: RequestId;
  readonly operationId: OperationId;
  readonly envelope: MessageRequestEnvelope;
  readonly admission: Promise<OperationResponse>;
  readonly completion: Promise<TaskSnapshot>;
}

export interface RouterTaskResult {
  readonly snapshot: TaskSnapshot;
  readonly reply?: ProtocolEnvelope;
}

export interface RouterClockOptions {
  readonly clock?: ProtocolClock | ProtocolClockPair;
  readonly now?: () => number;
  readonly wallNow?: () => number;
  readonly monotonicNow?: () => number;
  readonly setTimeout?: (callback: () => void, delayMs: number) => unknown;
  readonly clearTimeout?: (handle: unknown) => void;
}

export interface RouterOptions extends RouterClockOptions {
  readonly identity?: RouterIdentity;
  readonly sessionId?: string;
  readonly runtimeId?: string;
  readonly localSessionId?: string;
  readonly localRuntimeId?: string;
  readonly roomId?: RoomId | string;
  readonly localRoomId?: RoomId | string;
  readonly delivery?: RouterDelivery;
  readonly outboundDelivery?: RouterDelivery;
  readonly authenticator?: BindingAuthenticator;
  readonly bindingAuthenticator?: BindingAuthenticator;
  readonly binding?: unknown;
  readonly taskExecutor?: TaskExecutor;
  readonly requestExecutor?: TaskExecutor;
  readonly executor?: TaskExecutor;
  readonly onNotification?: RouterNotificationHandler;
  readonly notificationHandler?: RouterNotificationHandler;
  readonly onTaskStateChange?: (requestId: RequestId, snapshot: TaskSnapshot) => void;
  readonly onUnreachable?: (operationId: OperationId, error: ProtocolError) => void;
  readonly taskStore?: TaskStore;
  readonly taskStoreOptions?: TaskStoreOptions;
  readonly dedupeStore?: RuntimeScopedDedupeStore<OperationResponse, RequestId>;
  readonly routingPolicy?: RoutingPolicy<ProtocolEnvelope>;
  readonly routingPolicyOptions?: RoutingPolicyOptions<ProtocolEnvelope>;
  readonly limits?: Partial<ProtocolLimits>;
  readonly agentCard?: AgentCard;
  readonly card?: AgentCard;
  readonly displayName?: string;
  readonly name?: string;
  readonly description?: string;
  readonly supportsCancellation?: boolean;
  readonly supportsNotifications?: boolean;
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

interface OutboundRequestRecord {
  readonly envelope: MessageRequestEnvelope;
  readonly expectedTargetRuntimeId: RuntimeId;
  readonly expectedResponse?: ExpectedResponse;
  readonly completion: Promise<TaskSnapshot>;
  readonly resolveCompletion: (snapshot: TaskSnapshot) => void;
  readonly rejectCompletion: (error: unknown) => void;
  admissionResolved: boolean;
  terminalSnapshot?: TaskSnapshot;
}

interface InboundRequestRecord {
  readonly envelope: MessageRequestEnvelope;
  readonly binding?: unknown;
  readonly expectedResponse?: ExpectedResponse;
  lease?: QueueLease<ProtocolEnvelope>;
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

interface PartialBindingIdentity {
  readonly runtimeId?: unknown;
  readonly senderRuntimeId?: unknown;
  readonly localRuntimeId?: unknown;
  readonly roomId?: unknown;
  readonly localRoomId?: unknown;
  readonly sender?: { readonly runtimeId?: unknown };
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
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value)
  );
}

function wallTimestamp(value: number): UtcTimestamp {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new RangeError('protocol clock must return a finite epoch');
  }
  return asUtcTimestamp(date.toISOString());
}

function readClock(clock: (() => number) | undefined, fallback: () => number): () => number {
  const selected = clock ?? fallback;
  return () => {
    const value = selected();
    if (!Number.isFinite(value)) {
      throw new RangeError('router clock must return a finite number');
    }
    return value;
  };
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
  return wallTimestamp(deadline);
}

function traceValue(value: string | undefined): ReturnType<typeof asTraceId> {
  if (value !== undefined && /^[0-9a-f]{32}$/u.test(value)) {
    return asTraceId(value);
  }
  return asTraceId(randomUUID().replaceAll('-', ''));
}

function identitySender(identity: RouterIdentity): SenderIdentity {
  return {
    sessionId: asSessionId(identity.sessionId),
    runtimeId: asRuntimeId(identity.runtimeId),
  };
}

function isTerminalSnapshot(snapshot: TaskSnapshot | undefined): snapshot is TaskSnapshot {
  return snapshot !== undefined && isTerminalTaskState(snapshot.state);
}

function cloneError(error: ProtocolError): ProtocolError {
  return {
    ...error,
    ...(error.details === undefined ? {} : { details: { ...error.details } }),
  };
}

function safeInternalError(): ProtocolError {
  return createProtocolError('internal', 'router operation failed');
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
  return responseFor(envelope, { error: cloneError(error) });
}

function successResponse(envelope: ProtocolEnvelope, result: unknown): OperationResponse {
  return responseFor(envelope, { result });
}

function partialBinding(value: unknown): PartialBindingIdentity | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  return value as PartialBindingIdentity;
}

function bindingRuntimeId(value: unknown): string | undefined {
  const binding = partialBinding(value);
  if (binding === undefined) {
    return undefined;
  }
  if (typeof binding.senderRuntimeId === 'string') {
    return binding.senderRuntimeId;
  }
  if (typeof binding.runtimeId === 'string') {
    return binding.runtimeId;
  }
  if (typeof binding.sender?.runtimeId === 'string') {
    return binding.sender.runtimeId;
  }
  return undefined;
}

function taskUpdateForExecutorResult(result: RouterRequestExecutorResult): TaskTransitionUpdate {
  if (result === undefined || result === null) {
    return {};
  }
  if (typeof result === 'object' && 'outcome' in result) {
    if (result.outcome === 'failed') {
      return { error: result.error ?? createProtocolError('internal', 'request executor failed') };
    }
    if (result.outcome === 'rejected') {
      return { error: result.error ?? createProtocolError('malformed', 'request was rejected') };
    }
    return result.content === undefined ? {} : { content: result.content };
  }
  if (typeof result === 'object' && ('content' in result || 'error' in result)) {
    return {
      ...(result.content === undefined ? {} : { content: result.content }),
      ...(result.error === undefined ? {} : { error: result.error }),
    };
  }
  return { content: result as Content };
}

function deliveryFailure(error: unknown): OutboundDeliveryResult {
  return {
    delivered: false,
    error: createProtocolError(
      'unreachable',
      error instanceof Error ? error.message : 'delivery could not be established',
    ),
  };
}

function isDelivered(
  result: OutboundDeliveryResult,
): result is Extract<OutboundDeliveryResult, { readonly delivered: true }> {
  return result.delivered === true;
}

/**
 * Transport-independent v1 operation router.
 *
 * The router accepts already authenticated binding metadata at its inbound
 * boundary and delegates outbound delivery to a narrow injected seam. It does
 * not import sockets, discovery persistence, or Pi lifecycle values.
 */
export class MessageRouter {
  public readonly identity: RouterIdentity;
  public readonly sessionId: string;
  public readonly runtimeId: RuntimeId;
  public readonly roomId: RoomId;
  public readonly limits: ProtocolLimits;
  public readonly delivery?: RouterDelivery;
  public readonly taskStore: TaskStore;
  public readonly tasks: TaskStore;
  public readonly dedupeStore: RuntimeScopedDedupeStore<OperationResponse, RequestId>;
  public readonly dedupe: RuntimeScopedDedupeStore<OperationResponse, RequestId>;
  public readonly policy: RoutingPolicy<ProtocolEnvelope>;

  private readonly authenticator?: BindingAuthenticator;
  private readonly defaultBinding?: unknown;
  private readonly requestExecutor?: TaskExecutor;
  private readonly onNotification?: RouterNotificationHandler;
  private readonly onTaskStateChange?: (requestId: RequestId, snapshot: TaskSnapshot) => void;
  private readonly onUnreachable?: (operationId: OperationId, error: ProtocolError) => void;
  private readonly supportsCancellation: boolean;
  private readonly supportsNotifications: boolean;
  private readonly wallNow: () => number;
  private readonly monotonicNow: () => number;
  private readonly setTimeoutFn: (callback: () => void, delayMs: number) => unknown;
  private readonly clearTimeoutFn: (handle: unknown) => void;
  private readonly agentCard: AgentCard;
  private readonly pending = new Map<string, PendingOperation>();
  private readonly outboundRequests = new Map<string, OutboundRequestRecord>();
  private readonly inboundRequests = new Map<string, InboundRequestRecord>();
  private readonly leases = new Map<string, QueueLease<ProtocolEnvelope>>();
  private readonly expiryTimers = new Map<string, unknown>();
  private closed = false;

  public constructor(options: RouterOptions) {
    const identity = options.identity ?? {
      sessionId: options.sessionId ?? options.localSessionId,
      runtimeId: options.runtimeId ?? options.localRuntimeId,
    };
    if (identity.sessionId === undefined || identity.runtimeId === undefined) {
      throw new TypeError('router sessionId and runtimeId are required');
    }

    this.identity = Object.freeze({
      sessionId: identity.sessionId,
      runtimeId: identity.runtimeId,
    });
    this.sessionId = this.identity.sessionId;
    this.runtimeId = asRuntimeId(this.identity.runtimeId);
    const roomId = options.roomId ?? options.localRoomId;
    if (roomId === undefined) {
      throw new TypeError('router roomId is required');
    }
    this.roomId = asRoomId(roomId);
    this.limits = Object.freeze(createProtocolConfig(options.limits));
    this.delivery = options.delivery ?? options.outboundDelivery;
    this.authenticator = options.authenticator ?? options.bindingAuthenticator;
    this.defaultBinding = options.binding;
    this.requestExecutor = options.taskExecutor ?? options.requestExecutor ?? options.executor;
    this.onNotification = options.onNotification ?? options.notificationHandler;
    this.onTaskStateChange = options.onTaskStateChange;
    this.supportsCancellation = options.supportsCancellation ?? true;
    this.supportsNotifications = options.supportsNotifications ?? true;

    const clock = options.clock;
    const clockPair = typeof clock === 'function' ? undefined : clock;
    const wallClock =
      options.wallNow ??
      options.now ??
      (clockPair === undefined
        ? undefined
        : 'wallNow' in clockPair
          ? () => clockPair.wallNow()
          : () => clockPair.wall());
    const monotonicClock =
      options.monotonicNow ??
      (clockPair === undefined
        ? undefined
        : 'monotonicNow' in clockPair
          ? () => clockPair.monotonicNow()
          : () => clockPair.monotonic());
    this.wallNow = readClock(wallClock, () => Date.now());
    this.monotonicNow = readClock(monotonicClock, () => performance.timeOrigin + performance.now());
    this.setTimeoutFn =
      options.setTimeout ??
      (clockPair !== undefined && clockPair.setTimeout !== undefined
        ? clockPair.setTimeout
        : (callback, delayMs) => globalThis.setTimeout(callback, delayMs));
    this.clearTimeoutFn =
      options.clearTimeout ??
      (clockPair !== undefined && clockPair.clearTimeout !== undefined
        ? clockPair.clearTimeout
        : (handle) => globalThis.clearTimeout(handle as Parameters<typeof clearTimeout>[0]));
    const policyOptions = options.routingPolicyOptions ?? {};
    const configuredQueueCapacity =
      policyOptions.capacity ??
      policyOptions.queueCapacity ??
      policyOptions.maxQueueEntries ??
      policyOptions.limits?.maxQueueEntries;
    this.policy =
      options.routingPolicy ??
      new RoutingPolicy<ProtocolEnvelope>({
        ...policyOptions,
        ...(configuredQueueCapacity === undefined
          ? { maxQueueEntries: this.limits.maxQueueEntries }
          : {}),
        monotonicNow: policyOptions.monotonicNow ?? this.monotonicNow,
      });
    this.taskStore =
      options.taskStore ??
      new TaskStore({
        ...(options.taskStoreOptions ?? {}),
        localOwnerRuntimeId: this.runtimeId,
        wallNow: options.taskStoreOptions?.wallNow ?? this.wallNow,
        monotonicNow: options.taskStoreOptions?.monotonicNow ?? this.monotonicNow,
        setTimeout:
          options.taskStoreOptions?.setTimeout ??
          ((callback, delayMs) =>
            this.setTimeoutFn(callback, delayMs) as ReturnType<typeof setTimeout>),
        clearTimeout: options.taskStoreOptions?.clearTimeout ?? this.clearTimeoutFn,
      });
    this.tasks = this.taskStore;
    this.dedupeStore =
      options.dedupeStore ??
      new RuntimeScopedDedupeStore<OperationResponse, RequestId>({
        runtimeId: this.runtimeId,
        now: this.wallNow,
        setTimeout: this.setTimeoutFn,
        clearTimeout: this.clearTimeoutFn,
      });
    this.dedupe = this.dedupeStore;
    this.agentCard = options.agentCard ?? options.card ?? this.createAgentCard(options);
  }

  public get isClosed(): boolean {
    return this.closed;
  }

  public get isStarted(): boolean {
    return !this.closed;
  }

  public get card(): AgentCard {
    return this.agentCard;
  }

  public get agent(): AgentCard {
    return this.agentCard;
  }

  public async start(): Promise<void> {
    this.ensureOpen();
  }

  public async bind(): Promise<void> {
    return this.start();
  }

  public async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    for (const pending of this.pending.values()) {
      pending.reject(new RouterError(createProtocolError('unreachable', 'router is closed')));
    }
    this.pending.clear();
    this.taskStore.dispose();
    this.dedupeStore.dispose();
  }

  public async shutdown(): Promise<void> {
    return this.close();
  }

  public async dispose(): Promise<void> {
    return this.close();
  }

  /** Process an inbound envelope after binding authentication and routing checks. */
  public async processInbound(raw: unknown, binding?: unknown): Promise<OperationResponse> {
    this.ensureOpen();
    const rawEnvelope = this.rawEnvelope(raw);
    const rawFields = isRecord(rawEnvelope) ? (rawEnvelope as RawEnvelopeFields) : {};
    const authenticationError = await this.authorizeInbound(rawFields, binding);
    if (authenticationError !== undefined) {
      return errorResponse(rawFields, authenticationError);
    }

    const validation =
      typeof raw === 'string'
        ? validateSerializedEnvelope(raw, { now: this.wallNow(), limits: this.limits })
        : validateEnvelope(rawEnvelope, { now: this.wallNow(), limits: this.limits });
    if (!validation.ok) {
      return errorResponse(rawFields, validation.error);
    }
    const envelope = validation.value;

    try {
      switch (envelope.operation) {
        case 'peer.describe':
          return this.processDescribe(envelope);
        case 'message.request':
          return this.processMessageRequest(envelope, binding);
        case 'message.reply':
          return this.processMessageReply(envelope, binding);
        case 'message.notify':
          return await this.processMessageNotify(envelope);
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
    } catch {
      return errorResponse(envelope, safeInternalError());
    }
  }

  public async process(raw: unknown, binding?: unknown): Promise<OperationResponse> {
    return this.processInbound(raw, binding);
  }

  public async route(raw: unknown, binding?: unknown): Promise<OperationResponse> {
    return this.processInbound(raw, binding);
  }

  /** Handle either a bare envelope or an adapter delivery with an ack callback. */
  public async handleEnvelope(
    input: RouterInboundEnvelope | unknown,
    binding?: unknown,
  ): Promise<OperationResponse> {
    if (isInboundDelivery(input)) {
      const response = await this.processInbound(input.envelope, input.binding ?? input.source);
      if (input.reply !== undefined) {
        await input.reply(response);
      }
      return response;
    }
    return this.processInbound(input, binding);
  }

  public async handleInbound(
    input: RouterInboundEnvelope | unknown,
    binding?: unknown,
  ): Promise<OperationResponse> {
    return this.handleEnvelope(input, binding);
  }

  /** Apply a response received from an outbound delivery seam. */
  public async processResponse(raw: unknown): Promise<void> {
    const operationId =
      isRecord(raw) && typeof raw.operationId === 'string' ? raw.operationId : undefined;
    const pending = operationId === undefined ? undefined : this.pending.get(operationId);
    const result = validateOperationResponse(raw, {
      now: this.wallNow(),
      limits: this.limits,
      ...(pending?.requestId === undefined ? {} : { expectedRequestId: pending.requestId }),
    });
    if (!result.ok) {
      pending?.reject(new RouterError(result.error));
      if (pending !== undefined && operationId !== undefined) {
        this.pending.delete(operationId);
      }
      return;
    }
    this.applyResponse(result.value);
  }

  public async handleInboundResponse(raw: unknown): Promise<void> {
    const response = isInboundResponse(raw) ? raw.response : raw;
    return this.processResponse(response);
  }

  /** Send an already validated/canonical protocol envelope through the seam. */
  public async sendEnvelope(envelope: ProtocolEnvelope): Promise<OutboundDeliveryResult> {
    this.ensureOpen();
    const validation = this.validateOutbound(envelope);
    if (!validation.ok) {
      return {
        delivered: false,
        error: validation.error,
      };
    }
    const result = await this.sendViaDelivery(validation.value);
    if (!isDelivered(result)) {
      this.reportUnreachable(envelope.operationId, result.error);
    }
    return result;
  }

  public async send(envelope: ProtocolEnvelope): Promise<OutboundDeliveryResult> {
    return this.sendEnvelope(envelope);
  }

  public async createRequest(input: RouterRequestInput): Promise<RouterRequestHandle> {
    this.ensureOpen();
    const envelope = this.buildRequestEnvelope(input);
    const record = this.registerOutboundRequest(envelope);
    const admission = this.sendAndWait(envelope, envelope.requestId);
    return Object.freeze({
      requestId: envelope.requestId,
      operationId: envelope.operationId,
      envelope,
      admission,
      completion: record.completion,
    });
  }

  public async sendRequest(
    input: RouterRequestInput | MessageRequestEnvelope,
  ): Promise<OperationResponse> {
    this.ensureOpen();
    const envelope = this.isMessageRequestEnvelope(input)
      ? input
      : this.buildRequestEnvelope(input);
    if (!this.outboundRequests.has(envelope.requestId)) {
      this.registerOutboundRequest(envelope);
    }
    return this.sendAndWait(envelope, envelope.requestId);
  }

  public async request(
    input: RouterRequestInput | MessageRequestEnvelope,
  ): Promise<OperationResponse> {
    return this.sendRequest(input);
  }

  public async describe(recipientRuntimeId: RuntimeId | string): Promise<OperationResponse> {
    const envelope = this.buildDescribeEnvelope(asRuntimeId(recipientRuntimeId));
    return this.sendAndWait(envelope);
  }

  public async peerDescribe(recipientRuntimeId: RuntimeId | string): Promise<OperationResponse> {
    return this.describe(recipientRuntimeId);
  }

  public async notify(
    input: RouterNotificationInput | Extract<ProtocolEnvelope, { operation: 'message.notify' }>,
  ): Promise<OperationResponse> {
    const envelope = this.isMessageNotifyEnvelope(input) ? input : this.buildNotifyEnvelope(input);
    return this.sendAndWait(envelope);
  }

  public async sendNotification(
    input: RouterNotificationInput | Extract<ProtocolEnvelope, { operation: 'message.notify' }>,
  ): Promise<OperationResponse> {
    return this.notify(input);
  }

  public async status(
    input: RouterOperationInput | TaskStatusEnvelope,
  ): Promise<OperationResponse> {
    const envelope = this.isTaskStatusEnvelope(input) ? input : this.buildStatusEnvelope(input);
    return this.sendAndWait(envelope, envelope.requestId);
  }

  public async sendStatus(
    input: RouterOperationInput | TaskStatusEnvelope,
  ): Promise<OperationResponse> {
    return this.status(input);
  }

  public async cancel(
    input: (RouterOperationInput & { readonly reason?: string }) | TaskCancelEnvelope,
  ): Promise<OperationResponse> {
    const envelope = this.isTaskCancelEnvelope(input) ? input : this.buildCancelEnvelope(input);
    return this.sendAndWait(envelope, envelope.requestId);
  }

  public async sendCancel(
    input: (RouterOperationInput & { readonly reason?: string }) | TaskCancelEnvelope,
  ): Promise<OperationResponse> {
    return this.cancel(input);
  }

  public completeTask(requestId: RequestId, content: Content): RouterTaskResult | undefined {
    const record = this.inboundRequests.get(requestId);
    if (record !== undefined && !this.validExpectedReply(content, record.expectedResponse)) {
      return undefined;
    }
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

  private rawEnvelope(raw: unknown): unknown {
    if (typeof raw === 'string') {
      return {};
    }
    return raw;
  }

  private async authorizeInbound(
    envelope: RawEnvelopeFields,
    binding: unknown,
  ): Promise<ProtocolError | undefined> {
    const sender = isRecord(envelope.sender) ? envelope.sender : undefined;
    const senderRuntimeId = typeof sender?.runtimeId === 'string' ? sender.runtimeId : undefined;
    const roomId = typeof envelope.roomId === 'string' ? envelope.roomId : undefined;
    const recipientRuntimeId =
      typeof envelope.recipientRuntimeId === 'string' ? envelope.recipientRuntimeId : undefined;
    const effectiveBinding = binding ?? this.defaultBinding;

    if (this.authenticator !== undefined) {
      let result: BindingAuthenticationResult;
      try {
        result = await this.authenticator.authenticate(envelope, effectiveBinding);
      } catch {
        return createProtocolError('unauthorized', 'binding authentication failed');
      }
      if (!result.authenticated) {
        return createProtocolError('unauthorized', 'binding authentication failed');
      }
      if (
        senderRuntimeId === undefined ||
        result.senderRuntimeId !== senderRuntimeId ||
        result.localRuntimeId !== this.runtimeId
      ) {
        return createProtocolError('unauthorized', 'binding sender does not match the envelope');
      }
      if (roomId !== undefined && result.roomId !== roomId) {
        return createProtocolError('cross_room', 'operation belongs to a different room');
      }
      if (result.roomId !== this.roomId) {
        return createProtocolError('cross_room', 'operation belongs to a different room');
      }
    } else {
      const claimedBindingRuntime = bindingRuntimeId(effectiveBinding);
      if (
        claimedBindingRuntime !== undefined &&
        senderRuntimeId !== undefined &&
        claimedBindingRuntime !== senderRuntimeId
      ) {
        return createProtocolError('unauthorized', 'binding sender does not match the envelope');
      }
      const partial = partialBinding(effectiveBinding);
      const localRuntime =
        typeof partial?.localRuntimeId === 'string' ? partial.localRuntimeId : undefined;
      if (localRuntime !== undefined && localRuntime !== this.runtimeId) {
        return createProtocolError('unauthorized', 'operation is addressed to another runtime');
      }
      const boundRoom =
        typeof partial?.localRoomId === 'string'
          ? partial.localRoomId
          : typeof partial?.roomId === 'string'
            ? partial.roomId
            : undefined;
      if (boundRoom !== undefined && boundRoom !== this.roomId) {
        return createProtocolError('cross_room', 'operation belongs to a different room');
      }
    }

    if (roomId !== undefined && roomId !== this.roomId) {
      return createProtocolError('cross_room', 'operation belongs to a different room');
    }
    if (recipientRuntimeId !== undefined && recipientRuntimeId !== this.runtimeId) {
      return createProtocolError('unauthorized', 'operation is addressed to another runtime');
    }
    return undefined;
  }

  private processDescribe(
    envelope: Extract<ProtocolEnvelope, { operation: 'peer.describe' }>,
  ): OperationResponse {
    return successResponse(
      envelope,
      createPeerDescribeResult(this.agentCard, {
        limits: this.limits,
        supportsCancellation: this.supportsCancellation,
        supportsNotifications: this.supportsNotifications,
      }),
    );
  }

  private processMessageRequest(
    envelope: MessageRequestEnvelope,
    binding: unknown,
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
    if (existing.kind === 'pending') {
      return errorResponse(
        envelope,
        createProtocolError('busy', 'operation admission is already in progress'),
      );
    }
    if (this.inboundRequests.size >= MAX_TRACKED_TASKS) {
      return errorResponse(
        envelope,
        createProtocolError('busy', 'task capacity is temporarily exhausted'),
      );
    }

    const requestId = envelope.requestId;
    const entry: RoutingQueueEntry<ProtocolEnvelope> = {
      id: requestId,
      requestId,
      value: envelope,
      expiresAt: envelope.expiresAt,
      state: this.policy.availableActiveCapacity > 0 ? 'accepted' : 'queued',
      isCancelled: () => {
        const snapshot = this.taskStore.getTask(requestId);
        return snapshot?.state === 'cancelled' || snapshot?.state === 'cancelling';
      },
    };
    const admission = this.admitRequest(entry);
    if (
      admission.state === 'busy' ||
      admission.state === 'expired' ||
      admission.state === 'cancelled'
    ) {
      return errorResponse(envelope, admission.error);
    }

    const reservation = this.dedupeStore.reserve(envelope);
    const reservationReplay = this.dedupeResponse(reservation);
    if (reservationReplay !== undefined) {
      this.releaseAdmission(admission);
      return reservationReplay;
    }
    if (reservation.reservation === undefined) {
      this.releaseAdmission(admission);
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
        requester: envelope.sender,
        localOwner: { runtimeId: this.runtimeId, sessionId: this.sessionId },
        expectedTargetRuntimeId: this.runtimeId,
        roomId: this.roomId,
        responseContract: envelope.payload.expectedResponse,
        ownership: 'inbound',
        createdAt: envelope.createdAt,
        expiresAt: envelope.expiresAt,
        initialState: admission.state === 'accepted' ? 'accepted' : 'queued',
      });
    } catch {
      this.dedupeStore.release(reservation.reservation);
      this.releaseAdmission(admission);
      return errorResponse(envelope, safeInternalError());
    }

    const response = successResponse(envelope, {
      requestId,
      state: snapshot.state as 'accepted' | 'queued',
    });
    this.dedupeStore.commit(reservation.reservation, response, requestId);
    const record: InboundRequestRecord = {
      envelope,
      binding,
      expectedResponse: envelope.payload.expectedResponse,
      ...(admission.state === 'accepted' ? { lease: admission.lease } : {}),
      terminalSent: false,
    };
    this.inboundRequests.set(requestId, record);
    this.scheduleExpiry(requestId, envelope.expiresAt);
    if (admission.state === 'accepted') {
      this.leases.set(requestId, admission.lease);
      this.dispatchLease(requestId, admission.lease);
    }
    return response;
  }

  private async processMessageNotify(
    envelope: Extract<ProtocolEnvelope, { operation: 'message.notify' }>,
  ): Promise<OperationResponse> {
    if (!this.supportsNotifications) {
      return errorResponse(
        envelope,
        createProtocolError('incompatible', 'notifications are unsupported'),
      );
    }
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
    if (existing.kind === 'pending') {
      return errorResponse(
        envelope,
        createProtocolError('busy', 'notification is already in progress'),
      );
    }
    const reservation = this.dedupeStore.reserve(envelope);
    if (reservation.reservation === undefined) {
      return errorResponse(
        envelope,
        reservation.error ??
          createProtocolError('busy', 'notification delivery is temporarily busy'),
      );
    }
    let error: ProtocolError | undefined;
    try {
      await this.onNotification?.({ envelope, sender: envelope.sender });
    } catch {
      error = safeInternalError();
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
    binding: unknown,
  ): OperationResponse {
    const taskMetadata = this.taskStore.getRecordMetadata(envelope.requestId);
    const outbound = this.outboundRequests.get(envelope.requestId);
    if (taskMetadata === undefined || taskMetadata.ownership !== 'outbound') {
      return errorResponse(
        envelope,
        createProtocolError('unauthorized', 'reply is not authorized'),
      );
    }
    const expectedTargetRuntimeId =
      taskMetadata.expectedTargetRuntimeId ?? outbound?.expectedTargetRuntimeId;
    if (
      expectedTargetRuntimeId === undefined ||
      expectedTargetRuntimeId !== envelope.sender.runtimeId ||
      (bindingRuntimeId(binding) !== undefined &&
        bindingRuntimeId(binding) !== envelope.sender.runtimeId)
    ) {
      return errorResponse(
        envelope,
        createProtocolError('unauthorized', 'reply sender is not authorized'),
      );
    }
    if (
      taskMetadata.localOwner.runtimeId !== this.runtimeId ||
      taskMetadata.requester.runtimeId !== this.runtimeId
    ) {
      return errorResponse(
        envelope,
        createProtocolError('unauthorized', 'reply request owner is not authorized'),
      );
    }

    const requestExpiry = outbound?.envelope.expiresAt ?? taskMetadata.snapshot.expiresAt;
    const replyExpiry = Date.parse(envelope.expiresAt);
    if (replyExpiry > Date.parse(requestExpiry)) {
      return errorResponse(
        envelope,
        createProtocolError('malformed', 'reply deadline exceeds request deadline'),
      );
    }
    if (envelope.payload.outcome === 'completed' && taskMetadata.responseContract !== undefined) {
      const contentValidation = validateReplyContent(
        envelope.payload.content,
        taskMetadata.responseContract,
        {
          now: this.wallNow(),
        },
      );
      if (!contentValidation.ok) {
        return errorResponse(envelope, contentValidation.error);
      }
    }

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
    if (existing.kind === 'pending') {
      return errorResponse(
        envelope,
        createProtocolError('busy', 'reply delivery is already in progress'),
      );
    }
    const reservation = this.dedupeStore.reserve(envelope);
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
    if (isTerminalTaskState(current.state)) {
      this.dedupeStore.release(reservation.reservation);
      return errorResponse(
        envelope,
        createProtocolError(
          current.state === 'cancelled' ? 'cancelled' : 'not_cancelable',
          'logical request is already terminal',
        ),
      );
    }

    if (current.state === 'created') {
      this.taskStore.transition(envelope.requestId, 'accepted');
      current = this.taskStore.getTask(envelope.requestId) ?? current;
    }
    if (current.state === 'accepted' || current.state === 'queued') {
      this.taskStore.transition(envelope.requestId, 'working');
    }

    const payload = envelope.payload;
    let snapshot: TaskSnapshot | undefined;
    if (payload.outcome === 'completed') {
      snapshot = this.taskStore.completeTask(envelope.requestId, payload.content);
    } else if (payload.outcome === 'failed') {
      snapshot = this.taskStore.failTask(envelope.requestId, payload.error);
    } else if (payload.outcome === 'rejected') {
      snapshot = this.taskStore.rejectTask(envelope.requestId, payload.error);
    } else if (payload.outcome === 'cancelled') {
      const state = this.taskStore.getTask(envelope.requestId)?.state;
      if (state === 'working') {
        this.taskStore.transition(envelope.requestId, 'cancelling', {
          cancellationRequested: true,
        });
      }
      snapshot = this.taskStore.transition(envelope.requestId, 'cancelled', {
        cancellationRequested: true,
        error: payload.error ?? createProtocolError('cancelled', 'request was cancelled'),
      });
    } else {
      snapshot = this.taskStore.expireTask(envelope.requestId);
    }

    if (snapshot === undefined || !isTerminalSnapshot(snapshot)) {
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
    const record = this.taskStore.getRecordMetadata(envelope.requestId);
    if (record === undefined) {
      return errorResponse(
        envelope,
        createProtocolError('not_found', 'logical request was not found'),
      );
    }
    const result = this.taskStore.getStatusResult(envelope.requestId, {
      caller: envelope.sender,
      includeTerminalResponse: envelope.payload.includeTerminalResponse ?? true,
    });
    if (!result.ok) {
      return errorResponse(
        envelope,
        createProtocolError('unauthorized', 'task status is not available'),
      );
    }
    return successResponse(envelope, { snapshot: result.snapshot });
  }

  private processTaskCancel(
    envelope: Extract<ProtocolEnvelope, { operation: 'task.cancel' }>,
  ): OperationResponse {
    if (!this.supportsCancellation) {
      return errorResponse(
        envelope,
        createProtocolError('incompatible', 'cancellation is unsupported'),
      );
    }
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
    if (existing.kind === 'pending') {
      return errorResponse(
        envelope,
        createProtocolError('busy', 'cancellation is already in progress'),
      );
    }
    const reservation = this.dedupeStore.reserve(envelope);
    if (reservation.reservation === undefined) {
      return errorResponse(
        envelope,
        reservation.error ?? createProtocolError('busy', 'cancellation is temporarily busy'),
      );
    }
    const result = this.taskStore.cancelTask(envelope.requestId, {
      caller: envelope.sender,
      reason: envelope.payload.reason,
    });
    if (!result.ok) {
      this.dedupeStore.release(reservation.reservation);
      const errorCode = result.code === 'unauthorized' ? 'unauthorized' : result.code;
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
    if (this.requestExecutor === undefined) {
      return;
    }
    const task = this.taskStore.beginExecution(requestId);
    if (task === undefined) {
      this.releaseLease(requestId, lease);
      return;
    }
    const requestRecord = this.inboundRequests.get(requestId);
    if (requestRecord === undefined) {
      this.releaseLease(requestId, lease);
      return;
    }

    void Promise.resolve()
      .then(() =>
        this.requestExecutor?.({
          request: lease.value as MessageRequestEnvelope,
          requestId,
          snapshot: task.snapshot,
          signal: task.signal,
          complete: (content) => this.completeTask(requestId, content)?.snapshot,
          fail: (error) => this.failTask(requestId, error)?.snapshot,
          reject: (error) => this.rejectTask(requestId, error)?.snapshot,
        }),
      )
      .then((result) => this.applyExecutorResult(requestId, result))
      .catch(() => this.handleExecutorFailure(requestId));
  }

  private applyExecutorResult(requestId: RequestId, result: RouterRequestExecutorResult): void {
    const current = this.taskStore.getTask(requestId, { includeTerminalResponse: true });
    if (current === undefined || isTerminalTaskState(current.state)) {
      if (current !== undefined) {
        this.finishTask(requestId, current);
      }
      return;
    }
    const update = taskUpdateForExecutorResult(result);
    if (update.content !== undefined) {
      this.completeTask(requestId, update.content);
    } else if (update.error !== undefined) {
      if (isRecord(result) && result.outcome === 'rejected') {
        this.rejectTask(requestId, update.error);
      } else {
        this.failTask(requestId, update.error);
      }
    }
  }

  private handleExecutorFailure(requestId: RequestId): void {
    const current = this.taskStore.getTask(requestId, { includeTerminalResponse: true });
    if (current === undefined || isTerminalTaskState(current.state)) {
      if (current !== undefined) {
        this.finishTask(requestId, current);
      }
      return;
    }
    if (current.state === 'cancelling') {
      this.finishTask(
        requestId,
        this.taskStore.transition(requestId, 'cancelled', {
          cancellationRequested: true,
          error: createProtocolError('cancelled', 'request executor acknowledged cancellation'),
        }),
      );
      return;
    }
    this.failTask(requestId, safeInternalError());
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
    this.clearExpiry(requestId);
    const lease = this.leases.get(requestId);
    if (lease !== undefined) {
      this.releaseLease(requestId, lease);
    } else {
      this.policy.cancelByRequestId(requestId);
      this.drainQueue();
    }
    const record = this.inboundRequests.get(requestId);
    if (record !== undefined && !record.terminalSent) {
      record.terminalSent = true;
      void this.sendTerminalReply(record, snapshot);
    }
    this.finishOutboundRequest(requestId, snapshot);
    return { snapshot };
  }

  private releaseLease(requestId: RequestId, lease: QueueLease<ProtocolEnvelope>): void {
    this.policy.release(lease);
    this.leases.delete(requestId);
    this.drainQueue();
  }

  private drainQueue(): void {
    while (this.policy.availableActiveCapacity > 0) {
      const lease = this.policy.dequeue();
      if (lease === undefined) {
        return;
      }
      const requestId = lease.requestId as RequestId | undefined;
      if (requestId === undefined || !this.inboundRequests.has(requestId)) {
        this.policy.release(lease);
        continue;
      }
      this.leases.set(requestId, lease);
      this.dispatchLease(requestId, lease);
    }
  }

  private async sendTerminalReply(
    record: InboundRequestRecord,
    snapshot: TaskSnapshot,
  ): Promise<void> {
    if (!isTerminalTaskState(snapshot.state)) {
      return;
    }
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
    const now = this.wallNow();
    const expiryMs = Date.parse(record.envelope.expiresAt);
    const createdMs = Math.min(now, expiryMs - 1);
    if (!Number.isFinite(createdMs) || expiryMs <= now) {
      this.inboundRequests.delete(record.envelope.requestId);
      return;
    }
    const reply: ProtocolEnvelope = {
      protocolVersion: PROTOCOL_VERSION,
      operation: 'message.reply',
      operationId: asUuidV4(randomUUID()),
      requestId: record.envelope.requestId,
      sender: identitySender(this.identity),
      recipientRuntimeId: record.envelope.sender.runtimeId,
      roomId: this.roomId,
      createdAt: wallTimestamp(createdMs),
      expiresAt: record.envelope.expiresAt,
      traceId: record.envelope.traceId,
      parentOperationId: record.envelope.operationId,
      payload,
    } as ProtocolEnvelope;
    const result = await this.sendViaDelivery(reply);
    if (!isDelivered(result)) {
      this.reportUnreachable(reply.operationId, result.error);
    }
    this.inboundRequests.delete(record.envelope.requestId);
  }

  private scheduleExpiry(requestId: RequestId, expiresAt: UtcTimestamp): void {
    if (this.expiryTimers.has(requestId)) {
      return;
    }
    const delay = Math.max(0, Date.parse(expiresAt) - this.wallNow());
    const timer = this.setTimeoutFn(
      () => {
        this.expiryTimers.delete(requestId);
        const current = this.taskStore.getTask(requestId, { includeTerminalResponse: true });
        if (current !== undefined && !isTerminalTaskState(current.state)) {
          this.finishTask(requestId, this.taskStore.expireTask(requestId));
        }
      },
      Math.min(delay, MAX_TIMER_DELAY_MS),
    );
    this.expiryTimers.set(requestId, timer);
  }

  private clearExpiry(requestId: RequestId): void {
    const timer = this.expiryTimers.get(requestId);
    if (timer !== undefined) {
      this.clearTimeoutFn(timer);
      this.expiryTimers.delete(requestId);
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
    if (envelope.roomId !== this.roomId) {
      return {
        ok: false,
        error: createProtocolError('cross_room', 'operation belongs to a different room'),
      };
    }
    if (envelope.sender.runtimeId !== this.runtimeId) {
      return {
        ok: false,
        error: createProtocolError('unauthorized', 'operation sender is not the local runtime'),
      };
    }
    const requestExpiry =
      envelope.operation === 'message.reply'
        ? this.taskStore.getRecordMetadata(envelope.requestId)?.snapshot.expiresAt
        : undefined;
    if (requestExpiry !== undefined && Date.parse(envelope.expiresAt) > Date.parse(requestExpiry)) {
      return {
        ok: false,
        error: createProtocolError('malformed', 'reply deadline exceeds request deadline'),
      };
    }
    return validateEnvelope(envelope, { now: this.wallNow(), limits: this.limits });
  }

  private async sendAndWait(
    envelope: ProtocolEnvelope,
    requestId?: RequestId,
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
    const delivery = await this.sendEnvelope(envelope);
    if (!isDelivered(delivery)) {
      this.pending.delete(operationId);
      throw new RouterError(delivery.error);
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
    if (response.operation === 'message.request' && pending.requestId !== undefined) {
      const record = this.outboundRequests.get(pending.requestId);
      if (record !== undefined && response.result.requestId === pending.requestId) {
        if (response.result.state === 'queued') {
          this.taskStore.transition(pending.requestId, 'accepted');
          this.taskStore.transition(pending.requestId, 'queued');
        } else {
          this.taskStore.transition(pending.requestId, 'accepted');
        }
        record.admissionResolved = true;
      }
    }
    pending.resolve(response);
  }

  private registerOutboundRequest(envelope: MessageRequestEnvelope): OutboundRequestRecord {
    if (this.outboundRequests.size >= MAX_TRACKED_TASKS) {
      throw new RouterError(
        createProtocolError('busy', 'router request capacity is temporarily exhausted'),
      );
    }
    const validation = this.validateOutbound(envelope);
    if (!validation.ok) {
      throw new RouterError(validation.error);
    }
    const requestId = envelope.requestId;
    this.taskStore.createTask({
      requestId,
      operationId: envelope.operationId,
      requester: identitySender(this.identity),
      localOwner: identitySender(this.identity),
      expectedTargetRuntimeId: envelope.recipientRuntimeId,
      roomId: envelope.roomId,
      responseContract: envelope.payload.expectedResponse,
      ownership: 'outbound',
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
    const record: OutboundRequestRecord = {
      envelope,
      expectedTargetRuntimeId: envelope.recipientRuntimeId,
      ...(envelope.payload.expectedResponse === undefined
        ? {}
        : { expectedResponse: envelope.payload.expectedResponse }),
      completion,
      resolveCompletion,
      rejectCompletion,
      admissionResolved: false,
    };
    this.outboundRequests.set(requestId, record);
    return record;
  }

  private finishOutboundRequest(requestId: RequestId, snapshot: TaskSnapshot): void {
    const record = this.outboundRequests.get(requestId);
    if (
      record === undefined ||
      !isTerminalSnapshot(snapshot) ||
      record.terminalSnapshot !== undefined
    ) {
      return;
    }
    record.terminalSnapshot = snapshot;
    record.resolveCompletion(snapshot);
  }

  private buildRequestEnvelope(input: RouterRequestInput): MessageRequestEnvelope {
    const operationId = asUuidV4(randomUUID());
    const now = this.wallNow();
    const envelope = {
      protocolVersion: PROTOCOL_VERSION,
      operation: 'message.request',
      operationId,
      requestId: operationId,
      sender: identitySender(this.identity),
      recipientRuntimeId: asRuntimeId(String(input.recipientRuntimeId)),
      roomId: this.roomId,
      createdAt: wallTimestamp(now),
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
    } as unknown as MessageRequestEnvelope;
    const validation = validateEnvelope(envelope, { now, limits: this.limits });
    if (!validation.ok) {
      throw new RouterError(validation.error);
    }
    return validation.value as MessageRequestEnvelope;
  }

  private buildDescribeEnvelope(
    recipientRuntimeId: RuntimeId,
  ): Extract<ProtocolEnvelope, { operation: 'peer.describe' }> {
    const now = this.wallNow();
    const envelope = {
      protocolVersion: PROTOCOL_VERSION,
      operation: 'peer.describe',
      operationId: asUuidV4(randomUUID()),
      sender: identitySender(this.identity),
      recipientRuntimeId,
      roomId: this.roomId,
      createdAt: wallTimestamp(now),
      expiresAt: deadlineValue(undefined, now, this.limits.maxControlTtlMs),
      traceId: traceValue(undefined),
      payload: {},
    } as unknown as Extract<ProtocolEnvelope, { operation: 'peer.describe' }>;
    const validation = validateEnvelope(envelope, { now, limits: this.limits });
    if (!validation.ok) {
      throw new RouterError(validation.error);
    }
    return validation.value as Extract<ProtocolEnvelope, { operation: 'peer.describe' }>;
  }

  private buildNotifyEnvelope(
    input: RouterNotificationInput,
  ): Extract<ProtocolEnvelope, { operation: 'message.notify' }> {
    const now = this.wallNow();
    const envelope = {
      protocolVersion: PROTOCOL_VERSION,
      operation: 'message.notify',
      operationId: asUuidV4(randomUUID()),
      sender: identitySender(this.identity),
      recipientRuntimeId: asRuntimeId(String(input.recipientRuntimeId)),
      roomId: this.roomId,
      createdAt: wallTimestamp(now),
      expiresAt: deadlineValue(input.expiresAt, now, this.limits.maxRequestTtlMs),
      traceId: traceValue(input.traceId),
      payload: {
        content: input.content,
        ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
      },
    } as unknown as Extract<ProtocolEnvelope, { operation: 'message.notify' }>;
    const validation = validateEnvelope(envelope, { now, limits: this.limits });
    if (!validation.ok) {
      throw new RouterError(validation.error);
    }
    return validation.value as Extract<ProtocolEnvelope, { operation: 'message.notify' }>;
  }

  private buildStatusEnvelope(input: RouterOperationInput): TaskStatusEnvelope {
    return this.buildControlEnvelope('task.status', input, {
      ...(input.parentOperationId === undefined
        ? {}
        : { parentOperationId: input.parentOperationId }),
    }) as TaskStatusEnvelope;
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
    payload: JsonObject,
  ): ProtocolEnvelope {
    const now = this.wallNow();
    const envelope = {
      protocolVersion: PROTOCOL_VERSION,
      operation,
      operationId: asUuidV4(randomUUID()),
      requestId: asUuidV4(String(input.requestId)),
      sender: identitySender(this.identity),
      recipientRuntimeId: asRuntimeId(String(input.recipientRuntimeId)),
      roomId: this.roomId,
      createdAt: wallTimestamp(now),
      expiresAt: deadlineValue(input.expiresAt, now, this.limits.maxControlTtlMs),
      traceId: traceValue(input.traceId),
      ...(input.parentOperationId === undefined
        ? {}
        : { parentOperationId: input.parentOperationId }),
      payload,
    } as unknown as ProtocolEnvelope;
    const validation = validateEnvelope(envelope, { now, limits: this.limits });
    if (!validation.ok) {
      throw new RouterError(validation.error);
    }
    return validation.value;
  }

  private createAgentCard(options: RouterOptions): AgentCard {
    const now = this.wallNow();
    return Object.freeze({
      protocolVersion: 1,
      sessionId: this.sessionId,
      runtimeInstanceId: this.identity.runtimeId,
      displayName: options.displayName ?? options.name ?? 'pi-to-pi-runtime',
      roomId: this.roomId,
      purpose: options.description ?? null,
      workingDirectoryLabel: null,
      roleTags: [],
      model: null,
      capabilities: {
        structuredReplies: true,
        cancellation: this.supportsCancellation,
        statusUpdates: true,
        maxMessageSize: this.limits.maxEnvelopeBytes,
        supportedContentTypes: ['text', 'json'],
      },
      state: 'idle',
      contextUsage: null,
      inboundQueueDepth: this.policy.queuedCount,
      endpoint: {
        kind: 'unix' as const,
        address: 'in-memory',
        runtimeInstanceId: this.identity.runtimeId,
      },
      runtimeStartedAt: wallTimestamp(now),
      leaseExpiresAt: wallTimestamp(now + DEFAULT_LEASE_TTL_MS),
    });
  }

  private validExpectedReply(
    content: Content,
    expectedResponse: ExpectedResponse | undefined,
  ): boolean {
    if (expectedResponse === undefined) {
      return true;
    }
    return validateReplyContent(content, expectedResponse, { now: this.wallNow() }).ok;
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

  private async sendViaDelivery(envelope: ProtocolEnvelope): Promise<OutboundDeliveryResult> {
    if (this.delivery === undefined) {
      return deliveryFailure('no outbound delivery seam is configured');
    }
    try {
      const delivery = this.delivery;
      if (typeof delivery === 'function') {
        return await delivery(envelope);
      }
      if (typeof delivery.send === 'function') {
        return await delivery.send(envelope);
      }
      const compatibleDelivery = delivery as RouterEnvelopeDelivery;
      if (typeof compatibleDelivery.sendEnvelope === 'function') {
        return await compatibleDelivery.sendEnvelope(envelope);
      }
      return deliveryFailure('outbound delivery seam is not configured');
    } catch (error) {
      return deliveryFailure(error);
    }
  }

  private reportUnreachable(operationId: OperationId, error: unknown): void {
    const protocolError =
      isRecord(error) && isProtocolError(error)
        ? error
        : createProtocolError(
            'unreachable',
            error instanceof Error ? error.message : 'delivery could not be established',
          );
    this.onUnreachable?.(operationId, protocolError);
  }

  private ensureOpen(): void {
    if (this.closed) {
      throw new RouterError(createProtocolError('unreachable', 'router is closed'));
    }
  }
}

function isInboundDelivery(value: unknown): value is RouterInboundEnvelope {
  return isRecord(value) && 'envelope' in value;
}

function isInboundResponse(value: unknown): value is { readonly response: unknown } {
  return isRecord(value) && 'response' in value;
}

function isProtocolError(value: unknown): value is ProtocolError {
  return (
    isRecord(value) &&
    typeof value.code === 'string' &&
    typeof value.message === 'string' &&
    typeof value.retryable === 'boolean'
  );
}

/** Compatibility aliases for consumers that use the shorter router name. */
export const Router = MessageRouter;
export const OperationRouter = MessageRouter;
export const createRouter = (options: RouterOptions): MessageRouter => new MessageRouter(options);
export const createMessageRouter = createRouter;
