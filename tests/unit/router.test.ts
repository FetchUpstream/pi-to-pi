import { describe, expect, it, vi } from 'vitest';

import { deriveRoomId } from '../../src/room.js';
import { createProtocolError } from '../../src/protocol/errors.js';
import {
  asRoomId,
  asRuntimeId,
  asSessionId,
  asTraceId,
  asUtcTimestamp,
  asUuidV4,
  type OperationResponse,
  type ProtocolEnvelope,
  type RequestId,
} from '../../src/protocol/messages.js';
import type { BindingAuthenticator } from '../../src/protocol/interfaces.js';
import { RuntimeScopedDedupeStore } from '../../src/router/dedupe.js';
import { MessageRouter, type RouterOptions } from '../../src/router/router.js';
import { RoutingPolicy } from '../../src/router/policy.js';
import { TaskStore } from '../../src/router/task-store.js';

const NOW = Date.parse('2026-08-07T10:00:00.000Z');
const ROOM = deriveRoomId('explicit', 'router-tests');
const TRACE = asTraceId('a'.repeat(32));

function request(
  operationId: string,
  senderRuntimeId = 'runtime-a',
  content = 'hello',
): ProtocolEnvelope {
  const id = asUuidV4(operationId);
  return {
    protocolVersion: '1.0',
    operation: 'message.request',
    operationId: id,
    requestId: id,
    sender: {
      sessionId: asSessionId(`session-${senderRuntimeId}`),
      runtimeId: asRuntimeId(senderRuntimeId),
    },
    recipientRuntimeId: asRuntimeId('runtime-b'),
    roomId: asRoomId(ROOM),
    createdAt: asUtcTimestamp(new Date(NOW).toISOString()),
    expiresAt: asUtcTimestamp(new Date(NOW + 60_000).toISOString()),
    traceId: TRACE,
    payload: { content: { type: 'text', text: content } },
  } as ProtocolEnvelope;
}

function router(options: Partial<RouterOptions> = {}): MessageRouter {
  return new MessageRouter({
    ...options,
    identity: { sessionId: 'session-b', runtimeId: 'runtime-b' },
    roomId: ROOM,
    now: () => NOW,
    monotonicNow: () => NOW,
  });
}

