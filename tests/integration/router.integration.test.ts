import { describe, expect, it } from 'vitest';

import { createProtocolError } from '../../src/protocol/errors.js';
import { deriveRoomId } from '../../src/room.js';
import {
  asRoomId,
  asRuntimeId,
  asSessionId,
  asTraceId,
  asUtcTimestamp,
  asUuidV4,
  type OperationName,
  type OperationResponse,
  type ProtocolEnvelope,
} from '../../src/protocol/messages.js';
import { RoutingPolicy } from '../../src/router/policy.js';
import { MessageRouter, type RouterTarget } from '../../src/router/router.js';
import type {
  TransportAdapter,
  TransportBinding,
  TransportDeliveryResult,
  TransportInboundHooks,
  TransportRuntimeTarget,
} from '../../src/transport/transport.js';

const ROOM_ID = deriveRoomId('explicit', 'router-integration');
const OTHER_ROOM_ID = deriveRoomId('explicit', 'router-integration-other');
const RUNTIME_B = asRuntimeId('runtime-b');
const REQUEST_ID = '10000000-0000-4000-8000-000000000001';
const REQUEST_ID_TWO = '10000000-0000-4000-8000-000000000002';
const REQUEST_ID_THREE = '10000000-0000-4000-8000-000000000003';
const REPLY_OPERATION_ID = '20000000-0000-4000-8000-000000000001';
const STATUS_OPERATION_ID = '30000000-0000-4000-8000-000000000001';
const NOTIFY_OPERATION_ID = '50000000-0000-4000-8000-000000000001';
const TRACE_ID = asTraceId('a'.repeat(32));

type Binding = {
  readonly target: TransportRuntimeTarget<string>;
  readonly hooks: TransportInboundHooks<ProtocolEnvelope, OperationResponse, string>;
};

/** A transport fake that preserves the router's envelope/response boundary. */
class FakeTransport implements TransportAdapter<ProtocolEnvelope, OperationResponse, string> {
  private readonly bindings = new Map<string, Binding>();

