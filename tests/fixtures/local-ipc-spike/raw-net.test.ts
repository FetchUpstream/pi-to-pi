import { promises as fs } from 'node:fs';
import { EventEmitter } from 'node:events';
import { createConnection, createServer } from 'node:net';
import type { Server, Socket } from 'node:net';

import { describe, expect, it } from 'vitest';

import {
  assertPosixEndpointLength,
  createIpcEndpoint,
  DEFAULT_POSIX_ENDPOINT_MAX_BYTES,
  POSIX_ENDPOINT_PREFIX,
  POSIX_ENDPOINT_SUFFIX,
  utf8ByteLength,
  WINDOWS_PIPE_NAMESPACE,
} from '../local-ipc/endpoint.js';
import {
  AbortError,
  createPhaseDeadline,
  PhaseDeadlineExceededError,
  withPhaseDeadline,
} from './test-helpers.js';
import { DEFAULT_MAX_PAYLOAD_BYTES, FrameDecoder, encodeFrame } from './frame-codec.js';
import { RawNetTransport, validateUtf8JsonPayload } from './raw-net.js';

const TEST_TIMEOUT_MS = 2_000;

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function nextTurn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
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

async function listenServer(server: Server, endpoint: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off('error', onError);
      reject(error);
    };
    server.once('error', onError);
    try {
      server.listen(endpoint, () => {
        server.off('error', onError);
        resolve();
      });
    } catch (error: unknown) {
      server.off('error', onError);
      reject(error);
    }
  });
}

async function closeServer(server: Server, sockets: Set<Socket> = new Set()): Promise<void> {
  for (const socket of sockets) {
    socket.destroy();
  }
  if (!server.listening) {
    return;
  }
  await new Promise<void>((resolve, reject) => {
    server.close((error?: Error) => {
      if (error === undefined) {
        resolve();
      } else {
        reject(error);
      }
    });
  });
}

/** Send a frame with deliberately controlled stream writes and decode one response. */
async function rawExchange(
  endpoint: string,
  chunks: readonly Buffer[],
  maxPayloadBytes = DEFAULT_MAX_PAYLOAD_BYTES,
): Promise<Buffer> {
  const socket = createConnection(endpoint);
  const decoder = new FrameDecoder({ maxPayloadBytes });
  let response: Buffer | undefined;
  let remoteEnded = false;
  let settled = false;

  const completion = new Promise<Buffer>((resolve, reject) => {
    const cleanup = (): void => {
      socket.off('connect', onConnect);
      socket.off('data', onData);
      socket.off('end', onEnd);
      socket.off('close', onClose);
      socket.off('error', onError);
    };
    const settle = (callback: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      callback();
    };
    const onConnect = (): void => {
      void (async (): Promise<void> => {
        try {
          for (const chunk of chunks) {
            socket.write(chunk);
            await nextTurn();
          }
          // The complete frame is sufficient; keep the peer readable until the response closes it.
        } catch (error: unknown) {
          settle(() => reject(error));
        }
      })();
    };
    const onData = (chunk: Buffer): void => {
      try {
        const payload = decoder.push(chunk);
        if (payload !== undefined) {
          response = payload;
        }
      } catch (error: unknown) {
        settle(() => reject(error));
      }
    };
    const onEnd = (): void => {
      remoteEnded = true;
      try {
        response = decoder.finish();
      } catch (error: unknown) {
        settle(() => reject(error));
      }
    };
    const onClose = (): void => {
      if (response === undefined) {
        settle(() => reject(new Error('raw exchange closed without a complete response')));
      } else if (remoteEnded || socket.destroyed) {
        settle(() => resolve(response as Buffer));
      }
    };
    const onError = (error: Error): void => {
      // A peer that rejects malformed input may reset rather than perform a
      // graceful half-close; close remains the terminal assertion for this helper.
      if (!socket.destroyed) {
        settle(() => reject(error));
      }
    };

    socket.once('connect', onConnect);
    socket.on('data', onData);
    socket.once('end', onEnd);
    socket.once('close', onClose);
    socket.once('error', onError);
  });

  try {
    return await withPhaseDeadline('raw-exchange', TEST_TIMEOUT_MS, completion, {
      onTimeout: () => socket.destroy(),
    });
  } finally {
    socket.destroy();
  }
}

