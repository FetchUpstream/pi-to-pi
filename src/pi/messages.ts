import type { ProtocolError } from '../protocol/errors.js';
import type { OperationResponse, ProtocolEnvelope, RequestId } from '../protocol/messages.js';
import type { TaskSnapshot, TaskState } from '../protocol/task-state.js';

/** Custom message types emitted to a Pi session or extension event sink. */
export const PI_MESSAGE_TYPES = [
  'pi-to-pi.request',
  'pi-to-pi.reply',
  'pi-to-pi.notify',
  'pi-to-pi.task_update',
  'pi-to-pi.cancel',
  'pi-to-pi.expired',
  'pi-to-pi.unreachable',
] as const;

export type PiMessageType = (typeof PI_MESSAGE_TYPES)[number];
export type PiCustomMessageType = PiMessageType;

export const PI_EVENT_NAMES = [
  'pi_to_pi_request',
  'pi_to_pi_reply',
  'pi_to_pi_notify',
  'pi_to_pi_task_update',
  'pi_to_pi_cancel',
  'pi_to_pi_expired',
  'pi_to_pi_unreachable',
] as const;

export type PiEventName = (typeof PI_EVENT_NAMES)[number];

export interface PiMessageBase<Type extends PiMessageType = PiMessageType> {
  readonly type: Type;
  readonly requestId?: RequestId;
  readonly operationId?: string;
  readonly runtimeId?: string;
  readonly sessionId?: string;
}

export interface PiInboundRequestMessage extends PiMessageBase<'pi-to-pi.request'> {
  readonly type: 'pi-to-pi.request';
  readonly request: ProtocolEnvelope & { readonly operation: 'message.request' };
}

export interface PiInboundReplyMessage extends PiMessageBase<'pi-to-pi.reply'> {
  readonly type: 'pi-to-pi.reply';
  readonly reply: ProtocolEnvelope & { readonly operation: 'message.reply' };
}

export interface PiInboundNotificationMessage extends PiMessageBase<'pi-to-pi.notify'> {
  readonly type: 'pi-to-pi.notify';
  readonly notification: ProtocolEnvelope & { readonly operation: 'message.notify' };
}

export interface PiTaskUpdateMessage extends PiMessageBase<'pi-to-pi.task_update'> {
  readonly type: 'pi-to-pi.task_update';
  readonly requestId: RequestId;
  readonly state: TaskState;
  readonly snapshot: TaskSnapshot;
}

export interface PiTaskCancellationMessage extends PiMessageBase<'pi-to-pi.cancel'> {
  readonly type: 'pi-to-pi.cancel';
  readonly requestId: RequestId;
  readonly reason?: string;
}

export interface PiTaskExpiredMessage extends PiMessageBase<'pi-to-pi.expired'> {
  readonly type: 'pi-to-pi.expired';
  readonly requestId: RequestId;
  readonly snapshot: TaskSnapshot;
  readonly error: ProtocolError;
}

export interface PiTaskUnreachableMessage extends PiMessageBase<'pi-to-pi.unreachable'> {
  readonly type: 'pi-to-pi.unreachable';
  readonly operationId: string;
  readonly requestId?: RequestId;
  readonly error: ProtocolError & { readonly code: 'unreachable' };
}

export type PiToPiMessage =
  | PiInboundRequestMessage
  | PiInboundReplyMessage
  | PiInboundNotificationMessage
  | PiTaskUpdateMessage
  | PiTaskCancellationMessage
  | PiTaskExpiredMessage
  | PiTaskUnreachableMessage;

export type PiCustomMessage = PiToPiMessage;
export type PiInboundMessage =
  PiInboundRequestMessage | PiInboundReplyMessage | PiInboundNotificationMessage;
export type PiTaskMessage =
  PiTaskUpdateMessage | PiTaskCancellationMessage | PiTaskExpiredMessage | PiTaskUnreachableMessage;

export interface PiOperationResponseMessage extends PiMessageBase {
  readonly type: 'pi-to-pi.reply';
  readonly response: OperationResponse;
}

