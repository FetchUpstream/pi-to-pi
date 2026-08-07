import { describe, expect, it } from 'vitest';

import { deriveRoomId } from '../../src/room.js';
import {
  asRuntimeId,
  asSessionId,
  type OperationResponse,
  type ProtocolEnvelope,
} from '../../src/protocol/messages.js';
import type {
  TransportAdapter,
  TransportBinding,
  TransportDeliveryResult,
  TransportInboundHooks,
  TransportRuntimeTarget,
} from '../../src/transport/transport.js';
import { MessageRouter } from '../../src/router/router.js';

const ROOM_ID = deriveRoomId('explicit', 'router-tests');
const RUNTIME_B = asRuntimeId('runtime-b');

class FakeTransport implements TransportAdapter<ProtocolEnvelope, OperationResponse, string> {
  private readonly bindings = new Map<
    string,
    {
      readonly target: TransportRuntimeTarget<string>;
      readonly hooks: TransportInboundHooks<ProtocolEnvelope, OperationResponse, string>;
    }
  >();

  async bind(
    target: TransportRuntimeTarget<string>,
    hooks: TransportInboundHooks<ProtocolEnvelope, OperationResponse, string>,
  ): Promise<TransportBinding<string>> {
    this.bindings.set(target.runtimeId, { target, hooks });
    return {
      target,
      close: async () => {
        this.bindings.delete(target.runtimeId);
      },
    };
  }

  async sendEnvelope(
    target: TransportRuntimeTarget<string>,
    envelope: ProtocolEnvelope,
  ): Promise<TransportDeliveryResult<string>> {
    const destination = this.bindings.get(target.runtimeId);
    if (destination === undefined) {
      return {
        status: 'failed',
        operationId: envelope.operationId,
        error: {
          code: 'unreachable',
          message: 'destination is not bound',
          retryable: true,
          target,
        },
      };
    }
    await destination.hooks.onEnvelope({
      envelope,
      source: {
        runtimeId: envelope.sender.runtimeId,
        endpoint: `endpoint-${envelope.sender.runtimeId}`,
      },
      reply: async (response) => {
        const source = this.bindings.get(envelope.sender.runtimeId);
        if (source === undefined) {
          return {
            status: 'failed',
            operationId: response.operationId,
            error: {
              code: 'unreachable',
              message: 'sender is not bound',
              retryable: true,
            },
          };
        }
        await source.hooks.onResponse({ response, source: destination.target });
        return { status: 'delivered', operationId: response.operationId };
      },
    });
    return { status: 'delivered', operationId: envelope.operationId };
  }

  async sendResponse(
    target: TransportRuntimeTarget<string>,
    response: OperationResponse,
  ): Promise<TransportDeliveryResult<string>> {
    const destination = this.bindings.get(target.runtimeId);
    if (destination === undefined) {
      return {
        status: 'failed',
        operationId: response.operationId,
        error: {
          code: 'unreachable',
          message: 'destination is not bound',
          retryable: true,
          target,
        },
      };
    }
    await destination.hooks.onResponse({ response, source: target });
    return { status: 'delivered', operationId: response.operationId };
  }

  async close(): Promise<void> {
    this.bindings.clear();
  }
}

function identity(runtimeId: string) {
  return { sessionId: asSessionId(`session-${runtimeId}`), runtimeId: asRuntimeId(runtimeId) };
}

function target(runtimeId: string): TransportRuntimeTarget<string> {
  return { runtimeId: asRuntimeId(runtimeId), endpoint: `endpoint-${runtimeId}` };
}