  public async bind(
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

  public async sendEnvelope(
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

  public async sendResponse(
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

  public async close(): Promise<void> {
    this.bindings.clear();
  }
}

function identity(runtimeId: string) {
  return {
    sessionId: asSessionId(`session-${runtimeId}`),
    runtimeId: asRuntimeId(runtimeId),
  };
}

function target(runtimeId: string): RouterTarget<string> {
  return {
    runtimeId: asRuntimeId(runtimeId),
    endpoint: `endpoint-${runtimeId}`,
  };
}

interface EnvelopeOptions {
  readonly senderRuntimeId?: string;
  readonly senderSessionId?: string;
  readonly recipientRuntimeId?: string;
  readonly roomId?: string;
  readonly requestId?: string;
  readonly createdAtMs?: number;
  readonly expiresAtMs?: number;
  readonly payload?: unknown;
}

function envelope(
  operation: OperationName,
  operationId: string,
  options: EnvelopeOptions = {},
): ProtocolEnvelope {
  const now = Date.now();
  const createdAtMs = options.createdAtMs ?? now - 1_000;
  const expiresAtMs = options.expiresAtMs ?? now + 20_000;
  const requestId =
    operation === 'message.request' ? operationId : (options.requestId ?? REQUEST_ID);
  const payload =
    options.payload ??
    (operation === 'message.request'
      ? { content: { type: 'text', text: 'integration request' } }
      : operation === 'message.reply'
        ? { outcome: 'completed', content: { type: 'text', text: 'integration reply' } }
        : operation === 'message.notify'
          ? { content: { type: 'text', text: 'integration notification' } }
          : {});
  return {
    protocolVersion: '1.0',
    operation,
    operationId: asUuidV4(operationId),
    ...(operation === 'message.request' ||
    operation === 'message.reply' ||
    operation === 'task.status' ||
    operation === 'task.cancel'
      ? { requestId: asUuidV4(requestId) }
      : {}),
    sender: {
      sessionId: asSessionId(
        options.senderSessionId ?? `session-${options.senderRuntimeId ?? 'runtime-a'}`,
      ),
      runtimeId: asRuntimeId(options.senderRuntimeId ?? 'runtime-a'),
    },
    recipientRuntimeId: asRuntimeId(options.recipientRuntimeId ?? 'runtime-b'),
    roomId: asRoomId(options.roomId ?? ROOM_ID),
    createdAt: asUtcTimestamp(new Date(createdAtMs).toISOString()),
    expiresAt: asUtcTimestamp(new Date(expiresAtMs).toISOString()),
    traceId: TRACE_ID,
    payload,
  } as unknown as ProtocolEnvelope;
}

function inbound(
  router: MessageRouter<string>,
  value: ProtocolEnvelope,
  sourceRuntimeId: string = value.sender.runtimeId,
) {
  return router.handleEnvelope({
    envelope: value,
    source: target(sourceRuntimeId),
    reply: async () => ({ status: 'delivered' }),
  });
}

function makeRouter(
  transport: FakeTransport,
  runtimeId: string,
  options: Partial<ConstructorParameters<typeof MessageRouter<string>>[0]> = {},
): MessageRouter<string> {
  return new MessageRouter({
    identity: identity(runtimeId),
    roomId: ROOM_ID,
    transport,
    endpoint: `endpoint-${runtimeId}`,
    targetResolver: (destination) => target(destination),
    ...options,
  });
}

async function closeAll(...routers: readonly MessageRouter<string>[]): Promise<void> {
  for (const router of routers) {
    await router.close();
  }
}

describe('two-runtime routing conformance', () => {
  it('advertises the v1 peer card and effective limits', async () => {
    const transport = new FakeTransport();
    const routerA = makeRouter(transport, 'runtime-a');
    const routerB = makeRouter(transport, 'runtime-b', {
      name: 'reviewer',
      description: 'A test reviewer runtime',
      supportsCancellation: true,
      supportsNotifications: true,
    });
    await routerA.start();
    await routerB.start();

    try {
      const response = await routerA.describe(RUNTIME_B);
      expect(response).toMatchObject({
        operation: 'peer.describe',
        result: {
          agentCard: {
            name: 'reviewer',
            runtimeId: RUNTIME_B,
            supportedProtocolVersions: ['1.0'],
            capabilities: {
              supportsCancellation: true,
              supportsNotifications: true,
            },
          },
        },
      });
      const result = response.result as {
        readonly agentCard: { readonly limits: unknown; readonly operations: readonly unknown[] };
      };
      expect(result.agentCard.operations).toHaveLength(6);
      expect(result.agentCard.limits).toEqual(routerB.limits);
    } finally {
      await closeAll(routerA, routerB);
    }
  });

  it('returns each admission and terminal response with explicit operation correlation', async () => {
    const transport = new FakeTransport();
    const routerA = makeRouter(transport, 'runtime-a');
    const completions: string[] = [];
    const routerB = makeRouter(transport, 'runtime-b', {
      requestExecutor: async ({ request }) => {
        const text = request.payload.content.type === 'text' ? request.payload.content.text : '';
        completions.push(text);
        return { type: 'text', text: `reply:${text}` };
      },
    });
    await routerA.start();
    await routerB.start();

    try {
      const first = await routerA.createRequest({
        recipientRuntimeId: RUNTIME_B,
        content: { type: 'text', text: 'first' },
      });
      const second = await routerA.createRequest({
        recipientRuntimeId: RUNTIME_B,
        content: { type: 'text', text: 'second' },
      });
      await expect(first.admission).resolves.toMatchObject({
        operationId: first.operationId,
        result: { requestId: first.requestId },
      });
      await expect(second.admission).resolves.toMatchObject({
        operationId: second.operationId,
        result: { requestId: second.requestId },
      });
      await expect(first.completion).resolves.toMatchObject({
        requestId: first.requestId,
        content: { type: 'text', text: 'reply:first' },
      });
      await expect(second.completion).resolves.toMatchObject({
        requestId: second.requestId,
        content: { type: 'text', text: 'reply:second' },
      });
      expect(completions).toEqual(['first', 'second']);
    } finally {
      await closeAll(routerA, routerB);
    }
  });

  it('delivers failed and rejected terminal outcomes across the fake transport', async () => {
    const transport = new FakeTransport();
    const routerA = makeRouter(transport, 'runtime-a');
    const routerB = makeRouter(transport, 'runtime-b', {
      requestExecutor: async ({ request }) => {
        const text = request.payload.content.type === 'text' ? request.payload.content.text : '';
        if (text === 'failed') {
          return { error: createProtocolError('internal', 'executor failed') };
        }
        return {
          outcome: 'rejected',
          error: createProtocolError('malformed', 'request rejected by policy'),
        };
      },
    });
    await routerA.start();
    await routerB.start();

    try {
      const failed = await routerA.createRequest({
        recipientRuntimeId: RUNTIME_B,
        content: { type: 'text', text: 'failed' },
      });
      const rejected = await routerA.createRequest({
        recipientRuntimeId: RUNTIME_B,
        content: { type: 'text', text: 'rejected' },
      });
      await expect(failed.admission).resolves.toMatchObject({
        result: { requestId: failed.requestId },
      });
      await expect(rejected.admission).resolves.toMatchObject({
        result: { requestId: rejected.requestId },
      });
      await expect(failed.completion).resolves.toMatchObject({
        requestId: failed.requestId,
        state: 'failed',
        error: { code: 'internal' },
      });
      await expect(rejected.completion).resolves.toMatchObject({
        requestId: rejected.requestId,
        state: 'rejected',
        error: { code: 'malformed' },
      });
    } finally {
      await closeAll(routerA, routerB);
    }
  });

  it('acknowledges notifications without creating logical tasks', async () => {
    const transport = new FakeTransport();
    let received = 0;
    const routerA = makeRouter(transport, 'runtime-a');
    const routerB = makeRouter(transport, 'runtime-b', {
      onNotification: () => {
        received += 1;
      },
    });
    await routerA.start();
    await routerB.start();

    try {
      const response = await routerA.notify({
        recipientRuntimeId: RUNTIME_B,
        content: { type: 'json', value: { ready: true } },
      });
      expect(response).toMatchObject({
        operation: 'message.notify',
        result: { delivered: true },
      });
      expect(received).toBe(1);
      expect(routerB.taskStore.size).toBe(0);
    } finally {
      await closeAll(routerA, routerB);
    }
  });

  it('supports authorized status and cooperative cancellation', async () => {
    const transport = new FakeTransport();
    const routerA = makeRouter(transport, 'runtime-a');
    const routerB = makeRouter(transport, 'runtime-b', {
      requestExecutor: () => new Promise<never>(() => undefined),
    });
    await routerA.start();
    await routerB.start();

    try {
      const handle = await routerA.createRequest({
        recipientRuntimeId: RUNTIME_B,
        content: { type: 'text', text: 'hold' },
      });
      await handle.admission;
      await expect(
        routerA.status({ requestId: handle.requestId, recipientRuntimeId: RUNTIME_B }),
      ).resolves.toMatchObject({
        operation: 'task.status',
        result: { snapshot: { requestId: handle.requestId, state: 'working' } },
      });
      await expect(
        routerA.cancel({
          requestId: handle.requestId,
          recipientRuntimeId: RUNTIME_B,
          reason: 'stop this task',
        }),
      ).resolves.toMatchObject({
        operation: 'task.cancel',
        result: { snapshot: { requestId: handle.requestId, state: 'cancelling' } },
      });
      routerB.cancelTask(handle.requestId, { caller: RUNTIME_B, reason: 'executor stopped' });
      await expect(handle.completion).resolves.toMatchObject({
        requestId: handle.requestId,
        state: 'cancelled',
      });
    } finally {
      await closeAll(routerA, routerB);
    }
  });

  it('isolates rooms and authenticates the transport source before lookup', async () => {
    const transport = new FakeTransport();
    const routerB = makeRouter(transport, 'runtime-b');
    await routerB.start();

    try {
      const crossRoom = await inbound(
        routerB,
        envelope('peer.describe', '60000000-0000-4000-8000-000000000001', {
          roomId: OTHER_ROOM_ID,
        }),
      );
      expect(crossRoom).toMatchObject({ error: { code: 'cross_room' } });

      const wrongSource = await inbound(
        routerB,
        envelope('peer.describe', '60000000-0000-4000-8000-000000000002'),
        'runtime-c',
      );
      expect(wrongSource).toMatchObject({ error: { code: 'unauthorized' } });
    } finally {
      await routerB.close();
    }
  });

  it('maps core admission and delivery failures to stable protocol errors', async () => {
    const transport = new FakeTransport();
    const routerB = makeRouter(transport, 'runtime-b');
    await routerB.start();

    try {
      const malformedId = await inbound(routerB, {
        ...envelope('peer.describe', '70000000-0000-4000-8000-000000000002'),
        operationId: 'not-a-uuid',
      } as unknown as ProtocolEnvelope);
      expect(malformedId).toMatchObject({ error: { code: 'malformed', retryable: false } });

      const incompatible = await inbound(routerB, {
        ...envelope('peer.describe', '70000000-0000-4000-8000-000000000003'),
        protocolVersion: '2.0',
      } as unknown as ProtocolEnvelope);
      expect(incompatible).toMatchObject({ error: { code: 'incompatible', retryable: false } });

      const now = Date.now();
      const expired = await inbound(
        routerB,
        envelope('message.request', REQUEST_ID, {
          createdAtMs: now - 2_000,
          expiresAtMs: now - 1_000,
        }),
      );
      expect(expired).toMatchObject({ error: { code: 'expired', retryable: false } });

      const oversized = await inbound(
        routerB,
        envelope('message.request', REQUEST_ID_TWO, {
          payload: { content: { type: 'text', text: 'x'.repeat(1_100_000) } },
        }),
      );
      expect(oversized).toMatchObject({ error: { code: 'oversized', retryable: false } });

      const firstNotification = envelope('message.notify', NOTIFY_OPERATION_ID, {
        payload: { content: { type: 'text', text: 'one' } },
      });
      const firstNotificationResponse = await inbound(routerB, firstNotification);
      expect(firstNotificationResponse).toMatchObject({ result: { delivered: true } });
      const conflict = await inbound(
        routerB,
        envelope('message.notify', NOTIFY_OPERATION_ID, {
          payload: { content: { type: 'text', text: 'different' } },
        }),
      );
      expect(conflict).toMatchObject({ error: { code: 'duplicate', retryable: false } });
    } finally {
      await routerB.close();
    }
  });

  it('returns busy for a full bounded queue and unreachable when the peer is absent', async () => {
    const transport = new FakeTransport();
    const routerB = makeRouter(transport, 'runtime-b', {
      routingPolicy: new RoutingPolicy({ capacity: 1, activeCapacity: 1 }),
      requestExecutor: () => new Promise<never>(() => undefined),
    });
    await routerB.start();

    try {
      const first = await inbound(
        routerB,
        envelope('message.request', REQUEST_ID, { senderRuntimeId: 'runtime-a' }),
      );
      expect(first).toMatchObject({ result: { state: 'accepted' } });
      const second = await inbound(
        routerB,
        envelope('message.request', REQUEST_ID_TWO, { senderRuntimeId: 'runtime-c' }),
      );
      expect(second).toMatchObject({ result: { state: 'queued' } });
      const third = await inbound(
        routerB,
        envelope('message.request', REQUEST_ID_THREE, { senderRuntimeId: 'runtime-a' }),
      );
      expect(third).toMatchObject({ error: { code: 'busy', retryable: true } });
    } finally {
      await routerB.close();
    }

    const absentPeerRouter = makeRouter(transport, 'runtime-a');
    await expect(absentPeerRouter.describe(RUNTIME_B)).rejects.toMatchObject({
      code: 'unreachable',
      protocolError: { code: 'unreachable' },
    });
    await absentPeerRouter.close();
  });

  it('rejects invalid replies and protects terminal task state', async () => {
    const transport = new FakeTransport();
    const routerA = makeRouter(transport, 'runtime-a');
    const routerB = makeRouter(transport, 'runtime-b', {
      requestExecutor: ({ signal }) =>
        new Promise<never>((_, reject) => {
          signal.addEventListener('abort', () => reject(new Error('executor cancelled')), {
            once: true,
          });
        }),
    });
    await routerA.start();
    await routerB.start();

    try {
      const handle = await routerA.createRequest({
        recipientRuntimeId: RUNTIME_B,
        content: { type: 'text', text: 'schema response' },
        expectedResponse: {
          contentType: 'json',
          schema: {
            type: 'object',
            required: ['answer'],
            properties: { answer: { type: 'string' } },
            additionalProperties: false,
          },
        },
      });
      await handle.admission;
      const invalidReply = await inbound(
        routerA,
        envelope('message.reply', REPLY_OPERATION_ID, {
          senderRuntimeId: 'runtime-b',
          recipientRuntimeId: 'runtime-a',
          requestId: handle.requestId,
          payload: {
            outcome: 'completed',
            content: { type: 'json', value: { answer: 42 } },
          },
          createdAtMs: Date.parse(handle.envelope.createdAt),
          expiresAtMs: Date.parse(handle.envelope.expiresAt),
        }),
        'runtime-b',
      );
      expect(invalidReply).toMatchObject({ error: { code: 'invalid_reply' } });
      expect(routerA.taskSnapshot(handle.requestId)).toMatchObject({ state: 'accepted' });

      const missingStatus = await inbound(
        routerB,
        envelope('task.status', STATUS_OPERATION_ID, {
          requestId: REQUEST_ID_THREE,
          senderRuntimeId: 'runtime-b',
          recipientRuntimeId: 'runtime-b',
        }),
      );
      expect(missingStatus).toMatchObject({ error: { code: 'unauthorized' } });

      const cancelled = routerB.cancelTask(handle.requestId, {
        caller: RUNTIME_B,
        reason: 'cancel before late reply',
      });
      expect(cancelled).toMatchObject({ snapshot: { state: 'cancelling' } });
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      const lateReply = await inbound(
        routerA,
        envelope('message.reply', '80000000-0000-4000-8000-000000000001', {
          senderRuntimeId: 'runtime-b',
          recipientRuntimeId: 'runtime-a',
          requestId: handle.requestId,
          payload: { outcome: 'completed', content: { type: 'json', value: { answer: 'late' } } },
          createdAtMs: Date.parse(handle.envelope.createdAt),
          expiresAtMs: Date.parse(handle.envelope.expiresAt),
        }),
        'runtime-b',
      );
      expect(lateReply).toMatchObject({ error: { code: 'cancelled' } });
      expect(routerA.taskSnapshot(handle.requestId)).toMatchObject({ state: 'cancelled' });
    } finally {
      await closeAll(routerA, routerB);
    }
  });

  it('does not infer a completion from an unrelated agent lifecycle result', async () => {
    const transport = new FakeTransport();
    let executorCalled = false;
    const routerA = makeRouter(transport, 'runtime-a');
    const routerB = makeRouter(transport, 'runtime-b', {
      requestExecutor: async () => {
        executorCalled = true;
        return undefined;
      },
    });
    await routerA.start();
    await routerB.start();

    try {
      const handle = await routerA.createRequest({
        recipientRuntimeId: RUNTIME_B,
        content: { type: 'text', text: 'no implicit result' },
      });
      await handle.admission;
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(executorCalled).toBe(true);
      expect(routerB.taskSnapshot(handle.requestId)?.state).toBe('working');
      expect(routerA.taskSnapshot(handle.requestId)?.state).toBe('accepted');
    } finally {
      await closeAll(routerA, routerB);
    }
  });
});
