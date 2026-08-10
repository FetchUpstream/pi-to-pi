import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  ExtensionAPI,
  ExtensionContext,
  SessionStartEvent,
} from '@earendil-works/pi-coding-agent';

import registerPiToPi, { createPiToPiLifecycle } from '../../src/index.js';

const roots: string[] = [];

async function root(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), 'pi-to-pi-runtime-'));
  roots.push(value);
  return value;
}

function context(sessionId = 'native-session-id', name = 'Planner'): ExtensionContext {
  return {
    cwd: process.cwd(),
    isIdle: () => true,
    sessionManager: { getSessionId: () => sessionId, getSessionName: () => name },
  } as unknown as ExtensionContext;
}

const start = { type: 'session_start', reason: 'startup' } as SessionStartEvent;
const shutdown = { type: 'session_shutdown', reason: 'quit' } as const;

afterEach(async () => {
  await Promise.all(roots.splice(0).map((value) => rm(value, { recursive: true, force: true })));
});

describe('production runtime composition', () => {
  it('is side-effect free until session_start, then binds before publishing a canonical card', async () => {
    const registryRoot = await root();
    const lifecycle = createPiToPiLifecycle(
      { getFlag: () => undefined },
      { registryOptions: { rootDirectory: registryRoot, renewalIntervalMs: 60_000 } },
    );

    expect(lifecycle.current()).toBeUndefined();
    await lifecycle.onSessionStart(start, context());
    const runtime = lifecycle.current();
    const card = runtime?.composition.registry.current();
    expect(runtime?.endpoint).not.toMatch(/^unbound:/u);
    expect(card).toMatchObject({
      sessionId: 'native-session-id',
      runtimeInstanceId: runtime?.identity.runtimeId,
      roomId: runtime?.room.roomId,
      endpoint: { address: runtime?.endpoint },
    });
    expect(card?.capabilities.maxMessageSize).toBeLessThanOrEqual(1024 * 1024);

    await lifecycle.onSessionShutdown(shutdown, context());
    expect(lifecycle.current()).toBeUndefined();
  });

  it('replaces and shuts down only the outgoing generation', async () => {
    const registryRoot = await root();
    const lifecycle = createPiToPiLifecycle(
      { getFlag: () => undefined },
      { registryOptions: { rootDirectory: registryRoot, renewalIntervalMs: 60_000 } },
    );
    await lifecycle.onSessionStart(start, context('stable-session'));
    const first = lifecycle.current();
    await lifecycle.onSessionStart(start, context('stable-session'));
    const second = lifecycle.current();

    expect(second?.identity.runtimeId).not.toBe(first?.identity.runtimeId);
    expect(first?.composition.registry.current()).toBeUndefined();
    expect(second?.composition.registry.current()).toBeDefined();
    await lifecycle.onSessionShutdown(shutdown, context('stable-session'));
    await lifecycle.onSessionShutdown(shutdown, context('stable-session'));
  });

  it('registers self-wired communication tools once during default extension evaluation', async () => {
    const handlers = new Map<string, unknown>();
    const registerTool = vi.fn<(tool: { name: string }) => void>();
    const on = vi.fn((name: string, handler: unknown) => handlers.set(name, handler));
    const pi = {
      getFlag: () => undefined,
      registerFlag: vi.fn(),
      registerTool,
      on,
      sendMessage: vi.fn(),
    } as unknown as ExtensionAPI;

    registerPiToPi(pi, { registryOptions: { rootDirectory: await root() } });
    expect(registerTool.mock.calls.map(([tool]) => tool.name)).toEqual([
      'p2p_peers',
      'p2p_send',
      'p2p_reply',
      'p2p_report_issue',
      'p2p_status',
    ]);
    expect(handlers.get('session_start')).toEqual(expect.any(Function));
  });
});
