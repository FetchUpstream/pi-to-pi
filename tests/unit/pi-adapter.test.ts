import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { AgentCardRegistry } from '../../src/discovery/agent-card-registry.js';
import { PiAdapter, registerPiTools } from '../../src/pi/adapter.js';
import { MessageRouter } from '../../src/router/router.js';

const ROOM_ID = `r1-${'a'.repeat(32)}`;
const RUNTIME_ID = '11111111-1111-4111-8111-111111111111';
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function registry(): Promise<AgentCardRegistry> {
  const rootDirectory = await mkdtemp(join(tmpdir(), 'pi-to-pi-adapter-'));
  roots.push(rootDirectory);
  const instance = new AgentCardRegistry({
    rootDirectory,
    room: { roomId: ROOM_ID, storageKey: 'adapter-room' },
    runtimeId: RUNTIME_ID,
    sessionId: 'session-a',
    displayName: 'planner',
    endpoint: { kind: 'unix', address: '/tmp/pi-to-pi-adapter' },
  });
  await instance.start();
  return instance;
}

describe('PiAdapter', () => {
  it('uses the production registry for peer output and registers only communication tools', async () => {
    const peers = await registry();
    const router = new MessageRouter({
      runtimeId: RUNTIME_ID,
      sessionId: 'session-a',
      roomId: ROOM_ID,
    });
    const adapter = new PiAdapter({ router, peers });
    const registerTool = vi.fn();

    registerPiTools({ registerTool } as never, adapter);

    expect(registerTool.mock.calls.map(([tool]) => tool.name)).toEqual([
      'p2p_peers',
      'p2p_send',
      'p2p_reply',
      'p2p_report_issue',
      'p2p_status',
    ]);
    await expect(adapter.listPeers()).resolves.toMatchObject([
      { displayName: 'planner', runtimeId: RUNTIME_ID },
    ]);
  });

  it('suppresses an inbound task whose cancellation signal is already aborted', async () => {
    const peers = await registry();
    const adapter = new PiAdapter({
      peers,
      router: new MessageRouter({ runtimeId: RUNTIME_ID, sessionId: 'session-a', roomId: ROOM_ID }),
    });
    const sendMessage = vi.fn();
    adapter.bind({ sendMessage, isIdle: () => true });
    const controller = new AbortController();
    controller.abort();

    await adapter.taskExecutor({ signal: controller.signal } as never);

    expect(sendMessage).not.toHaveBeenCalled();
  });
  it('uses triggered idle delivery and steer while busy', async () => {
    const peers = await registry();
    const adapter = new PiAdapter({
      peers,
      router: new MessageRouter({ runtimeId: RUNTIME_ID, sessionId: 'session-a', roomId: ROOM_ID }),
    });
    const sendMessage = vi.fn();
    const context = {
      requestId: '33333333-3333-4333-8333-333333333333',
      signal: new AbortController().signal,
      request: {
        sender: { runtimeId: '22222222-2222-4222-8222-222222222222' },
        traceId: 'a'.repeat(32),
        payload: { content: { type: 'text', text: 'hello' } },
      },
      snapshot: { state: 'working', expiresAt: '2026-01-01T00:01:00.000Z' },
    };

    adapter.bind({ sendMessage, isIdle: () => true });
    await adapter.taskExecutor(context as never);
    adapter.bind({ sendMessage, isIdle: () => false });
    await adapter.taskExecutor({
      ...context,
      requestId: '44444444-4444-4444-8444-444444444444',
    } as never);

    expect(sendMessage).toHaveBeenNthCalledWith(1, expect.any(Object), { triggerTurn: true });
    expect(sendMessage).toHaveBeenNthCalledWith(2, expect.any(Object), { deliverAs: 'steer' });
  });
});
