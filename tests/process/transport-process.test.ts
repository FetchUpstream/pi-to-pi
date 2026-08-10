import { EventEmitter } from 'node:events';
import { access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { Socket } from 'node:net';

import { describe, expect, it } from 'vitest';

import { createIpcEndpoint } from '../../src/transport/endpoint.js';
import { LocalIpcTransport, removeStalePosixEndpoint } from '../../src/transport/index.js';
import {
  createManagedProcessGroup,
  type ManagedProcess,
  withTestWorkspace,
} from '../support/index.js';

const FIXTURE_PATH = fileURLToPath(new URL('../fixtures/transport-process.mjs', import.meta.url));
const PROCESS_TIMEOUT_MS = 5_000;

type TransportProcessEvent = {
  readonly event?: string;
  readonly id?: string | number | null;
  readonly payload?: string;
  readonly message?: string;
  readonly [key: string]: unknown;
};

function encoded(payload: Uint8Array): string {
  return Buffer.from(payload).toString('base64');
}

class BareCloseSocket extends EventEmitter {
  destroyed = false;

  public constructor() {
    super();
    queueMicrotask(() => this.emit('close', false));
  }

  public destroy(): this {
    if (!this.destroyed) {
      this.destroyed = true;
      this.emit('close', false);
    }
    return this;
  }
}

class HangingProbeSocket extends EventEmitter {
  destroyed = false;

  public destroy(): this {
    this.destroyed = true;
    return this;
  }
}
async function endpointExists(endpoint: string): Promise<boolean> {
  try {
    await access(endpoint);
    return true;
  } catch {
    return false;
  }
}

async function waitForResponse(
  client: ManagedProcess<TransportProcessEvent>,
  id: string,
): Promise<TransportProcessEvent> {
  return client.waitForEvent(
    (event: TransportProcessEvent) => event.event === 'response' && event.id === id,
    { description: `response ${id}`, timeoutMs: PROCESS_TIMEOUT_MS },
  );
}

describe('production local IPC process boundaries', () => {
  it(
    'exchanges multiple opaque frames between two managed processes and tears down cleanly',
    async () => {
      await withTestWorkspace(async (workspace) => {
        const endpoint = createIpcEndpoint();
        const group = createManagedProcessGroup({ workspace });
        const server = group.spawn<TransportProcessEvent>({
          fixturePath: FIXTURE_PATH,
          args: ['server', endpoint],
          label: 'transport server',
        });
        const client = group.spawn<TransportProcessEvent>({
          fixturePath: FIXTURE_PATH,
          args: ['client', endpoint],
          label: 'transport client',
        });

        try {
          await Promise.all([server.waitForReady(), client.waitForReady()]);
          const payloads = [Buffer.from([0, 1, 0xff]), Buffer.from('second'), Buffer.from('third')];
          for (const [index, payload] of payloads.entries()) {
            const id = `exchange-${index}`;
            await client.sendCommand({ command: 'request', id, payload: encoded(payload) });
            const response = await waitForResponse(client, id);
            expect(Buffer.from(response.payload ?? '', 'base64')).toEqual(
              Buffer.from(payload).reverse(),
            );
          }

          await Promise.all([
            client.sendCommand({ command: 'shutdown' }),
            server.sendCommand({ command: 'shutdown' }),
          ]);
          await Promise.all([client.waitForClose(), server.waitForClose()]);
          expect(await endpointExists(endpoint)).toBe(false);
        } finally {
          await group.cleanup();
        }
      });
    },
    PROCESS_TIMEOUT_MS * 2,
  );

  it(
    'keeps concurrent multi-process responses associated despite varied response timing',
    async () => {
      await withTestWorkspace(async (workspace) => {
        const endpoint = createIpcEndpoint();
        const group = createManagedProcessGroup({ workspace });
        const server = group.spawn<TransportProcessEvent>({
          fixturePath: FIXTURE_PATH,
          args: ['server', endpoint],
          label: 'timing server',
        });
        const client = group.spawn<TransportProcessEvent>({
          fixturePath: FIXTURE_PATH,
          args: ['client', endpoint],
          label: 'timing client',
        });

        try {
          await Promise.all([server.waitForReady(), client.waitForReady()]);
          const payloads = ['drip:a', 'drip:bbbb', 'drip:cc', 'drip:dddddd'];
          await Promise.all(
            payloads.map(async (value, index) => {
              const id = `timing-${index}`;
              await client.sendCommand({
                command: 'request',
                id,
                payload: encoded(Buffer.from(value)),
              });
              const response = await waitForResponse(client, id);
              expect(Buffer.from(response.payload ?? '', 'base64').toString()).toBe(value.slice(5));
            }),
          );
        } finally {
          await group.cleanup();
        }
      });
    },
    PROCESS_TIMEOUT_MS * 2,
  );

  it(
    'bounds silent, slow-drip header/body, malformed, truncated, oversized, peer-exit, and caller-abort process cases',
    async () => {
      await withTestWorkspace(async (workspace) => {
        const endpoint = createIpcEndpoint();
        const group = createManagedProcessGroup({ workspace });
        const server = group.spawn<TransportProcessEvent>({
          fixturePath: FIXTURE_PATH,
          args: ['server', endpoint],
          label: 'failure server',
        });
        const client = group.spawn<TransportProcessEvent>({
          fixturePath: FIXTURE_PATH,
          args: ['client', endpoint],
          label: 'failure client',
        });

        try {
          await Promise.all([server.waitForReady(), client.waitForReady()]);
          for (const [index, value] of [
            'silent',
            'drip-header',
            'drip-body',
            'malformed-response',
            'truncated-response',
            'oversized-response',
          ].entries()) {
            const id = `failure-${index}`;
            await client.sendCommand({
              command: 'request',
              id,
              payload: encoded(Buffer.from(value)),
              timeoutMs: value.startsWith('drip-') ? 60 : 100,
            });
            const error = await client.waitForEvent(
              (event: TransportProcessEvent) => event.event === 'request-error' && event.id === id,
              { description: `bounded error ${id}`, timeoutMs: PROCESS_TIMEOUT_MS },
            );
            expect(error.message).toBeTruthy();
          }

          for (const [index, payload] of [
            Buffer.from([0, 0, 0, 0, 0]),
            Buffer.from([0, 0, 0, 4, 0x7b]),
            Buffer.from([0xff, 0xff, 0xff, 0xff]),
          ].entries()) {
            const id = `raw-failure-${index}`;
            await client.sendCommand({
              command: 'request',
              id,
              payload: encoded(payload),
              raw: true,
              timeoutMs: 100,
            });
            const error = await client.waitForEvent(
              (event: TransportProcessEvent) => event.event === 'request-error' && event.id === id,
              { description: `raw bounded error ${id}`, timeoutMs: PROCESS_TIMEOUT_MS },
            );
            expect(error.message).toBeTruthy();
          }
          const abortId = 'caller-abort';
          await client.sendCommand({
            command: 'request',
            id: abortId,
            payload: encoded(Buffer.from('silent')),
            timeoutMs: 500,
            abortAfterMs: 20,
          });
          await client.waitForEvent(
            (event: TransportProcessEvent) =>
              event.event === 'request-error' && event.id === abortId,
            { description: 'caller abort', timeoutMs: PROCESS_TIMEOUT_MS },
          );

          await server.killAbruptly({ timeoutMs: PROCESS_TIMEOUT_MS });
          const peerExitId = 'peer-exit';
          await client.sendCommand({
            command: 'request',
            id: peerExitId,
            payload: encoded(Buffer.from('after-peer-exit')),
            timeoutMs: 100,
          });
          await client.waitForEvent(
            (event: TransportProcessEvent) =>
              event.event === 'request-error' && event.id === peerExitId,
            { description: 'peer exit', timeoutMs: PROCESS_TIMEOUT_MS },
          );
        } finally {
          await group.cleanup();
        }
      });
    },
    PROCESS_TIMEOUT_MS * 3,
  );

  it(
    'proves stale and live generated endpoint ownership without blind replacement',
    async () => {
      if (process.platform === 'win32') {
        expect(createIpcEndpoint({ platform: 'win32' })).toMatch(/^\\\\\?\\pipe\\/u);
        return;
      }

      const endpoint = createIpcEndpoint();
      await withTestWorkspace(async (workspace) => {
        const group = createManagedProcessGroup({ workspace });
        const owner = group.spawn<TransportProcessEvent>({
          fixturePath: FIXTURE_PATH,
          args: ['server', endpoint],
          label: 'stale owner',
        });
        const contender = new LocalIpcTransport();
        const replacement = new LocalIpcTransport();
        try {
          await owner.waitForReady();
          await expect(contender.bind(endpoint, (payload) => payload)).rejects.toMatchObject({
            code: 'endpoint-in-use',
          });
          expect(await endpointExists(endpoint)).toBe(true);

          await owner.killAbruptly({ timeoutMs: PROCESS_TIMEOUT_MS });
          expect(await endpointExists(endpoint)).toBe(true);
          await expect(
            removeStalePosixEndpoint(
              endpoint,
              100,
              () => new BareCloseSocket() as unknown as Socket,
            ),
          ).resolves.toBe(false);
          expect(await endpointExists(endpoint)).toBe(true);
          await expect(
            removeStalePosixEndpoint(
              endpoint,
              50,
              () => new HangingProbeSocket() as unknown as Socket,
            ),
          ).resolves.toBe(false);
          expect(await endpointExists(endpoint)).toBe(true);

          await replacement.bind(endpoint, (payload) => payload);
        } finally {
          await Promise.allSettled([contender.close(), replacement.close()]);
          await group.cleanup();
        }
      });
    },
    PROCESS_TIMEOUT_MS * 3,
  );
});
