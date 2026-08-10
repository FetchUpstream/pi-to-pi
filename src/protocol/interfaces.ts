/**
 * Narrow seams used by the protocol engine and its in-memory conformance fakes.
 *
 * These contracts intentionally do not mention sockets, discovery records, or Pi
 * lifecycle values. Binding adapters translate their own values at this boundary.
 */

import type { ProtocolError } from './errors.js';
import type {
  Content,
  MessageRequestEnvelope,
  OperationResponse,
  ProtocolEnvelope,
  RequestId,
  RuntimeId,
  RoomId,
  SessionId,
  SenderIdentity,
} from './messages.js';
import type { TaskSnapshot } from './task-state.js';

export type ProtocolAwaitable<Value> = Value | PromiseLike<Value>;

/** Identity and room proven by an active binding, never by the wire payload alone. */
export interface AuthenticatedBindingContext {
  readonly authenticated: true;
  readonly senderRuntimeId: RuntimeId;
  readonly localRuntimeId: RuntimeId;
  readonly roomId: RoomId;
  readonly senderSessionId?: SessionId;
  /** Opaque adapter metadata; never include this in operation fingerprints. */
  readonly credentials?: unknown;
}

export type BindingAuthenticationContext = AuthenticatedBindingContext;

export interface BindingAuthenticationFailure {
  readonly authenticated: false;
  readonly reason?: string;
}

export type BindingAuthenticationResult =
  AuthenticatedBindingContext | BindingAuthenticationFailure;

/** Authentication is performed before protocol/task/dedupe lookup. */
export interface BindingAuthenticator {
  authenticate(envelope: unknown, binding: unknown): ProtocolAwaitable<BindingAuthenticationResult>;
}

export type AuthenticateBinding = BindingAuthenticator['authenticate'];

export interface OutboundDeliverySuccess {
  readonly delivered: true;
}

export interface OutboundDeliveryFailure {
  readonly delivered: false;
  readonly error: ProtocolError;
}

export type OutboundDeliveryResult = OutboundDeliverySuccess | OutboundDeliveryFailure;

/** Opaque outbound operation/ack delivery used by router fakes. */
export interface OutboundDelivery {
  send(envelope: ProtocolEnvelope): ProtocolAwaitable<OutboundDeliveryResult>;
  sendResponse(
    response: OperationResponse,
    recipientRuntimeId: RuntimeId,
    roomId: RoomId,
  ): ProtocolAwaitable<OutboundDeliveryResult>;
}

export type Delivery = OutboundDelivery;

/** Per-task cancellation is scoped to one request and must not be shared globally. */
export interface TaskCancellation {
  readonly signal: AbortSignal;
  cancel(reason?: unknown): void;
}

export type CancellationSignal = TaskCancellation;

export interface TaskExecutorContext {
  readonly request: MessageRequestEnvelope;
  readonly requestId: RequestId;
  readonly snapshot: TaskSnapshot;
  readonly signal: AbortSignal;
  readonly complete: (content: Content) => TaskSnapshot | undefined;
  readonly fail: (error: ProtocolError) => TaskSnapshot | undefined;
  readonly reject: (error: ProtocolError) => TaskSnapshot | undefined;
}

export type TaskExecutorResult =
  | void
  | Content
  | {
      readonly content?: Content;
      readonly error?: ProtocolError;
      readonly outcome?: 'completed' | 'failed' | 'rejected';
    };

/** Model/Pi adapters implement this without owning wire correlation. */
export type TaskExecutor = (context: TaskExecutorContext) => ProtocolAwaitable<TaskExecutorResult>;

export type ProtocolTaskExecutor = TaskExecutor;

export interface ProtocolClock {
  /** Wall time is used only for wire admission/deadline comparison. */
  wallNow(): number;
  /** Monotonic time is used for post-admission expiry scheduling. */
  monotonicNow(): number;
  setTimeout?(callback: () => void, delayMs: number): unknown;
  clearTimeout?(handle: unknown): void;
}

export interface ProtocolClockPair {
  readonly wall: () => number;
  readonly monotonic: () => number;
  readonly setTimeout?: ProtocolClock['setTimeout'];
  readonly clearTimeout?: ProtocolClock['clearTimeout'];
}

/** Optional helper for adapters that expose the authenticated sender directly. */
export interface BindingIdentity {
  readonly sender: SenderIdentity;
  readonly recipientRuntimeId: RuntimeId;
  readonly roomId: RoomId;
}
