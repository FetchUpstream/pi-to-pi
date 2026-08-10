/**
 * The transport-independent v1 protocol data model.
 *
 * Validation of these values belongs to `validation.ts`.  The branded string
 * types keep identifiers and wire timestamps distinct at compile time without
 * making a transport or a particular UUID implementation part of this layer.
 */

import type { AgentCard, AgentCapabilities } from './agent-card.js';
import type { ProtocolError } from './errors.js';
import type { TaskSnapshot, TaskState, TerminalOutcome } from './task-state.js';

declare const uuidV4Brand: unique symbol;
declare const utcTimestampBrand: unique symbol;
declare const traceIdBrand: unique symbol;
declare const sessionIdBrand: unique symbol;
declare const runtimeIdBrand: unique symbol;
declare const roomIdBrand: unique symbol;
declare const messageRequestEnvelopeBrand: unique symbol;

/** A UUID version 4 value as it appears on the wire. */
export type UUIDv4 = string & {
  readonly [uuidV4Brand]: 'UUIDv4';
};

/** Canonical camel-case spelling for UUIDv4. */
export type UuidV4 = UUIDv4;

/** Operation and logical request identifiers are both UUIDv4 values. */
export type OperationId = UUIDv4;
export type RequestId = UUIDv4;

/** An RFC 3339 timestamp normalized to UTC (the wire value ends in `Z`). */
export type UtcTimestamp = string & {
  readonly [utcTimestampBrand]: 'UtcTimestamp';
};
export type UTCimestamp = UtcTimestamp;
export type Timestamp = UtcTimestamp;

/** Stable 16-byte trace identifier encoded as 32 lowercase hexadecimal chars. */
export type TraceId = string & {
  readonly [traceIdBrand]: 'TraceId';
};

/** Runtime identity values are intentionally distinct from operation IDs. */
export type SessionId = string & {
  readonly [sessionIdBrand]: 'SessionId';
};
export type RuntimeId = string & {
  readonly [runtimeIdBrand]: 'RuntimeId';
};
export type RoomId = string & {
  readonly [roomIdBrand]: 'RoomId';
};

/** v1 is deliberately exact; future minor versions are separate contracts. */
export const PROTOCOL_VERSION = '1.0' as const;
export type ProtocolVersion = typeof PROTOCOL_VERSION;

export const OPERATION_NAMES = [
  'peer.describe',
  'message.request',
  'message.reply',
  'message.notify',
  'task.status',
  'task.cancel',
] as const;

export type OperationName = (typeof OPERATION_NAMES)[number];
export type ProtocolOperation = OperationName;

export interface SenderIdentity {
  readonly sessionId: SessionId;
  readonly runtimeId: RuntimeId;
}

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | readonly JsonValue[];
export interface JsonObject {
  readonly [key: string]: JsonValue;
}

/** Draft 2020-12 permits a schema to be either an object or a boolean. */
export type JsonSchema = JsonObject | boolean;
export const JSON_SCHEMA_DRAFT_2020_12 = 'https://json-schema.org/draft/2020-12/schema' as const;

/** One operation exposed by a peer's wire capability projection. */
export interface OperationCapability {
  readonly operation: OperationName;
  readonly description?: string;
}

/** A typed content form supported by a peer. */
export interface ContentCapability {
  readonly type: ContentType;
  readonly supportsSchema?: boolean;
}

/** Effective bounded protocol policy advertised by a peer. */
export interface ProtocolLimits {
  readonly requestTtlMs: number;
  readonly maxRequestTtlMs: number;
  readonly maxControlTtlMs: number;
  readonly maxEnvelopeBytes: number;
  readonly maxSchemaBytes: number;
  readonly maxQueueEntries: number;
}

/** Capability projection for peer.describe; distinct from discovery Agent Card versioning. */
export interface ProtocolCapabilities {
  readonly supportedWireVersions: readonly ProtocolVersion[];
  readonly operations: readonly OperationCapability[];
  readonly contentCapabilities: readonly ContentCapability[];
  readonly supportsStructuredResponses: boolean;
  readonly supportsCancellation: boolean;
  readonly supportsNotifications: boolean;
  readonly limits: ProtocolLimits;
}

export type V1ProtocolCapabilities = ProtocolCapabilities;
export interface TextContent {
  readonly type: 'text';
  readonly text: string;
}

export interface JsonContent {
  readonly type: 'json';
  readonly value: JsonValue;
}