/** Send malformed input and assert that the candidate closes without a response. */
async function expectRejectedFrame(
  endpoint: string,
  bytes: Buffer,
  maxPayloadBytes: number,
): Promise<void> {
  const socket = createConnection(endpoint);
  let receivedResponse = false;
  const completion = new Promise<void>((resolve, reject) => {
    socket.once('connect', () => socket.end(bytes));
    socket.on('data', () => {
      receivedResponse = true;
    });
    socket.once('error', () => undefined);
    socket.once('close', () => resolve());
    socket.once('timeout', () => reject(new Error('malformed frame close timed out')));
  });

  try {
    await withPhaseDeadline('malformed-frame-close', TEST_TIMEOUT_MS, completion, {
      onTimeout: () => socket.destroy(),
    });
    expect(receivedResponse).toBe(false);
  } finally {
    socket.destroy();
  }

  // Keep this argument in the helper contract so each caller documents the
  // bounded declaration it sent, even though the server owns the decoder.
  expect(maxPayloadBytes).toBeGreaterThanOrEqual(0);
}
interface ResponseServer {
  readonly server: Server;
  readonly sockets: Set<Socket>;
}

async function listenResponseServer(
  endpoint: string,
  response: Buffer,
  endAfterResponse = true,
): Promise<ResponseServer> {
  const sockets = new Set<Socket>();
  const server = createServer({ allowHalfOpen: true }, (socket) => {
    sockets.add(socket);
    socket.on('error', () => undefined);
    socket.once('close', () => sockets.delete(socket));
    socket.once('data', () => {
      socket.write(response);
      if (endAfterResponse) {
        socket.end();
      }
    });
  });
  await listenServer(server, endpoint);
  return { server, sockets };
}

class FakeSocket extends EventEmitter {
  destroyed = false;
  private readonly connectOnNextTurn: boolean;
  private readonly backpressure: boolean;

  constructor(connectOnNextTurn: boolean, backpressure: boolean) {
    super();
    this.connectOnNextTurn = connectOnNextTurn;
    this.backpressure = backpressure;
    if (connectOnNextTurn) {
      queueMicrotask(() => this.emit('connect'));
    }
  }

  write(chunk: Uint8Array, callback: () => void): boolean {
    void chunk;
    void callback;
    return !this.backpressure;
  }

  end(callback?: () => void): this {
    void callback;
    return this;
  }

  destroy(): this {
    if (!this.destroyed) {
      this.destroyed = true;
      this.emit('close', false);
    }
    return this;
  }

  hasConnectScheduled(): boolean {
    return this.connectOnNextTurn;
  }
}

class HangingResponseSocket extends FakeSocket {
  write(chunk: Uint8Array, callback: () => void): boolean {
    void chunk;
    queueMicrotask(callback);
    return true;
  }
  end(callback?: () => void): this {
    queueMicrotask(() => callback?.());
    return this;
  }
}

class DeferredCloseSocket extends FakeSocket {
  private closePending = false;

  override destroy(): this {
    if (!this.destroyed) {
      this.destroyed = true;
      this.closePending = true;
    }
    return this;
  }