export interface PiMessageSink {
  readonly emit?: (event: PiEventName, message: PiToPiMessage) => void | PromiseLike<void>;
  readonly sendMessage?: (message: PiToPiMessage) => void | PromiseLike<void>;
  readonly appendCustomMessage?: (message: PiToPiMessage) => void | PromiseLike<void>;
}

function freezeMessage<T extends PiToPiMessage>(message: T): T {
  return Object.freeze(message);
}

/** Construct a typed request message for the Pi-facing lifecycle boundary. */
export function createPiRequestMessage(
  request: PiInboundRequestMessage['request'],
): PiInboundRequestMessage {
  return freezeMessage({
    type: 'pi-to-pi.request',
    requestId: request.requestId,
    operationId: request.operationId,
    runtimeId: request.sender.runtimeId,
    sessionId: request.sender.sessionId,
    request,
  });
}

export function createPiReplyMessage(reply: PiInboundReplyMessage['reply']): PiInboundReplyMessage {
  return freezeMessage({
    type: 'pi-to-pi.reply',
    requestId: reply.requestId,
    operationId: reply.operationId,
    runtimeId: reply.sender.runtimeId,
    sessionId: reply.sender.sessionId,
    reply,
  });
}

export function createPiNotificationMessage(
  notification: PiInboundNotificationMessage['notification'],
): PiInboundNotificationMessage {
  return freezeMessage({
    type: 'pi-to-pi.notify',
    operationId: notification.operationId,
    runtimeId: notification.sender.runtimeId,
    sessionId: notification.sender.sessionId,
    notification,
  });
}

export function createPiTaskUpdateMessage(snapshot: TaskSnapshot): PiTaskUpdateMessage {
  return freezeMessage({
    type: 'pi-to-pi.task_update',
    requestId: snapshot.requestId,
    state: snapshot.state,
    snapshot,
  });
}

export function createPiCancellationMessage(
  requestId: RequestId,
  reason?: string,
): PiTaskCancellationMessage {
  return freezeMessage({
    type: 'pi-to-pi.cancel',
    requestId,
    ...(reason === undefined ? {} : { reason }),
  });
}

export function createPiExpiredMessage(
  snapshot: TaskSnapshot,
  error: ProtocolError,
): PiTaskExpiredMessage {
  return freezeMessage({
    type: 'pi-to-pi.expired',
    requestId: snapshot.requestId,
    snapshot,
    error,
  });
}

export function createPiUnreachableMessage(
  operationId: string,
  error: ProtocolError & { readonly code: 'unreachable' },
  requestId?: RequestId,
): PiTaskUnreachableMessage {
  return freezeMessage({
    type: 'pi-to-pi.unreachable',
    operationId,
    ...(requestId === undefined ? {} : { requestId }),
    error,
  });
}

/** Runtime guard for values arriving from a Pi custom-message hook. */
export function isPiToPiMessage(value: unknown): value is PiToPiMessage {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const type = (value as { readonly type?: unknown }).type;
  return typeof type === 'string' && (PI_MESSAGE_TYPES as readonly string[]).includes(type);
}

export const isPiCustomMessage = isPiToPiMessage;
export const isPiToPiCustomMessage = isPiToPiMessage;

/** Map a custom message type to the corresponding extension event name. */
export function piEventNameForMessage(message: PiToPiMessage): PiEventName {
  return message.type.replaceAll('-', '_').replaceAll('.', '_') as PiEventName;
}

/** Emit through the strongest available Pi-facing sink without creating globals. */
export async function emitPiMessage(sink: PiMessageSink, message: PiToPiMessage): Promise<void> {
  if (sink.emit !== undefined) {
    await sink.emit(piEventNameForMessage(message), message);
    return;
  }
  if (sink.sendMessage !== undefined) {
    await sink.sendMessage(message);
    return;
  }
  if (sink.appendCustomMessage !== undefined) {
    await sink.appendCustomMessage(message);
  }
}
