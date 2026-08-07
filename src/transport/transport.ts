/**
 * Transport-independent boundary for Pi-to-Pi protocol delivery.
 *
 * The adapter receives already-typed protocol values. It does not own the wire
 * representation, serialization, framing, routing, authentication, or protocol
 * validation. An endpoint is intentionally opaque to the protocol; adapters may
 * specialize it for their own addressing scheme.
 */

/** An adapter-specific address. Its contents have no protocol meaning. */
export type TransportEndpoint = string;

/** Runtime identity used to distinguish one live routing endpoint from another. */
export type TransportRuntimeId = string;

/** The runtime and endpoint selected by discovery or another caller. */
export interface TransportRuntimeTarget<Endpoint = TransportEndpoint> {
  readonly runtimeId: TransportRuntimeId;
  readonly endpoint: Endpoint;
}

/**
 * The protocol fields that a transport must carry unchanged.
 *
 * Operation-specific request-id rules and payload validation belong to the
 * protocol layer, not to this contract.
 */
export interface TransportEnvelope<Payload = unknown> {
  readonly protocolVersion: string;
  readonly operation: string;
  readonly operationId: string;
  readonly requestId?: string;
  readonly sender: {
    readonly sessionId: string;
    readonly runtimeId: TransportRuntimeId;
  };
  readonly recipientRuntimeId: TransportRuntimeId;
  readonly roomId: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly traceId: string;
  readonly parentOperationId?: string;
  readonly payload: Payload;
}

/** A protocol-level error carried in an operation response. */
export interface TransportOperationError {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
  readonly details?: Readonly<Record<string, unknown>>;
  readonly retryAfterMs?: number;
}

/**
 * A correlated protocol response. The discriminated union prevents an adapter
 * implementation from constructing a response that contains both result and
 * error (or neither).
 */
export type TransportOperationResponse<Result = unknown, Error = TransportOperationError> =
  | {
      readonly operationId: string;
      readonly result: Result;
      readonly error?: never;
    }
  | {
      readonly operationId: string;
      readonly result?: never;
      readonly error: Error;
    };

/** Errors raised by the delivery boundary rather than by the protocol. */
export type TransportDeliveryErrorCode =
  'ambiguous' | 'closed' | 'invalid_target' | 'timeout' | 'unreachable';

export interface TransportDeliveryError<Endpoint = TransportEndpoint> {
  readonly code: TransportDeliveryErrorCode;
  readonly message: string;
  readonly retryable: boolean;
  readonly target?: TransportRuntimeTarget<Endpoint>;
  readonly operationId?: string;
  readonly retryAfterMs?: number;
  readonly cause?: unknown;
}

export interface TransportDeliverySuccess {
  readonly status: 'delivered';
  readonly operationId?: string;
}

export interface TransportDeliveryFailure<Endpoint = TransportEndpoint> {
  readonly status: 'failed';
  readonly operationId?: string;
  readonly error: TransportDeliveryError<Endpoint>;
}

/** A delivery result never implies model completion or task terminality. */
export type TransportDeliveryResult<Endpoint = TransportEndpoint> =
  TransportDeliverySuccess | TransportDeliveryFailure<Endpoint>;

export type TransportAwaitable<Value> = Value | PromiseLike<Value>;

/**
 * An inbound envelope and the response path for its operation acknowledgment.
 * The response path is scoped to this delivery and does not expose a wire
 * connection or framing primitive.
 */
export interface TransportInboundEnvelope<
  Envelope extends TransportEnvelope = TransportEnvelope,
  Response extends TransportOperationResponse = TransportOperationResponse,
  Endpoint = TransportEndpoint,
> {
  readonly envelope: Envelope;
  readonly source: TransportRuntimeTarget<Endpoint>;
  readonly reply: (response: Response) => Promise<TransportDeliveryResult<Endpoint>>;
}

/** An inbound operation response awaiting router-side correlation. */
export interface TransportInboundResponse<
  Response extends TransportOperationResponse = TransportOperationResponse,
  Endpoint = TransportEndpoint,
> {
  readonly response: Response;
  readonly source: TransportRuntimeTarget<Endpoint>;
}

/** Hooks used by a router to receive protocol envelopes and responses. */
export interface TransportInboundHooks<
  Envelope extends TransportEnvelope = TransportEnvelope,
  Response extends TransportOperationResponse = TransportOperationResponse,
  Endpoint = TransportEndpoint,
> {
  readonly onEnvelope: (
    delivery: TransportInboundEnvelope<Envelope, Response, Endpoint>,
  ) => TransportAwaitable<void>;
  readonly onResponse: (
    delivery: TransportInboundResponse<Response, Endpoint>,
  ) => TransportAwaitable<void>;
}

/** A bound runtime endpoint. Closing a binding unregisters its inbound hooks. */
export interface TransportBinding<Endpoint = TransportEndpoint> {
  readonly target: TransportRuntimeTarget<Endpoint>;
  close(): Promise<void>;
}

/**
 * Adapter contract shared by local and future transports.
 *
 * `close` and binding `close` are idempotent. After closure, new sends or
 * bindings fail with a `closed` delivery error, and in-flight sends settle
 * rather than being silently discarded. The contract intentionally says
 * nothing about how values reach the target.
 */
export interface TransportAdapter<
  Envelope extends TransportEnvelope = TransportEnvelope,
  Response extends TransportOperationResponse = TransportOperationResponse,
  Endpoint = TransportEndpoint,
> {
  bind(
    target: TransportRuntimeTarget<Endpoint>,
    hooks: TransportInboundHooks<Envelope, Response, Endpoint>,
  ): Promise<TransportBinding<Endpoint>>;

  sendEnvelope(
    target: TransportRuntimeTarget<Endpoint>,
    envelope: Envelope,
  ): Promise<TransportDeliveryResult<Endpoint>>;

  sendResponse(
    target: TransportRuntimeTarget<Endpoint>,
    response: Response,
  ): Promise<TransportDeliveryResult<Endpoint>>;

  close(): Promise<void>;
}