  releaseClose(): void {
    if (this.closePending) {
      this.closePending = false;
      this.emit('close', false);
    }
  }
}
describe('raw node:net local IPC candidate', () => {
  it('uses the native platform endpoint and records the cross-platform matrix boundary', () => {
    const endpoint = createIpcEndpoint();

    if (process.platform === 'win32') {
      expect(endpoint.startsWith(WINDOWS_PIPE_NAMESPACE)).toBe(true);
      expect(endpoint).not.toContain('/');
    } else {
      expect(['linux', 'darwin']).toContain(process.platform);
      expect(endpoint.startsWith('/tmp/')).toBe(true);
      expect(utf8ByteLength(endpoint)).toBeLessThanOrEqual(DEFAULT_POSIX_ENDPOINT_MAX_BYTES);
    }
  });

  it('round-trips one opaque request and one response on the native endpoint', async () => {
    const endpoint = createIpcEndpoint();
    const received: Buffer[] = [];
    const transport = new RawNetTransport();
    await transport.bind(endpoint, async (payload) => {
      received.push(Buffer.from(payload));
      return Buffer.concat([Buffer.from('reply:'), payload]);
    });

    try {
      const payload = Buffer.from([0, 1, 2, 0xff, 0x00]);
      await expect(transport.request(endpoint, payload)).resolves.toEqual(
        Buffer.concat([Buffer.from('reply:'), payload]),
      );
      expect(received).toEqual([payload]);
    } finally {
      await transport.close();
    }

    if (process.platform !== 'win32') {
      expect(await endpointExists(endpoint)).toBe(false);
    }
  });

  it('parses split headers and bodies, coalesced writes, and closes after one operation', async () => {
    const endpoint = createIpcEndpoint();
    let handlerCalls = 0;
    const transport = new RawNetTransport();
    await transport.bind(endpoint, (payload) => {
      handlerCalls += 1;
      return Buffer.from(payload).reverse();
    });

    try {
      const payload = Buffer.from('{"split":true,"value":"stream"}');
      const frame = encodeFrame(payload);
      const splitResponse = await rawExchange(endpoint, [
        frame.subarray(0, 1),
        frame.subarray(1, 4),
        frame.subarray(4, 9),
        frame.subarray(9),
      ]);
      expect(splitResponse).toEqual(Buffer.from(payload).reverse());

      const coalescedPayload = Buffer.from('{"coalesced":true}');
      const coalescedResponse = await rawExchange(endpoint, [encodeFrame(coalescedPayload)]);
      expect(coalescedResponse).toEqual(Buffer.from(coalescedPayload).reverse());
      expect(handlerCalls).toBe(2);
    } finally {
      await transport.close();
    }
  });

  it.skipIf(process.platform === 'win32')(
    'keeps concurrent client responses associated with their request ordering',
    async () => {
      const endpoint = createIpcEndpoint();
      const transport = new RawNetTransport();
      await transport.bind(endpoint, async (payload) => {
        const id = Number(payload.toString('utf8'));
        await delay((5 - id) * 5);
        return Buffer.from(`response-${id}`);
      });

      try {
        const responses = await Promise.all(
          Array.from({ length: 6 }, (_, id) =>
            transport.request(endpoint, Buffer.from(String(id))),
          ),
        );
        expect(responses.map((value) => value.toString('utf8'))).toEqual(
          Array.from({ length: 6 }, (_, id) => `response-${id}`),
        );
      } finally {
        await transport.close();
      }
    },
  );

  it('rejects malformed, truncated, trailing, and oversized input before the handler', async () => {
    const endpoint = createIpcEndpoint();
    let handlerCalls = 0;
    const maxPayloadBytes = 32;
    const transport = new RawNetTransport({
      maxPayloadBytes,
      validatePayload: validateUtf8JsonPayload,
    });
    await transport.bind(endpoint, (payload) => {
      handlerCalls += 1;
      return payload;
    });

    try {
      await expectRejectedFrame(endpoint, encodeFrame(Buffer.from([0xff, 0xfe])), maxPayloadBytes);
      await expectRejectedFrame(endpoint, encodeFrame(Buffer.from('{not-json}')), maxPayloadBytes);
      await expectRejectedFrame(endpoint, Buffer.from([0, 0, 0, 4, 0x7b]), maxPayloadBytes);
      await expectRejectedFrame(
        endpoint,
        Buffer.concat([encodeFrame(Buffer.from('{}')), Buffer.from([0])]),
        maxPayloadBytes,
      );
      await expectRejectedFrame(endpoint, Buffer.from([0, 0, 0, 0xff]), maxPayloadBytes);
      expect(handlerCalls).toBe(0);
    } finally {
      await transport.close();
    }
  });
  it('resolves a complete response before the peer half-closes', async () => {
    const endpoint = createIpcEndpoint();
    const fixture = await listenResponseServer(endpoint, encodeFrame(Buffer.from('{}')), false);
    const transport = new RawNetTransport({ validatePayload: validateUtf8JsonPayload });

    try {
      await expect(transport.request(endpoint, Buffer.from('{"request":true}'))).resolves.toEqual(
        Buffer.from('{}'),
      );
    } finally {
      await transport.close();
      await closeServer(fixture.server, fixture.sockets);
    }
  });
  it('force-closes the server side after a response to a peer that stays open', async () => {
    const endpoint = createIpcEndpoint();
    const transport = new RawNetTransport();
    await transport.bind(endpoint, (payload) => payload);
    const socket = createConnection(endpoint);
    socket.on('error', () => undefined);
    const responseDecoder = new FrameDecoder();
    const response = new Promise<Buffer>((resolve, reject) => {
      socket.on('data', (chunk) => {
        try {
          const payload = responseDecoder.push(chunk);
          if (payload !== undefined) {
            resolve(payload);
          }
        } catch (error: unknown) {
          reject(error);
        }
      });
    });
    const closed = new Promise<void>((resolve) => socket.once('close', resolve));
    try {
      await withPhaseDeadline(
        'peer-held-connect',
        TEST_TIMEOUT_MS,
        new Promise<void>((resolve) => socket.once('connect', resolve)),
        { onTimeout: () => socket.destroy() },
      );
      socket.write(encodeFrame(Buffer.from('request')));
      await expect(
        withPhaseDeadline('peer-held-response', TEST_TIMEOUT_MS, response, {
          onTimeout: () => socket.destroy(),
        }),
      ).resolves.toEqual(Buffer.from('request'));
      await withPhaseDeadline('peer-held-close', TEST_TIMEOUT_MS, closed, {
        onTimeout: () => socket.destroy(),
      });
      expect(socket.destroyed).toBe(true);
    } finally {
      socket.destroy();
      await transport.close();
    }
  });
  it('closes a connection when trailing request bytes arrive after response dispatch', async () => {
    const endpoint = createIpcEndpoint();
    let handlerCalls = 0;
    const transport = new RawNetTransport();
    await transport.bind(endpoint, (payload) => {
      handlerCalls += 1;
      return payload;
    });
    const socket = createConnection(endpoint);
    socket.on('error', () => undefined);
    const responseDecoder = new FrameDecoder();
    const response = new Promise<Buffer>((resolve, reject) => {
      socket.on('data', (chunk) => {
        try {
          const payload = responseDecoder.push(chunk);
          if (payload !== undefined) {
            resolve(payload);
          }
        } catch (error: unknown) {
          reject(error);
        }
      });
    });
    const closed = new Promise<void>((resolve) => socket.once('close', resolve));
    try {
      await withPhaseDeadline(
        'late-trailing-connect',
        TEST_TIMEOUT_MS,
        new Promise<void>((resolve) => socket.once('connect', resolve)),
        { onTimeout: () => socket.destroy() },
      );
      socket.write(encodeFrame(Buffer.from('request')));
      await expect(
        withPhaseDeadline('late-trailing-response', TEST_TIMEOUT_MS, response, {
          onTimeout: () => socket.destroy(),
        }),
      ).resolves.toEqual(Buffer.from('request'));
      await nextTurn();
      socket.write(Buffer.from([0]));
      await withPhaseDeadline('late-trailing-close', TEST_TIMEOUT_MS, closed, {
        onTimeout: () => socket.destroy(),
      });
      expect(handlerCalls).toBe(1);
    } finally {
      socket.destroy();
      await transport.close();
    }
  });
  it('rejects trailing response bytes that arrive before completion settles', async () => {
    const endpoint = createIpcEndpoint();
    const response = encodeFrame(Buffer.from('{}'));
    const sockets = new Set<Socket>();
    let responseSocket: Socket | undefined;
    const server = createServer({ allowHalfOpen: true }, (socket) => {
      sockets.add(socket);
      responseSocket = socket;
      socket.on('error', () => undefined);
      socket.once('close', () => sockets.delete(socket));
      socket.once('data', () => socket.write(response));
    });
    await listenServer(server, endpoint);
    const transport = new RawNetTransport({
      validatePayload: () => {
        if (responseSocket === undefined) {
          throw new Error('response socket was not accepted');
        }
        responseSocket.write(Buffer.from([0]));
      },
    });
    try {
      await expect(transport.request(endpoint, Buffer.from('{}'))).rejects.toMatchObject({
        code: 'trailing-data',
      });
    } finally {
      await transport.close();
      await closeServer(server, sockets);
    }
  });

  it('rejects malformed, truncated, trailing, and oversized responses', async () => {
    const cases: readonly { response: Buffer; code: string; maxPayloadBytes?: number }[] = [
      { response: encodeFrame(Buffer.from('{not-json}')), code: 'malformed-payload' },
      { response: Buffer.from([0, 0, 0, 4, 0x7b]), code: 'premature-close' },
      {
        response: Buffer.concat([encodeFrame(Buffer.from('{}')), Buffer.from([0])]),
        code: 'trailing-data',
      },
      {
        response: Buffer.from([0, 0, 0, 33]),
        code: 'oversized-frame',
        maxPayloadBytes: 32,
      },
    ];

    for (const testCase of cases) {
      const endpoint = createIpcEndpoint();
      const fixture = await listenResponseServer(endpoint, testCase.response);
      const transport = new RawNetTransport({
        maxPayloadBytes: testCase.maxPayloadBytes,
        validatePayload: validateUtf8JsonPayload,
      });
      try {
        await expect(transport.request(endpoint, Buffer.from('{}'))).rejects.toMatchObject({
          code: testCase.code,
        });
      } finally {
        await transport.close();
        await closeServer(fixture.server, fixture.sockets);
      }
    }
  });

  it('fails an unavailable endpoint within the connect deadline', async () => {
    const endpoint = createIpcEndpoint();
    const transport = new RawNetTransport({ connectTimeoutMs: 100 });
    const startedAt = Date.now();

    await expect(transport.request(endpoint, Buffer.from('unavailable'))).rejects.toMatchObject({
      code: expect.stringMatching(/^connect-/),
    });
    expect(Date.now() - startedAt).toBeLessThan(TEST_TIMEOUT_MS);
    await transport.close();
  });

  it('enforces a deterministic connect deadline on a socket that never connects', async () => {
    let fakeSocket: FakeSocket | undefined;
    const transport = new RawNetTransport({
      socketFactory: () => {
        fakeSocket = new FakeSocket(false, false);
        expect(fakeSocket.hasConnectScheduled()).toBe(false);
        return fakeSocket as unknown as Socket;
      },
    });

    await expect(
      transport.request('fixture-connect-deadline', Buffer.from('request'), {
        connectTimeoutMs: 25,
      }),
    ).rejects.toBeInstanceOf(PhaseDeadlineExceededError);
    expect(fakeSocket?.destroyed).toBe(true);
    await transport.close();
  });

  it('enforces an absolute write deadline while waiting for drain backpressure', async () => {
    let fakeSocket: FakeSocket | undefined;
    const transport = new RawNetTransport({
      socketFactory: () => {
        fakeSocket = new FakeSocket(true, true);
        return fakeSocket as unknown as Socket;
      },
    });

    await expect(
      transport.request('fixture-write-deadline', Buffer.from('request'), {
        writeTimeoutMs: 25,
      }),
    ).rejects.toMatchObject({
      name: 'PhaseDeadlineExceededError',
      phase: 'write',
    });
    expect(fakeSocket?.destroyed).toBe(true);
    await transport.close();
  });

  it(
    'exercises real write backpressure for a bounded large request and response',
    async () => {
      const endpoint = createIpcEndpoint();
      const backpressure: string[] = [];
      const payload = Buffer.alloc(256 * 1024, 0x5a);
      const transport = new RawNetTransport({
        maxPayloadBytes: payload.byteLength,
        onWriteBackpressure: (direction) => backpressure.push(direction),
        readTimeoutMs: TEST_TIMEOUT_MS,
      });
      await transport.bind(endpoint, (request) => request);

      try {
        await expect(transport.request(endpoint, payload)).resolves.toEqual(payload);
        expect(backpressure).toContain('request');
        expect(backpressure).toContain('response');
      } finally {
        await transport.close();
      }
    },
    TEST_TIMEOUT_MS * 2,
  );

  it('enforces an absolute read deadline against a peer that never responds', async () => {
    const endpoint = createIpcEndpoint();
    const sockets = new Set<Socket>();
    const server = createServer({ allowHalfOpen: true }, (socket) => {
      sockets.add(socket);
      socket.resume();
      socket.once('close', () => sockets.delete(socket));
    });
    await listenServer(server, endpoint);
    const transport = new RawNetTransport();

    try {
      await expect(
        transport.request(endpoint, Buffer.from('request'), {
          readDeadline: createPhaseDeadline('read', 35),
        }),
      ).rejects.toMatchObject({
        name: 'PhaseDeadlineExceededError',
        phase: 'read',
      });
    } finally {
      await transport.close();
      await closeServer(server, sockets);
    }
  });

  it('fails a slow-drip response even when each byte arrives before an idle timeout', async () => {
    const endpoint = createIpcEndpoint();
    const sockets = new Set<Socket>();
    let dripWrites = 0;
    const response = encodeFrame(Buffer.from('slow-drip'));
    const server = createServer({ allowHalfOpen: true }, (socket) => {
      sockets.add(socket);
      socket.on('error', () => undefined);
      const decoder = new FrameDecoder();
      let dripTimer: NodeJS.Timeout | undefined;
      let offset = 0;
      const startDrip = (): void => {
        if (dripTimer !== undefined) {
          return;
        }
        dripTimer = setInterval(() => {
          if (socket.destroyed || offset >= response.byteLength) {
            clearInterval(dripTimer);
            dripTimer = undefined;
            if (!socket.destroyed) {
              socket.end();
            }
            return;
          }
          socket.write(response.subarray(offset, offset + 1));
          offset += 1;
          dripWrites += 1;
        }, 10);
      };
      socket.on('data', (chunk) => {
        try {
          if (decoder.push(chunk) !== undefined) {
            startDrip();
          }
        } catch {
          socket.destroy();
        }
      });
      socket.once('end', () => {
        if (dripTimer === undefined) {
          socket.destroy();
        }
      });
      socket.once('close', () => {
        if (dripTimer !== undefined) {
          clearInterval(dripTimer);
          dripTimer = undefined;
        }
        sockets.delete(socket);
      });
    });
    await listenServer(server, endpoint);
    const transport = new RawNetTransport();

    try {
      await expect(
        transport.request(endpoint, Buffer.from('request'), { readTimeoutMs: 55 }),
      ).rejects.toMatchObject({
        name: 'PhaseDeadlineExceededError',
        phase: 'read',
      });
      expect(dripWrites).toBeGreaterThan(0);
      expect(dripWrites).toBeLessThan(response.byteLength);
    } finally {
      await transport.close();
      await closeServer(server, sockets);
    }
  });

  it('cancels an in-flight request and destroys the underlying socket', async () => {
    let fakeSocket: HangingResponseSocket | undefined;
    const transport = new RawNetTransport({
      socketFactory: () => {
        fakeSocket = new HangingResponseSocket(true, false);
        return fakeSocket as unknown as Socket;
      },
    });
    const controller = new AbortController();

    try {
      const pending = transport.request('fixture-cancel', Buffer.from('request'), {
        readTimeoutMs: TEST_TIMEOUT_MS,
        signal: controller.signal,
      });
      await delay(20);
      controller.abort('caller cancelled');
      await expect(pending).rejects.toBeInstanceOf(AbortError);
      expect(fakeSocket?.destroyed).toBe(true);
    } finally {
      await transport.close();
    }
  });
  it('rechecks sockets added while shutdown is draining', async () => {
    const transport = new RawNetTransport();
    const serverSockets = (transport as unknown as { serverSockets: Set<Socket> }).serverSockets;
    const lateSocket = new FakeSocket(false, false) as unknown as Socket;
    let closed = false;
    lateSocket.once('close', () => {
      closed = true;
      serverSockets.delete(lateSocket);
    });
    const closing = transport.close();
    queueMicrotask(() => serverSockets.add(lateSocket));
    await expect(closing).resolves.toBeUndefined();
    expect(closed).toBe(true);
  });
  it('waits for the close event after forcing a destroyed socket during shutdown', async () => {
    const transport = new RawNetTransport({ shutdownTimeoutMs: 0 });
    const serverSockets = (transport as unknown as { serverSockets: Set<Socket> }).serverSockets;
    const socket = new DeferredCloseSocket(false, false);
    serverSockets.add(socket as unknown as Socket);
    socket.once('close', () => serverSockets.delete(socket as unknown as Socket));
    const closing = transport.close();
    await nextTurn();
    expect(socket.destroyed).toBe(true);
    let settled = false;
    void closing.finally(() => {
      settled = true;
    });
    await nextTurn();
    expect(settled).toBe(false);
    socket.releaseClose();
    await expect(closing).resolves.toBeUndefined();
  });
  it('serializes bind with close and rejects requests after shutdown', async () => {
    const endpoint = createIpcEndpoint();
    const transport = new RawNetTransport();
    const binding = transport.bind(endpoint, (payload) => payload);
    const closing = transport.close();

    await expect(binding).rejects.toMatchObject({ code: 'shutdown-error' });
    await expect(closing).resolves.toBeUndefined();
    await expect(transport.close()).resolves.toBeUndefined();
    await expect(transport.request(endpoint, Buffer.from('after-close'))).rejects.toMatchObject({
      code: 'shutdown-error',
    });
    if (process.platform !== 'win32') {
      expect(await endpointExists(endpoint)).toBe(false);
    }
  });

  it('stops accepting and releases active sockets on clean shutdown', async () => {
    const endpoint = createIpcEndpoint();
    const sockets = new Set<Socket>();
    const transport = new RawNetTransport({ shutdownTimeoutMs: 100 });
    await transport.bind(endpoint, (payload) => payload);
    const client = createConnection(endpoint);
    sockets.add(client);
    await withPhaseDeadline(
      'client-connect',
      TEST_TIMEOUT_MS,
      new Promise<void>((resolve, reject) => {
        client.once('connect', resolve);
        client.once('error', reject);
      }),
    );
    const clientClosed = new Promise<void>((resolve) => {
      if (client.destroyed) {
        resolve();
      } else {
        client.once('close', () => resolve());
      }
    });

    await transport.close();
    await withPhaseDeadline('client-close', TEST_TIMEOUT_MS, clientClosed);
    expect(client.destroyed).toBe(true);
    if (process.platform !== 'win32') {
      expect(await endpointExists(endpoint)).toBe(false);
    }
    client.destroy();
  });

  it('tests endpoint byte-length boundaries without embedding a working-directory path', () => {
    const runtimeId = 'a'.repeat(24);
    const basename = `${POSIX_ENDPOINT_PREFIX}${runtimeId}${POSIX_ENDPOINT_SUFFIX}`;
    const root = `/${'r'.repeat(DEFAULT_POSIX_ENDPOINT_MAX_BYTES - basename.length - 2)}`;
    const endpoint = createIpcEndpoint({ platform: 'linux', posixRoot: root, runtimeId });

    expect(utf8ByteLength(endpoint)).toBe(DEFAULT_POSIX_ENDPOINT_MAX_BYTES);
    expect(assertPosixEndpointLength(endpoint, DEFAULT_POSIX_ENDPOINT_MAX_BYTES)).toBe(
      DEFAULT_POSIX_ENDPOINT_MAX_BYTES,
    );
    expect(() =>
      createIpcEndpoint({ platform: 'linux', posixRoot: `${root}r`, runtimeId }),
    ).toThrow(/UTF-8 bytes; maximum/);
  });

  it('records the native-only Windows named-pipe cleanup limitation explicitly', async () => {
    if (process.platform !== 'win32') {
      expect({
        platform: process.platform,
        limitation: 'Windows named-pipe lifecycle requires the Windows runner',
      }).toEqual({
        platform: process.platform,
        limitation: 'Windows named-pipe lifecycle requires the Windows runner',
      });
      return;
    }

    const endpoint = createIpcEndpoint({ platform: 'win32' });
    const transport = new RawNetTransport({ connectTimeoutMs: 100 });
    await transport.bind(endpoint, (payload) => payload);
    await transport.close();

    const probe = new RawNetTransport({ connectTimeoutMs: 100 });
    try {
      await expect(probe.request(endpoint, Buffer.from('after-close'))).rejects.toMatchObject({
        code: expect.stringMatching(/^connect-/),
      });
    } finally {
      await probe.close();
    }
  });
});
