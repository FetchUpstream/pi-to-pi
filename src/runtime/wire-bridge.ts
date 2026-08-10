import type { AgentCardRegistry } from '../discovery/agent-card-registry.js';
import type { DiagnosticEventSink } from '../diagnostics.js';
import { createProtocolError } from '../protocol/errors.js';
import type { OutboundDelivery, OutboundDeliveryResult } from '../protocol/interfaces.js';
import type {
  OperationResponse,
  ProtocolEnvelope,
  RoomId,
  RuntimeId,
} from '../protocol/messages.js';
import { validateEnvelope, validateOperationResponse } from '../protocol/validation.js';
import { MessageRouter } from '../router/router.js';
import type { LocalIpcTransport } from '../transport/transport.js';

export class ProtocolWireError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'ProtocolWireError';
  }
}

/** Bounded UTF-8 JSON framing above the opaque local IPC payload. */
export class ProtocolWireCodec {
  public readonly maxPayloadBytes: number;

  public constructor(maxPayloadBytes: number) {
    if (!Number.isSafeInteger(maxPayloadBytes) || maxPayloadBytes <= 0) {
      throw new RangeError('maxPayloadBytes must be a positive safe integer');
    }
    this.maxPayloadBytes = maxPayloadBytes;
  }

  public encodeEnvelope(value: ProtocolEnvelope): Uint8Array {
    return this.encode(value);
  }

  public encodeResponse(value: OperationResponse): Uint8Array {
    return this.encode(value);
  }

  public decodeEnvelope(payload: Uint8Array): ProtocolEnvelope {
    const value = this.decode(payload);
    const result = validateEnvelope(value, { maxEnvelopeBytes: this.maxPayloadBytes });
    if (!result.ok) throw new ProtocolWireError(result.error.message);
    return result.value;
  }

  public decodeResponse(payload: Uint8Array): OperationResponse {
    const value = this.decode(payload);
    const result = validateOperationResponse(value, { maxEnvelopeBytes: this.maxPayloadBytes });
    if (!result.ok) throw new ProtocolWireError(result.error.message);
    return result.value;
  }

  private encode(value: unknown): Uint8Array {
    let text: string;
    try {
      text = JSON.stringify(value);
    } catch {
      throw new ProtocolWireError('protocol value is not JSON serializable');
    }
    if (text === undefined) throw new ProtocolWireError('protocol value is not JSON serializable');
    const payload = new TextEncoder().encode(text);
    if (payload.byteLength > this.maxPayloadBytes)
      throw new ProtocolWireError('protocol payload exceeds the size limit');
    return payload;
  }

  private decode(payload: Uint8Array): unknown {
    if (payload.byteLength > this.maxPayloadBytes)
      throw new ProtocolWireError('protocol payload exceeds the size limit');
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(payload);
      return JSON.parse(text) as unknown;
    } catch {
      throw new ProtocolWireError('protocol payload is malformed');
    }
  }
}

export interface LocalIpcBridgeOptions {
  readonly transport: LocalIpcTransport;
  readonly peers: AgentCardRegistry;
  readonly codec: ProtocolWireCodec;
  readonly router: () => MessageRouter | undefined;
  readonly diagnostics?: DiagnosticEventSink;
}

/** Routes authenticated local IPC operations into one runtime-local router. */
export class LocalIpcBridge implements OutboundDelivery {
  public constructor(private readonly options: LocalIpcBridgeOptions) {}

  public async handle(payload: Uint8Array): Promise<Uint8Array> {
    this.options.diagnostics?.record({ component: 'ipc', name: 'inbound-frame' });
    const router = this.options.router();
    if (router === undefined) throw new ProtocolWireError('runtime is not ready');
    const envelope = this.options.codec.decodeEnvelope(payload);
    const peers = await this.options.peers.listPeers();
    const sender = peers.find(
      (peer) =>
        String(peer.runtimeId) === envelope.sender.runtimeId &&
        peer.card.sessionId === envelope.sender.sessionId &&
        String(peer.roomId) === router.roomId &&
        peer.endpoint.runtimeInstanceId === envelope.sender.runtimeId,
    );
    if (
      sender === undefined ||
      envelope.roomId !== router.roomId ||
      envelope.recipientRuntimeId !== router.runtimeId
    ) {
      throw new ProtocolWireError('sender binding is not live in this room');
    }
    const response = await router.processInbound(envelope, {
      authenticated: true,
      senderRuntimeId: envelope.sender.runtimeId,
      senderSessionId: envelope.sender.sessionId,
      localRuntimeId: router.runtimeId,
      roomId: router.roomId,
    });
    return this.options.codec.encodeResponse(response);
  }

  public async send(envelope: ProtocolEnvelope): Promise<OutboundDeliveryResult> {
    this.options.diagnostics?.record({
      component: 'ipc',
      name: 'outbound-frame',
      operation: envelope.operation,
      runtimeId: envelope.sender.runtimeId,
      peerRuntimeId: envelope.recipientRuntimeId,
    });
    const router = this.options.router();
    if (router === undefined) return this.failure('runtime is not ready');
    const target = await this.target(envelope.recipientRuntimeId, envelope.roomId);
    if (target === undefined) return this.failure('peer is unavailable');
    try {
      const response = this.options.codec.decodeResponse(
        await this.options.transport.request(
          target.endpoint.address,
          this.options.codec.encodeEnvelope(envelope),
        ),
      );
      await router.processResponse(response);
      return { delivered: true };
    } catch (error) {
      return this.failure(error instanceof Error ? error.message : 'peer is unreachable');
    }
  }

  public async sendResponse(
    response: OperationResponse,
    recipientRuntimeId: RuntimeId,
    roomId: RoomId,
  ): Promise<OutboundDeliveryResult> {
    const target = await this.target(recipientRuntimeId, roomId);
    if (target === undefined) return this.failure('peer is unavailable');
    try {
      await this.options.transport.request(
        target.endpoint.address,
        this.options.codec.encodeResponse(response),
      );
      return { delivered: true };
    } catch (error) {
      return this.failure(error instanceof Error ? error.message : 'peer is unreachable');
    }
  }

  private async target(runtimeId: RuntimeId, roomId: RoomId) {
    if (String(roomId) !== this.options.peers.roomId) return undefined;
    const result = await this.options.peers.lookupPeerByRuntimeId(runtimeId);
    return result.kind === 'found' && result.record.endpoint.runtimeInstanceId === runtimeId
      ? result.record
      : undefined;
  }

  private failure(message: string): OutboundDeliveryResult {
    return { delivered: false, error: createProtocolError('unreachable', message.slice(0, 512)) };
  }
}
