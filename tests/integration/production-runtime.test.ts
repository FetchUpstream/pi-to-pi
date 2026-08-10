import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { resolveP2PConfig } from '../../src/config.js';
import { createRuntimeIdentity } from '../../src/identity.js';
import { resolveRoom } from '../../src/room.js';
import { PiToPiRuntimeComposition } from '../../src/runtime/composition.js';

const roots: string[] = [];

async function createRuntime(
  sessionId: string,
  rootDirectory: string,
  project = 'production-runtime-tests',
) {
  return new PiToPiRuntimeComposition({
    identity: createRuntimeIdentity(sessionId),
    room: resolveRoom({ project, cwd: process.cwd() }),
    config: resolveP2PConfig({ sessionName: sessionId }),
    generation: 1,
    registryOptions: { rootDirectory, renewalIntervalMs: 60_000 },
  });
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('production runtime composition', () => {
  it('discovers a bound peer and correlates its synchronous request admission over local IPC', async () => {
    const rootDirectory = await mkdtemp(join(tmpdir(), 'pi-to-pi-production-'));
    roots.push(rootDirectory);
    const recipient = await createRuntime('recipient-session', rootDirectory);
    const sender = await createRuntime('sender-session', rootDirectory);

    try {
      await recipient.start();
      await sender.start();
      const peers = await sender.adapter.listPeers();
      expect(peers.peers).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            displayName: 'recipient-session',
            publishedTarget: expect.any(String),
          }),
        ]),
      );
      expect(JSON.stringify(peers)).not.toContain(recipient.endpoint);

      const target = peers.peers[0]?.publishedTarget;
      if (target === undefined) throw new Error('peer target was not published');
      const request = await sender.adapter.send(target, { type: 'text', text: 'hello' });
      await expect(request).toMatchObject({ targetRuntimeId: recipient.identity.runtimeId });
      expect(request.admission).toMatchObject({ result: { state: 'accepted' } });
      expect(recipient.router.taskSnapshot(request.requestId)).toMatchObject({ state: 'working' });
    } finally {
      await sender.shutdown();
      await recipient.shutdown();
    }
  });
  it('delivers explicit replies and correlates concurrent requests independently', async () => {
    const rootDirectory = await mkdtemp(join(tmpdir(), 'pi-to-pi-production-'));
    roots.push(rootDirectory);
    const recipient = await createRuntime('recipient-session', rootDirectory);
    const sender = await createRuntime('sender-session', rootDirectory);
    try {
      await recipient.start();
      await sender.start();
      const first = await sender.router.createRequest({
        recipientRuntimeId: recipient.identity.runtimeId,
        content: { type: 'text', text: 'first' },
      });
      const second = await sender.router.createRequest({
        recipientRuntimeId: recipient.identity.runtimeId,
        content: { type: 'text', text: 'second' },
      });
      await Promise.all([first.admission, second.admission]);

      expect(
        recipient.router.completeTask(second.requestId, { type: 'text', text: 'second reply' }),
      ).toBeDefined();
      expect(
        recipient.router.completeTask(first.requestId, { type: 'text', text: 'first reply' }),
      ).toBeDefined();
      await expect(second.completion).resolves.toMatchObject({ state: 'completed' });
      await expect(first.completion).resolves.toMatchObject({ state: 'completed' });
    } finally {
      await sender.shutdown();
      await recipient.shutdown();
    }
  });
  it('isolates discovery across rooms', async () => {
    const rootDirectory = await mkdtemp(join(tmpdir(), 'pi-to-pi-production-'));
    roots.push(rootDirectory);
    const alpha = await createRuntime('alpha-session', rootDirectory, 'alpha-room');
    const beta = await createRuntime('beta-session', rootDirectory, 'beta-room');
    try {
      await alpha.start();
      await beta.start();
      await expect(
        alpha.registry.lookupPeerByRuntimeId(beta.identity.runtimeId),
      ).resolves.toMatchObject({
        kind: 'not-found',
      });
      await expect(
        beta.registry.lookupPeerByRuntimeId(alpha.identity.runtimeId),
      ).resolves.toMatchObject({
        kind: 'not-found',
      });
    } finally {
      await alpha.shutdown();
      await beta.shutdown();
    }
  });

  it('rejects same-name ambiguity across three live peers', async () => {
    const rootDirectory = await mkdtemp(join(tmpdir(), 'pi-to-pi-production-'));
    roots.push(rootDirectory);
    const sender = await createRuntime('sender-session', rootDirectory);
    const first = await createRuntime('same-name', rootDirectory);
    const second = await createRuntime('same-name', rootDirectory);
    try {
      await Promise.all([sender.start(), first.start(), second.start()]);
      const peers = await sender.adapter.listPeers();
      expect(peers.peers.filter((peer) => peer.displayName === 'same-name')).toHaveLength(2);
      expect(peers.peers.filter((peer) => peer.runtimeId !== undefined)).toHaveLength(2);
    } finally {
      await Promise.all([sender.shutdown(), first.shutdown(), second.shutdown()]);
    }
  });

  it('rejects malformed and unavailable deliveries without leaving the sender pending', async () => {
    const rootDirectory = await mkdtemp(join(tmpdir(), 'pi-to-pi-production-'));
    roots.push(rootDirectory);
    const runtime = await createRuntime('sender-session', rootDirectory);
    try {
      await runtime.start();
      await expect(runtime.bridge.handle(new Uint8Array([0xff]))).rejects.toThrow(
        'protocol payload is malformed',
      );
      const result = await runtime.bridge.send({
        protocolVersion: '1.0',
        operation: 'peer.describe',
        operationId: '11111111-1111-4111-8111-111111111111',
        sender: { sessionId: runtime.identity.sessionId, runtimeId: runtime.identity.runtimeId },
        recipientRuntimeId: '22222222-2222-4222-8222-222222222222',
        roomId: runtime.room.roomId,
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 1_000).toISOString(),
        traceId: 'a'.repeat(32),
        payload: {},
      } as never);
      expect(result).toMatchObject({ delivered: false, error: { code: 'unreachable' } });
    } finally {
      await runtime.shutdown();
    }
  });
});
