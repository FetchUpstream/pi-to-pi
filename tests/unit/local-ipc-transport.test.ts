import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import { createConnection, createServer } from 'node:net';
import type { Server, Socket } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import {
  AbortError,
  FrameDecoder,
  PhaseDeadlineExceededError,
  TransportError,
  createIpcEndpoint,
  isWindowsPipeEndpoint,
  encodeFrame,
  LocalIpcTransport,
} from '../../src/transport/index.js';

const transports: LocalIpcTransport[] = [];
const servers: Server[] = [];

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

class BackpressureSocket extends EventEmitter {
  destroyed = false;

  constructor() {
    super();
    queueMicrotask(() => this.emit('connect'));
  }

  write(_chunk: Uint8Array, callback: () => void): boolean {
    queueMicrotask(() => {
      callback();
      this.emit('drain');
      setImmediate(() => this.emit('data', encodeFrame(Buffer.from('fake-response'))));
    });
    return false;
  }

  end(callback?: () => void): this {
    queueMicrotask(() => callback?.());
    return this;
  }

  destroy(): this {
    if (!this.destroyed) {
      this.destroyed = true;
      queueMicrotask(() => this.emit('close', false));
    }
    return this;
  }
}

async function listen(server: Server, endpoint: string): Promise<void> {
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off('error', onError);
      reject(error);
    };
    server.once('error', onError);
    server.listen(endpoint, () => {
      server.off('error', onError);
      resolve();
    });
  });
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) {
    return;
  }
  await new Promise<void>((resolve, reject) => {
    server.close((error?: Error) => (error === undefined ? resolve() : reject(error)));
  });
}

async function endpointExists(endpoint: string): Promise<boolean> {
  try {
    await fs.lstat(endpoint);
    return true;
  } catch (error: unknown) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

async function rawExchange(endpoint: string, chunks: readonly Buffer[]): Promise<Buffer> {
  const socket = createConnection(endpoint);
  const decoder = new FrameDecoder();
  let response: Buffer | undefined;
  let settled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  return new Promise<Buffer>((resolve, reject) => {
    const cleanup = (): void => {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      socket.off('connect', onConnect);
      socket.off('data', onData);
      socket.off('error', onError);
      socket.off('close', onClose);
    };
    const settle = (callback: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      callback();
    };
    const onConnect = async (): Promise<void> => {
      try {
        for (const chunk of chunks) {
          socket.write(chunk);
          await new Promise<void>((turn) => setImmediate(turn));
        }
        socket.end();
      } catch (error: unknown) {
        settle(() => reject(error));
      }
    };
    const onData = (chunk: Buffer): void => {
      try {
        const value = decoder.push(chunk);
        if (value !== undefined) {
          response = value;
        }
      } catch (error: unknown) {
        settle(() => reject(error));
      }
    };
    const onError = (error: Error): void => {
      if (response === undefined) {
        settle(() => reject(error));
      }
    };
    const onClose = (): void => {
      if (response !== undefined) {
        settle(() => resolve(response as Buffer));
      } else {
        settle(() => reject(new Error('raw exchange closed without a response')));
      }
    };

    timer = setTimeout(() => {
      socket.destroy();
      settle(() => reject(new Error('raw exchange timed out')));
    }, 2_000);
    socket.once('connect', onConnect);
    socket.on('data', onData);
    socket.once('error', onError);
    socket.once('close', onClose);
  }).finally(() => {
    socket.destroy();
  });
}

async function sendAndWaitForClose(endpoint: string, bytes: Buffer): Promise<boolean> {
  const socket = createConnection(endpoint);
  let receivedData = false;
  return new Promise<boolean>((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('malformed frame was not closed'));
    }, 2_000);
    socket.once('connect', () => socket.end(bytes));
    socket.on('data', () => {
      receivedData = true;
    });
    socket.once('error', () => undefined);
    socket.once('close', () => {
      clearTimeout(timer);
      resolve(receivedData);
    });
  }).finally(() => {
    socket.destroy();
  });
}

afterEach(async () => {
  await Promise.allSettled(transports.splice(0).map((transport) => transport.close()));
  await Promise.allSettled(servers.splice(0).map((server) => closeServer(server)));
});