export type TypedContent = TextContent | JsonContent;
export type Content = TypedContent;
export type ContentType = Content['type'];

export interface ExpectedResponse {
  readonly contentType: 'json';
  readonly schema: JsonSchema;
}
export type ExpectedResponseMetadata = ExpectedResponse;

export interface PeerDescribePayload {
  /** Optional negotiation hint; an empty object is the normal v1 payload. */
  readonly requestedProtocolVersion?: ProtocolVersion;
}

export interface MessageRequestPayload {
  readonly content: Content;
  readonly expectedResponse?: ExpectedResponse;
  readonly metadata?: JsonObject;
}

export interface MessageNotifyPayload {
  readonly content: Content;
  readonly metadata?: JsonObject;
}

export interface CompletedReplyPayload {
  readonly outcome: 'completed';
  readonly content: Content;
}

export interface FailedReplyPayload {
  readonly outcome: 'failed';
  readonly error: ProtocolError;
}

export interface RejectedReplyPayload {
  readonly outcome: 'rejected';
  readonly error: ProtocolError;
}

export interface CancelledReplyPayload {
  readonly outcome: 'cancelled';
  readonly error?: ProtocolError;
}

export interface ExpiredReplyPayload {
  readonly outcome: 'expired';
  readonly error?: ProtocolError;
}

export type MessageReplyPayload =
  | CompletedReplyPayload
  | FailedReplyPayload
  | RejectedReplyPayload
  | CancelledReplyPayload
  | ExpiredReplyPayload;

export type ReplyPayload = MessageReplyPayload;

export interface TaskStatusPayload {
  readonly includeTerminalResponse?: boolean;
}

export interface TaskCancelPayload {
  readonly reason?: string;
}

export interface OperationPayloadMap {
  readonly 'peer.describe': PeerDescribePayload;
  readonly 'message.request': MessageRequestPayload;
  readonly 'message.reply': MessageReplyPayload;
  readonly 'message.notify': MessageNotifyPayload;
  readonly 'task.status': TaskStatusPayload;
  readonly 'task.cancel': TaskCancelPayload;
}

export type PayloadForOperation<O extends OperationName> = OperationPayloadMap[O];
export type OperationPayload = OperationPayloadMap[OperationName];
export type ProtocolPayload = OperationPayload;

export interface ProtocolEnvelopeBase<O extends OperationName, P extends PayloadForOperation<O>> {
  readonly protocolVersion: ProtocolVersion;
  readonly operation: O;
  readonly operationId: OperationId;
  readonly sender: SenderIdentity;
  readonly recipientRuntimeId: RuntimeId;
  readonly roomId: RoomId;
  readonly createdAt: UtcTimestamp;
  readonly expiresAt: UtcTimestamp;
  readonly traceId: TraceId;
  readonly parentOperationId?: OperationId;
  readonly payload: P;
}

export type PeerDescribeEnvelope = ProtocolEnvelopeBase<'peer.describe', PeerDescribePayload> & {
  readonly requestId?: never;
};

type MessageRequestEnvelopeFields<Id extends UUIDv4> = ProtocolEnvelopeBase<
  'message.request',
  MessageRequestPayload
> & {
  readonly operationId: Id;
  readonly requestId: Id;
};

/**
 * A constructed initial request envelope. The nominal marker prevents an
 * arbitrary pair of UUIDv4 values from being treated as correlated; callers
 * must use the factory or the correlation validator below.
 */
export type MessageRequestEnvelope<Id extends UUIDv4 = UUIDv4> =
  MessageRequestEnvelopeFields<Id> & {
    readonly [messageRequestEnvelopeBrand]: Id;
  };

/** Fields accepted by the factory; requestId is derived from operationId. */
export type MessageRequestEnvelopeInput<Id extends UUIDv4 = UUIDv4> = Omit<
  MessageRequestEnvelopeFields<Id>,
  'requestId'
>;

/** An unbranded candidate used after the rest of an envelope is validated. */
export type MessageRequestEnvelopeCandidate = MessageRequestEnvelopeFields<UUIDv4>;

/**
 * Construct an initial request with the only valid correlation: requestId is
 * always copied from operationId.
 */
export function createMessageRequestEnvelope<Id extends UUIDv4>(
  input: MessageRequestEnvelopeInput<Id>,
): MessageRequestEnvelope<Id> {
  return {
    ...input,
    requestId: input.operationId,
  } as MessageRequestEnvelope<Id>;
}

/**
 * Brand a fully validated candidate after checking the request correlation.
 * Other envelope validation remains the responsibility of validation.ts.
 */
