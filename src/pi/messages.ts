import type { Content, ExpectedResponse, RequestId, RuntimeId } from '../protocol/messages.js';
import type { ProtocolError } from '../protocol/errors.js';
import type { TaskSnapshot, TaskState, TerminalOutcome } from '../protocol/task-state.js';

export const PI_P2P_INBOUND_MESSAGE = 'pi-to-pi.inbound-request';
export const PI_P2P_OUTBOUND_MESSAGE = 'pi-to-pi.outbound-result';

/** Model-visible correlation metadata for an inbound router task. */
export interface PiInboundRequestDetails {
  readonly kind: 'inbound-request';
  readonly requestId: RequestId;
  readonly senderRuntimeId: RuntimeId;
  readonly traceId: string;
  readonly parentOperationId?: string;
  readonly expectedResponse?: ExpectedResponse;
  readonly state: TaskState;
  readonly expiresAt: string;
}

/** Model-visible correlation metadata for one terminal outbound router task. */
export interface PiOutboundResultDetails {
  readonly kind: 'outbound-result';
  readonly requestId: RequestId;
  readonly peerRuntimeId: RuntimeId;
  readonly state: TaskState;
  readonly terminalOutcome: TerminalOutcome;
}

/** Persistable history metadata. It deliberately contains no request or reply body. */
export interface PiTaskAuditMetadata {
  readonly requestId: RequestId;
  readonly direction: 'inbound' | 'outbound';
  readonly peerRuntimeId: RuntimeId;
  readonly state: TaskState;
  readonly timestamp: string;
}

export interface PiInboundCustomMessage {
  readonly customType: typeof PI_P2P_INBOUND_MESSAGE;
  readonly content: string;
  readonly display: true;
  readonly details: PiInboundRequestDetails;
}

export interface PiOutboundCustomMessage {
  readonly customType: typeof PI_P2P_OUTBOUND_MESSAGE;
  readonly content: string;
  readonly display: true;
  readonly details: PiOutboundResultDetails;
}

export function inboundAudit(details: PiInboundRequestDetails): PiTaskAuditMetadata {
  return {
    requestId: details.requestId,
    direction: 'inbound',
    peerRuntimeId: details.senderRuntimeId,
    state: details.state,
    timestamp: new Date().toISOString(),
  };
}

export function outboundAudit(details: PiOutboundResultDetails): PiTaskAuditMetadata {
  return {
    requestId: details.requestId,
    direction: 'outbound',
    peerRuntimeId: details.peerRuntimeId,
    state: details.state,
    timestamp: new Date().toISOString(),
  };
}

export function contentText(content: Content): string {
  return content.type === 'text' ? content.text : JSON.stringify(content.value);
}

export function terminalText(snapshot: TaskSnapshot): string {
  if (snapshot.state === 'completed' && snapshot.content !== undefined) {
    return contentText(snapshot.content);
  }
  return snapshot.error?.message ?? `Request ${snapshot.state}`;
}

export function taskErrorMessage(error: ProtocolError): string {
  return `${error.code}: ${error.message}`;
}