describe('production local IPC transport', () => {
  it('binds a native endpoint, exchanges opaque bytes, handles split frames, and closes', async () => {
    const endpoint = createIpcEndpoint();
    const received: Buffer[] = [];
    const transport = new LocalIpcTransport();
    transports.push(transport);
    await transport.bind(endpoint, (payload) => {
      received.push(Buffer.from(payload));
      return Buffer.concat([Buffer.from([0xff]), Buffer.from(payload).reverse()]);
    });

    const payload = Buffer.from([0, 1, 2, 0xff, 0x00]);
    await expect(
      rawExchange(endpoint, [
        encodeFrame(payload).subarray(0, 1),
        encodeFrame(payload).subarray(1, 5),
        encodeFrame(payload).subarray(5),
      ]),
    ).resolves.toEqual(Buffer.concat([Buffer.from([0xff]), Buffer.from(payload).reverse()]));
    expect(received).toEqual([payload]);

    await transport.close();
    expect(await endpointExists(endpoint)).toBe(false);
    await expect(transport.close()).resolves.toBeUndefined();
  });

  it('associates concurrent responses with their independent connections', async () => {
    const endpoint = createIpcEndpoint();
    const transport = new LocalIpcTransport();
    transports.push(transport);
    await transport.bind(endpoint, async (payload) => {
      const id = Number(Buffer.from(payload).toString('utf8'));
      await delay((5 - id) * 5);
      return Buffer.from(`response-${id}`);
    });

    const responses = await Promise.all(
      Array.from({ length: 6 }, (_, id) => transport.request(endpoint, Buffer.from(String(id)))),
    );
    expect(responses.map((response) => Buffer.from(response).toString('utf8'))).toEqual(
      Array.from({ length: 6 }, (_, id) => `response-${id}`),
    );
  });

  it('waits for write callbacks and drain before reading a response', async () => {
    const backpressure: string[] = [];
    const socket = new BackpressureSocket();
    const transport = new LocalIpcTransport({
      socketFactory: () => socket as unknown as Socket,
      onWriteBackpressure: (direction) => backpressure.push(direction),
    });
    transports.push(transport);

    await expect(transport.request(createIpcEndpoint(), Buffer.from('request'))).resolves.toEqual(
      Buffer.from('fake-response'),
    );
    expect(backpressure).toEqual(['request']);
  });

  it('rejects malformed, truncated, oversized, and trailing request frames before dispatch', async () => {
    const endpoint = createIpcEndpoint();
    const transport = new LocalIpcTransport({ maxPayloadBytes: 32 });
    transports.push(transport);
    let calls = 0;
    await transport.bind(endpoint, (payload) => {
      calls += 1;
      return payload;
    });

    const cases = [
      Buffer.from([0xff, 0xfe]),
      Buffer.from([0, 0, 0, 4, 0x7b]),
      Buffer.concat([encodeFrame(Buffer.from('{}')), Buffer.from([0])]),
      Buffer.from([0, 0, 0, 0xff]),
    ];
    for (const bytes of cases) {
      await expect(sendAndWaitForClose(endpoint, bytes)).resolves.toBe(false);
    }
    expect(calls).toBe(0);
  });

  it('enforces absolute read deadlines for silent and slow-drip peers', async () => {
    const silentEndpoint = createIpcEndpoint();
    const silent = createServer((socket) => socket.resume());
    await listen(silent, silentEndpoint);
    const transport = new LocalIpcTransport({ readTimeoutMs: 80, overallTimeoutMs: 200 });
    transports.push(transport);

    await expect(transport.request(silentEndpoint, Buffer.from('silent'))).rejects.toMatchObject({
      name: 'PhaseDeadlineExceededError',
      phase: 'read',
    });
    await closeServer(silent);

    const dripEndpoint = createIpcEndpoint();
    const response = encodeFrame(Buffer.from('slow-drip'));
    const drip = createServer((socket) => {
      let offset = 0;
      socket.on('error', () => undefined);
      const timer = setInterval(() => {
        if (socket.destroyed || offset >= response.byteLength) {
          clearInterval(timer);
          return;
        }
        socket.write(response.subarray(offset, offset + 1));
        offset += 1;
      }, 10);
      socket.once('close', () => clearInterval(timer));
    });
    await listen(drip, dripEndpoint);

    await expect(
      transport.request(dripEndpoint, Buffer.from('drip'), { readTimeoutMs: 55 }),
    ).rejects.toBeInstanceOf(PhaseDeadlineExceededError);
    await closeServer(drip);
  });

  it('cancels an in-flight request and reports peer exit', async () => {
    const endpoint = createIpcEndpoint();
    const server = createServer((socket) => {
      socket.resume();
      socket.once('data', () => undefined);
    });
    await listen(server, endpoint);
    const transport = new LocalIpcTransport({ overallTimeoutMs: 1_000 });
    transports.push(transport);
    const controller = new AbortController();
    const pending = transport.request(endpoint, Buffer.from('cancel'), {
      signal: controller.signal,
      readTimeoutMs: 500,
    });
    await delay(20);
    controller.abort('caller cancelled');
    await expect(pending).rejects.toBeInstanceOf(AbortError);

    await closeServer(server);

    const peerEndpoint = createIpcEndpoint();
    const peer = createServer((socket) => socket.destroy());
    await listen(peer, peerEndpoint);
    await expect(transport.request(peerEndpoint, Buffer.from('peer-exit'))).rejects.toMatchObject({
      code: expect.stringMatching(/^(connect|write|premature|truncated|read)/u),
    });
    await closeServer(peer);
  });

  it('keeps live endpoint ownership and releases the exact owned endpoint', async () => {
    const endpoint = createIpcEndpoint();
    const owner = new LocalIpcTransport();
    transports.push(owner);
    await owner.bind(endpoint, (payload) => payload);

    const contender = new LocalIpcTransport();
    transports.push(contender);
    await expect(contender.bind(endpoint, (payload) => payload)).rejects.toMatchObject({
      code: 'endpoint-in-use',
    });
    expect(await endpointExists(endpoint)).toBe(true);
    await owner.close();

    const replacement = new LocalIpcTransport();
    transports.push(replacement);
    await replacement.bind(endpoint, (payload) => payload);
    await replacement.close();
    expect(await endpointExists(endpoint)).toBe(false);
  });

  it('does not expose protocol semantics or a TCP fallback in the transport boundary', async () => {
    const transport = new LocalIpcTransport();
    transports.push(transport);
    const payload = Buffer.from('{"task":"opaque"}');
    expect(payload).toBeInstanceOf(Uint8Array);
    expect(transport.maxPayloadBytes).toBeGreaterThan(0);
    const endpoint = createIpcEndpoint();
    expect(
      process.platform === 'win32'
        ? isWindowsPipeEndpoint(endpoint)
        : /^\/tmp\/p2p-[a-f0-9]{24}\.sock$/u.test(endpoint),
    ).toBe(true);
    expect(new TransportError('connect-error', 'test')).toMatchObject({ code: 'connect-error' });

    const source = await fs.readFile(
      new URL('../../src/transport/local-ipc.ts', import.meta.url),
      'utf8',
    );
    expect(source).not.toContain('JSON.parse');
    expect(source).not.toContain('listen(0)');
    expect(source).toContain('createConnection(endpoint)');
  });
});