describe('MessageRouter', () => {
  it('admits an inbound request before execution and replays its acknowledgement', async () => {
    const execute = vi.fn(async () => ({ type: 'text' as const, text: 'done' }));
    const instance = router({ requestExecutor: execute });
    const envelope = request('11111111-1111-4111-8111-111111111111');

    const first = await instance.processInbound(envelope);
    const retry = await instance.processInbound(envelope);

    expect(first).toMatchObject({
      operation: 'message.request',
      result: { requestId: envelope.requestId, state: 'accepted' },
    });
    expect(retry).toEqual(first);
    expect(instance.taskStore.size).toBe(1);
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(1));
  });

  it('does not reserve a transient busy request', async () => {
    let releaseFirst!: () => void;
    const firstFinished = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const instance = router({
      routingPolicy: new RoutingPolicy({
        capacity: 1,
        activeCapacity: 1,
        monotonicNow: () => NOW,
      }),
      requestExecutor: async () => {
        await firstFinished;
        return { type: 'text', text: 'done' };
      },
    });
    const first = request('11111111-1111-4111-8111-111111111111');
    const second = request('22222222-2222-4222-8222-222222222222');
    const third = request('33333333-3333-4333-8333-333333333333');

    await instance.processInbound(first);
    const queued = await instance.processInbound(second);
    const busy = await instance.processInbound(third);

    expect(queued).toMatchObject({ result: { state: 'queued' } });
    expect(busy).toMatchObject({ error: { code: 'busy', retryable: true } });
    expect(instance.dedupeStore.inspect(third).kind).toBe('new');
    releaseFirst();
  });

  it('checks authentication before deduplication lookup', async () => {
    const authenticator: BindingAuthenticator = {
      authenticate: vi.fn(async () => ({ authenticated: false as const })),
    };
    const dedupe = new RuntimeScopedDedupeStore<OperationResponse, RequestId>({ now: () => NOW });
    const inspect = vi.spyOn(dedupe, 'inspect');
    const instance = router({ authenticator, dedupeStore: dedupe });

    const response = await instance.processInbound(
      request('11111111-1111-4111-8111-111111111111'),
      { credential: 'invalid' },
    );

    expect(response).toMatchObject({ error: { code: 'unauthorized' } });
    expect(inspect).not.toHaveBeenCalled();
  });

  it('projects peer capabilities independently and does not create a task', async () => {
    const instance = router();
    const describeEnvelope = { ...request('11111111-1111-4111-8111-111111111111') } as Record<
      string,
      unknown
    >;
    delete describeEnvelope.requestId;
    describeEnvelope.operation = 'peer.describe';
    describeEnvelope.expiresAt = new Date(NOW + 30_000).toISOString();
    describeEnvelope.payload = {};

    const response = await instance.processInbound(describeEnvelope);

    expect(response).toMatchObject({
      operation: 'peer.describe',
      result: {
        capabilities: {
          supportedWireVersions: ['1.0'],
          limits: { maxQueueEntries: 32 },
        },
      },
    });
    expect(instance.taskStore.size).toBe(0);
  });

  it('cancels an admitted task idempotently and replays the cancellation acknowledgement', async () => {
    const instance = router();
    const original = request('11111111-1111-4111-8111-111111111111');
    const originalRequestId = asUuidV4('11111111-1111-4111-8111-111111111111');
    await instance.processInbound(original);
    const cancel = {
      ...request('22222222-2222-4222-8222-222222222222'),
      operation: 'task.cancel',
      requestId: originalRequestId,
      expiresAt: asUtcTimestamp(new Date(NOW + 30_000).toISOString()),
      payload: { reason: 'stop' },
    } as ProtocolEnvelope;

    const first = await instance.processInbound(cancel);
    const retry = await instance.processInbound(cancel);

    expect(first).toMatchObject({ result: { snapshot: { state: 'cancelled' } } });
    expect(retry).toEqual(first);
    expect(instance.taskStore.getTask(originalRequestId)).toMatchObject({
      state: 'cancelled',
      cancellationRequested: true,
    });
  });

  it('rejects a wrong-runtime reply without disclosing or mutating the task', async () => {
    const requestId = asUuidV4('11111111-1111-4111-8111-111111111111');
    const store = new TaskStore({ now: () => NOW, monotonicNow: () => NOW });
    store.createTask({
      requestId,
      requester: { runtimeId: asRuntimeId('runtime-a') },
      localOwner: { runtimeId: asRuntimeId('runtime-a') },
      expectedTargetRuntimeId: asRuntimeId('runtime-c'),
      ownership: 'outbound',
      createdAt: NOW,
      expiresAt: NOW + 60_000,
      initialState: 'created',
    });
    const instance = router({ taskStore: store });
    const reply = {
      ...request('22222222-2222-4222-8222-222222222222', 'runtime-c'),
      operation: 'message.reply',
      requestId,
      payload: { outcome: 'completed', content: { type: 'text', text: 'late' } },
    } as ProtocolEnvelope;

    const response = await instance.processInbound(reply, { senderRuntimeId: 'runtime-c' });

    expect(response).toMatchObject({ error: { code: 'unauthorized' } });
    expect(store.getTask(requestId)).toMatchObject({ state: 'created' });
  });

  it('applies an explicitly correlated reply and retains the terminal snapshot', async () => {
    const requestId = asUuidV4('11111111-1111-4111-8111-111111111111');
    const store = new TaskStore({ now: () => NOW, monotonicNow: () => NOW });
    store.createTask({
      requestId,
      requester: { runtimeId: asRuntimeId('runtime-b') },
      localOwner: { runtimeId: asRuntimeId('runtime-b') },
      expectedTargetRuntimeId: asRuntimeId('runtime-a'),
      ownership: 'outbound',
      createdAt: NOW,
      expiresAt: NOW + 60_000,
    });
    const instance = router({ taskStore: store });
    const reply = {
      ...request('22222222-2222-4222-8222-222222222222', 'runtime-a'),
      operation: 'message.reply',
      requestId,
      payload: { outcome: 'completed', content: { type: 'text', text: 'done' } },
    } as ProtocolEnvelope;

    const response = await instance.processInbound(reply, { senderRuntimeId: 'runtime-a' });

    expect(response).toMatchObject({
      operation: 'message.reply',
      result: { requestId, outcome: 'completed', delivered: true },
    });
    expect(store.getTask(requestId)).toMatchObject({ state: 'completed' });
  });

  it('returns unauthorized status for an existing task owned by another runtime', async () => {
    const requestId = asUuidV4('11111111-1111-4111-8111-111111111111');
    const store = new TaskStore({ now: () => NOW, monotonicNow: () => NOW });
    store.createTask({
      requestId,
      requester: { runtimeId: asRuntimeId('runtime-a') },
      localOwner: { runtimeId: asRuntimeId('runtime-b') },
      createdAt: NOW,
      expiresAt: NOW + 30_000,
    });
    const instance = router({ taskStore: store });
    const status = {
      ...request('22222222-2222-4222-8222-222222222222', 'runtime-c'),
      operation: 'task.status',
      requestId,
      expiresAt: asUtcTimestamp(new Date(NOW + 30_000).toISOString()),
      payload: {},
    } as ProtocolEnvelope;

    const response = await instance.processInbound(status);

    expect(response).toMatchObject({ error: { code: 'unauthorized' } });
  });

  it('maps notification delivery to an acknowledgement without creating a task', async () => {
    const handler = vi.fn();
    const instance = router({ onNotification: handler });
    const notify = { ...request('11111111-1111-4111-8111-111111111111') } as Record<
      string,
      unknown
    >;
    delete notify.requestId;
    notify.operation = 'message.notify';
    notify.payload = { content: { type: 'text', text: 'notice' } };

    const response = await instance.processInbound(notify);

    expect(response).toMatchObject({ result: { delivered: true } });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(instance.taskStore.size).toBe(0);
  });

  it('keeps invalid structured replies nonterminal', async () => {
    const requestId = asUuidV4('11111111-1111-4111-8111-111111111111');
    const store = new TaskStore({ now: () => NOW, monotonicNow: () => NOW });
    store.createTask({
      requestId,
      requester: { runtimeId: asRuntimeId('runtime-b') },
      localOwner: { runtimeId: asRuntimeId('runtime-b') },
      expectedTargetRuntimeId: asRuntimeId('runtime-a'),
      responseContract: {
        contentType: 'json',
        schema: { type: 'object', required: ['ok'] },
      },
      ownership: 'outbound',
      createdAt: NOW,
      expiresAt: NOW + 60_000,
      initialState: 'created',
    });
    const instance = router({ taskStore: store });
    const reply = {
      ...request('22222222-2222-4222-8222-222222222222', 'runtime-a'),
      operation: 'message.reply',
      requestId,
      payload: { outcome: 'completed', content: { type: 'json', value: { wrong: true } } },
    } as ProtocolEnvelope;

    const response = await instance.processInbound(reply, { senderRuntimeId: 'runtime-a' });

    expect(response).toMatchObject({ error: { code: 'invalid_reply' } });
    expect(store.getTask(requestId)).toMatchObject({ state: 'created' });
    expect(createProtocolError('invalid_reply', 'test').retryable).toBe(false);
  });

  it('correlates outbound admission and fast terminal replies by logical request ID', async () => {
    const peers = new Map<string, MessageRouter>();
    const createPeer = (
      runtimeId: 'runtime-a' | 'runtime-b',
      requestExecutor?: RouterOptions['requestExecutor'],
    ): MessageRouter => {
      const instance = new MessageRouter({
        identity: { sessionId: `session-${runtimeId}`, runtimeId },
        roomId: ROOM,
        now: () => NOW,
        monotonicNow: () => NOW,
        requestExecutor,
        delivery: {
          send: async (envelope) => {
            const peer = peers.get(envelope.recipientRuntimeId);
            if (peer === undefined) {
              return {
                delivered: false,
                error: createProtocolError('unreachable', 'peer is not available'),
              };
            }
            const response = await peer.processInbound(envelope, {
              senderRuntimeId: envelope.sender.runtimeId,
              localRuntimeId: peer.runtimeId,
              roomId: peer.roomId,
            });
            await instance.processResponse(response);
            return { delivered: true };
          },
        },
      });
      peers.set(runtimeId, instance);
      return instance;
    };

    const sender = createPeer('runtime-a');
    createPeer('runtime-b', async () => ({ type: 'text', text: 'reply' }));
    const handle = await sender.createRequest({
      recipientRuntimeId: 'runtime-b',
      content: { type: 'text', text: 'request' },
    });

    await expect(handle.admission).resolves.toMatchObject({
      result: { requestId: handle.requestId, state: 'accepted' },
    });
    await expect(handle.completion).resolves.toMatchObject({
      requestId: handle.requestId,
      state: 'completed',
      content: { type: 'text', text: 'reply' },
    });
  });

  it('keeps concurrent outbound requests correlated when acknowledgements arrive in reverse order', async () => {
    const delayedResponses: OperationResponse[] = [];
    const receiver = new MessageRouter({
      identity: { sessionId: 'session-b', runtimeId: 'runtime-b' },
      roomId: ROOM,
      now: () => NOW,
      monotonicNow: () => NOW,
    });
    const sender = new MessageRouter({
      identity: { sessionId: 'session-a', runtimeId: 'runtime-a' },
      roomId: ROOM,
      now: () => NOW,
      monotonicNow: () => NOW,
      delivery: {
        send: async (envelope) => {
          delayedResponses.push(
            await receiver.processInbound(envelope, {
              senderRuntimeId: envelope.sender.runtimeId,
              localRuntimeId: receiver.runtimeId,
              roomId: receiver.roomId,
            }),
          );
          return { delivered: true };
        },
      },
    });

    const first = await sender.createRequest({
      recipientRuntimeId: 'runtime-b',
      content: { type: 'text', text: 'first' },
    });
    const second = await sender.createRequest({
      recipientRuntimeId: 'runtime-b',
      content: { type: 'text', text: 'nested' },
      parentOperationId: first.operationId,
    });

    await vi.waitFor(() => expect(delayedResponses).toHaveLength(2));
    await sender.processResponse(delayedResponses[1]);
    await sender.processResponse(delayedResponses[0]);

    await expect(first.admission).resolves.toMatchObject({
      result: { requestId: first.requestId, state: 'accepted' },
    });
    await expect(second.admission).resolves.toMatchObject({
      result: { requestId: second.requestId, state: 'accepted' },
    });
    expect(second.envelope.parentOperationId).toBe(first.operationId);
    expect(sender.taskStore.getTask(first.requestId)).toMatchObject({ state: 'accepted' });
    expect(sender.taskStore.getTask(second.requestId)).toMatchObject({ state: 'accepted' });
  });
});