export function validateMessageRequestEnvelope(
  envelope: MessageRequestEnvelopeCandidate,
): MessageRequestEnvelope {
  if (envelope.operation !== 'message.request' || envelope.operationId !== envelope.requestId) {
    throw new TypeError('message.request requestId must equal operationId');
  }

  return envelope as MessageRequestEnvelope;
}

export type MessageReplyEnvelope = ProtocolEnvelopeBase<'message.reply', MessageReplyPayload> & {
  /** A new operation ID targets an existing logical request. */
  readonly requestId: RequestId;
};

export type MessageNotifyEnvelope = ProtocolEnvelopeBase<'message.notify', MessageNotifyPayload> & {
  readonly requestId?: never;
};

export type TaskStatusEnvelope = ProtocolEnvelopeBase<'task.status', TaskStatusPayload> & {
  /** The target logical request; this operation has its own operation ID. */
  readonly requestId: RequestId;
};

export type TaskCancelEnvelope = ProtocolEnvelopeBase<'task.cancel', TaskCancelPayload> & {
  /** The target logical request; this operation has its own operation ID. */
  readonly requestId: RequestId;
};

export type ProtocolEnvelope =
  | PeerDescribeEnvelope
  | MessageRequestEnvelope
  | MessageReplyEnvelope
  | MessageNotifyEnvelope
  | TaskStatusEnvelope
  | TaskCancelEnvelope;
export type Envelope = ProtocolEnvelope;
export type OperationEnvelope = ProtocolEnvelope;

export type AdmissionState = Extract<TaskState, 'accepted' | 'queued'>;

export interface PeerDescribeResult {
  readonly agentCard: AgentCard;
  /** The wire capability projection is separate from the discovery card schema. */
  readonly capabilities?: ProtocolCapabilities;
  readonly protocolCapabilities?: ProtocolCapabilities;
}

export interface MessageRequestResult {
  readonly requestId: RequestId;
  readonly state: AdmissionState;
}

export interface MessageReplyResult {
  readonly requestId: RequestId;
  readonly outcome: TerminalOutcome;
  readonly delivered: true;
}

export interface MessageNotifyResult {
  readonly delivered: true;
}

export interface TaskStatusResult {
  readonly snapshot: TaskSnapshot;
}

export interface TaskCancelResult {
  readonly snapshot: TaskSnapshot;
}

export interface OperationResultMap {
  readonly 'peer.describe': PeerDescribeResult;
  readonly 'message.request': MessageRequestResult;
  readonly 'message.reply': MessageReplyResult;
  readonly 'message.notify': MessageNotifyResult;
  readonly 'task.status': TaskStatusResult;
  readonly 'task.cancel': TaskCancelResult;
}

export interface OperationResponseBase<O extends OperationName> {
  readonly protocolVersion: ProtocolVersion;
  readonly operation: O;
  readonly operationId: OperationId;
  readonly traceId: TraceId;
}

export type OperationSuccessResponse<
  O extends OperationName,
  R extends OperationResultMap[O],
> = OperationResponseBase<O> & {
  readonly result: R;
  readonly error?: never;
};

export type OperationErrorResponse<O extends OperationName = OperationName> =
  OperationResponseBase<O> & {
    readonly result?: never;
    readonly error: ProtocolError;
  };

export type OperationResponseFor<O extends OperationName> =
  OperationSuccessResponse<O, OperationResultMap[O]> | OperationErrorResponse<O>;

export type OperationResponse = {
  [O in OperationName]: OperationResponseFor<O>;
}[OperationName];
export type ProtocolOperationResponse = OperationResponse;
export type Response = OperationResponse;

/**
 * The protocol deliberately does not validate here.  Identity/session code
 * can use these narrow constructors at module boundaries, while validation
 * remains the responsibility of the protocol validator.
 */
export function asUuidV4(value: string): UUIDv4 {
  return value as UUIDv4;
}

export function asUtcTimestamp(value: string): UtcTimestamp {
  return value as UtcTimestamp;
}

export function asTraceId(value: string): TraceId {
  return value as TraceId;
}

export function asSessionId(value: string): SessionId {
  return value as SessionId;
}

export function asRuntimeId(value: string): RuntimeId {
  return value as RuntimeId;
}

export function asRoomId(value: string): RoomId {
  return value as RoomId;
}

// Keep the discovery capability type visible to consumers of the protocol model.
export type { AgentCapabilities };