describe('MessageRouter', () => {
  it('correlates asynchronous request completion by requestId', async () => {
    const transport = new FakeTransport();
    const routerA = new MessageRouter({
      identity: identity('runtime-a'),
      roomId: ROOM_ID,
      transport,
      endpoint: 'endpoint-runtime-a',
      targetResolver: (runtimeId) => target(runtimeId),
    });
    const routerB = new MessageRouter({
      identity: identity('runtime-b'),
      roomId: ROOM_ID,
      transport,
      endpoint: 'endpoint-runtime-b',
      targetResolver: (runtimeId) => target(runtimeId),
      requestExecutor: async () => ({ type: 'text', text: 'completed explicitly' }),
    });

    await routerA.start();
    await routerB.start();

    const handle = await routerA.createRequest({
      recipientRuntimeId: RUNTIME_B,
      content: { type: 'text', text: 'please review' },
    });
    const admission = await handle.admission;
    expect(admission).toMatchObject({
      operation: 'message.request',
      result: { requestId: handle.requestId, state: 'accepted' },
    });
    const completion = await handle.completion;
    expect(completion).toMatchObject({
      requestId: handle.requestId,
      state: 'completed',
      content: { type: 'text', text: 'completed explicitly' },
    });

    await routerA.close();
    await routerB.close();
  });

  it('acknowledges notifications without creating a task', async () => {
    const transport = new FakeTransport();
    let received = 0;
    const routerA = new MessageRouter({
      identity: identity('runtime-a'),
      roomId: ROOM_ID,
      transport,
      endpoint: 'endpoint-runtime-a',
      targetResolver: (runtimeId) => target(runtimeId),
    });
    const routerB = new MessageRouter({
      identity: identity('runtime-b'),
      roomId: ROOM_ID,
      transport,
      endpoint: 'endpoint-runtime-b',
      targetResolver: (runtimeId) => target(runtimeId),
      onNotification: () => {
        received += 1;
      },
    });
    await routerA.start();
    await routerB.start();

    const response = await routerA.notify({
      recipientRuntimeId: RUNTIME_B,
      content: { type: 'json', value: { ready: true } },
    });

    expect(response).toMatchObject({ operation: 'message.notify', result: { delivered: true } });
    expect(received).toBe(1);
    expect(routerB.taskStore.size).toBe(0);

    await routerA.close();
    await routerB.close();
  });

  it('supports peer description, status, cancellation, and explicit terminal cleanup', async () => {
    const transport = new FakeTransport();
    const routerA = new MessageRouter({
      identity: identity('runtime-a'),
      roomId: ROOM_ID,
      transport,
      endpoint: 'endpoint-runtime-a',
      targetResolver: (runtimeId) => target(runtimeId),
    });
    const routerB = new MessageRouter({
      identity: identity('runtime-b'),
      roomId: ROOM_ID,
      transport,
      endpoint: 'endpoint-runtime-b',
      targetResolver: (runtimeId) => target(runtimeId),
      requestExecutor: () => new Promise<never>(() => undefined),
    });
    await routerA.start();
    await routerB.start();

    const described = await routerA.describe(RUNTIME_B);
    expect(described).toMatchObject({
      operation: 'peer.describe',
      result: { agentCard: { runtimeId: RUNTIME_B } },
    });

    const handle = await routerA.createRequest({
      recipientRuntimeId: RUNTIME_B,
      content: { type: 'text', text: 'hold this request' },
    });
    await handle.admission;
    const status = await routerA.status({
      requestId: handle.requestId,
      recipientRuntimeId: RUNTIME_B,
    });
    expect(status).toMatchObject({
      operation: 'task.status',
      result: { snapshot: { requestId: handle.requestId } },
    });

    const cancellation = await routerA.cancel({
      requestId: handle.requestId,
      recipientRuntimeId: RUNTIME_B,
      reason: 'test cancellation',
    });
    expect(cancellation).toMatchObject({
      operation: 'task.cancel',
      result: { snapshot: { requestId: handle.requestId, state: 'cancelling' } },
    });

    routerB.cancelTask(handle.requestId, { caller: RUNTIME_B, reason: 'executor stopped' });
    await expect(handle.completion).resolves.toMatchObject({
      requestId: handle.requestId,
      state: 'cancelled',
    });
    await routerA.close();
    await routerB.close();
  });

  it('returns cross_room before task lookup for an otherwise bound sender', async () => {
    const transport = new FakeTransport();
    const router = new MessageRouter({
      identity: identity('runtime-b'),
      roomId: ROOM_ID,
      transport,
      endpoint: 'endpoint-runtime-b',
    });
    const envelope = {
      protocolVersion: '1.0',
      operation: 'peer.describe',
      operationId: '22222222-2222-4222-8222-222222222222',
      sender: { sessionId: 'session-a', runtimeId: 'runtime-a' },
      recipientRuntimeId: 'runtime-b',
      roomId: deriveRoomId('explicit', 'other-room'),
      createdAt: '2026-08-07T10:00:00.000Z',
      expiresAt: '2026-08-07T10:00:30.000Z',
      traceId: 'b'.repeat(32),
      payload: {},
    } as unknown as ProtocolEnvelope;
    const response = await router.handleEnvelope({
      envelope,
      source: { runtimeId: 'runtime-a', endpoint: 'endpoint-runtime-a' },
      reply: async () => ({ status: 'delivered' }),
    });
    expect(response).toMatchObject({ error: { code: 'cross_room' } });
  });

  it('rejects an inbound operation from the wrong authenticated source runtime', async () => {
    const transport = new FakeTransport();
    const router = new MessageRouter({
      identity: identity('runtime-b'),
      roomId: ROOM_ID,
      transport,
      endpoint: 'endpoint-runtime-b',
    });
    const envelope = {
      protocolVersion: '1.0',
      operation: 'peer.describe',
      operationId: '11111111-1111-4111-8111-111111111111',
      sender: { sessionId: 'session-a', runtimeId: 'runtime-a' },
      recipientRuntimeId: 'runtime-b',
      roomId: ROOM_ID,
      createdAt: '2026-08-07T10:00:00.000Z',
      expiresAt: '2026-08-07T10:00:30.000Z',
      traceId: 'a'.repeat(32),
      payload: {},
    } as unknown as ProtocolEnvelope;

    const response = await router.handleEnvelope({
      envelope,
      source: { runtimeId: 'runtime-other', endpoint: 'endpoint-other' },
      reply: async () => ({ status: 'delivered' }),
    });

    expect(response).toMatchObject({ error: { code: 'unauthorized' } });
  });
});
