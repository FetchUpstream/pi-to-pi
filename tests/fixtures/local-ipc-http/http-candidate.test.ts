import { existsSync } from 'node:fs';
import { createConnection } from 'node:net';
import type { Socket } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import {
  AbortError,
  PhaseDeadlineExceededError,
  onAbort,
  withPhaseDeadline,
} from '../local-ipc-spike/test-helpers.js';
import {
  bindHttpIpc,
  DEFAULT_HTTP_CONNECT_TIMEOUT_MS,
  DEFAULT_HTTP_MAX_RESPONSE_BYTES,
  DEFAULT_HTTP_READ_TIMEOUT_MS,
  DEFAULT_HTTP_WRITE_TIMEOUT_MS,
  createHttpIpcEndpoint,
  getHttpIpcEndpointKind,
  getHttpIpcPlatformSupport,
  HttpIpcBodyLimitError,
  requestHttpIpc,
  requestHttpIpcResponse,
  type HttpIpcServer,
} from './http-candidate.js';

const runningServers: HttpIpcServer[] = [];

async function closeRunningServers(): Promise<void> {
  while (runningServers.length > 0) {
    const server = runningServers.pop();
    await server?.close({ timeoutMs: 500 });
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function startServer(
  handler: Parameters<typeof bindHttpIpc>[0]['handler'],
  options: Omit<Parameters<typeof bindHttpIpc>[0], 'endpoint' | 'handler'> = {},
): Promise<{ endpoint: string; server: HttpIpcServer }> {
  const endpoint = createHttpIpcEndpoint();
  const server = await bindHttpIpc({ endpoint, handler, ...options });
  runningServers.push(server);
  return { endpoint, server };
}

interface RawHttpRequestOptions {
  readonly connectTimeoutMs?: number;
  readonly writeTimeoutMs?: number;
  readonly readTimeoutMs?: number;
  readonly maxResponseBytes?: number;
  readonly signal?: AbortSignal;
}

function normalizeRawResponseLimit(value: number | undefined): number {
  const limit = value ?? DEFAULT_HTTP_MAX_RESPONSE_BYTES;
  if (!Number.isSafeInteger(limit) || limit < 0) {
    throw new RangeError('raw HTTP maxResponseBytes must be a non-negative safe integer');
  }
  return limit;
}

function waitForSocketConnect(socket: Socket, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    let removeAbortListener = (): void => undefined;

    const onConnect = (): void => settle(resolve);
    const onError = (error: Error): void => settle(() => reject(error));
    const cleanup = (): void => {
      socket.removeListener('connect', onConnect);
      socket.removeListener('error', onError);
      removeAbortListener();
    };
    const settle = (callback: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      callback();
    };

    socket.once('connect', onConnect);
    socket.once('error', onError);
    removeAbortListener = onAbort(signal, (error) => settle(() => reject(error)));
  });
}

function writeSocketChunk(socket: Socket, chunk: string, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    let removeAbortListener = (): void => undefined;

    const onError = (error: Error): void => settle(() => reject(error));
    const onWrite = (error?: Error | null): void => {
      if (error === undefined || error === null) {
        settle(resolve);
      } else {
        settle(() => reject(error));
      }
    };
    const cleanup = (): void => {
      socket.removeListener('error', onError);
      removeAbortListener();
    };
    const settle = (callback: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      callback();
    };

    socket.once('error', onError);
    removeAbortListener = onAbort(signal, (error) => settle(() => reject(error)));
    if (settled) {
      return;
    }

    try {
      socket.write(chunk, onWrite);
    } catch (error: unknown) {
      settle(() => reject(error instanceof Error ? error : new Error(String(error))));
    }
  });
}

function endSocket(socket: Socket, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    let removeAbortListener = (): void => undefined;

    const onFinish = (): void => settle(resolve);
    const onError = (error: Error): void => settle(() => reject(error));
    const cleanup = (): void => {
      socket.removeListener('finish', onFinish);
      socket.removeListener('error', onError);
      removeAbortListener();
    };
    const settle = (callback: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      callback();
    };

    socket.once('finish', onFinish);
    socket.once('error', onError);
    removeAbortListener = onAbort(signal, (error) => settle(() => reject(error)));
    if (settled) {
      return;
    }

    try {
      socket.end();
    } catch (error: unknown) {
      settle(() => reject(error instanceof Error ? error : new Error(String(error))));
    }
  });
}

async function writeRawHttp(
  socket: Socket,
  chunks: readonly string[],
  signal: AbortSignal,
): Promise<void> {
  for (const chunk of chunks) {
    await writeSocketChunk(socket, chunk, signal);
  }
  await endSocket(socket, signal);
}

function readRawHttp(
  socket: Socket,
  maxResponseBytes: number,
  signal: AbortSignal,
): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const responseChunks: Buffer[] = [];
    let receivedBytes = 0;
    let ended = false;
    let settled = false;
    let removeAbortListener = (): void => undefined;

    const onData = (chunk: Buffer | string): void => {
      if (settled) {
        return;
      }
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      receivedBytes += bytes.byteLength;
      if (receivedBytes > maxResponseBytes) {
        const error = new Error(
          `raw HTTP response reached ${receivedBytes} bytes; maximum is ${maxResponseBytes} bytes`,
        );
        settle(() => reject(error));
        socket.destroy(error);
        return;
      }
      responseChunks.push(bytes);
    };
    const onEnd = (): void => {
      ended = true;
      settle(() => resolve(Buffer.concat(responseChunks, receivedBytes)));
    };
    const onClose = (): void => {
      if (!ended) {
        settle(() => reject(new Error('raw HTTP socket closed before the response ended')));
      }
    };
    const onError = (error: Error): void => settle(() => reject(error));
    const cleanup = (): void => {
      socket.removeListener('data', onData);
      socket.removeListener('end', onEnd);
      socket.removeListener('close', onClose);
      socket.removeListener('error', onError);
      removeAbortListener();
    };
    const settle = (callback: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      callback();
    };

    socket.on('data', onData);
    socket.once('end', onEnd);
    socket.once('close', onClose);
    socket.once('error', onError);
    removeAbortListener = onAbort(signal, (error) => settle(() => reject(error)));
    if (settled) {
      return;
    }
    if (socket.readableEnded) {
      onEnd();
    } else if (socket.destroyed || socket.readyState === 'closed') {
      onClose();
    }
  });
}

async function sendRawHttp(
  endpoint: string,
  chunks: readonly string[],
  options: RawHttpRequestOptions = {},
): Promise<Buffer> {
  const maxResponseBytes = normalizeRawResponseLimit(options.maxResponseBytes);
  const socket = createConnection(endpoint);
  const responseController = new AbortController();
  socket.on('error', () => undefined);
  try {
    await withPhaseDeadline(
      'connect',
      options.connectTimeoutMs ?? DEFAULT_HTTP_CONNECT_TIMEOUT_MS,
      (signal) => waitForSocketConnect(socket, signal),
      { signal: options.signal, onTimeout: () => socket.destroy() },
    );
    const responsePromise = readRawHttp(socket, maxResponseBytes, responseController.signal);
    void responsePromise.catch(() => undefined);
    await withPhaseDeadline(
      'write',
      options.writeTimeoutMs ?? DEFAULT_HTTP_WRITE_TIMEOUT_MS,
      (signal) => writeRawHttp(socket, chunks, signal),
      { signal: options.signal, onTimeout: () => socket.destroy() },
    );
    return await withPhaseDeadline(
      'read',
      options.readTimeoutMs ?? DEFAULT_HTTP_READ_TIMEOUT_MS,
      responsePromise,
      {
        signal: options.signal,
        onTimeout: () => {
          responseController.abort();
          socket.destroy();
        },
      },
    );
  } finally {
    responseController.abort();
    socket.destroy();
  }
}

afterEach(async () => {
  await closeRunningServers();
});

describe('HTTP over local IPC comparison candidate', () => {
  it('round-trips one request and one response over the native POSIX endpoint', async () => {
    const { endpoint, server } = await startServer(async (payload) => {
      return Buffer.from(payload).subarray(0).reverse();
    });

    expect(server.startupMs).toBeGreaterThanOrEqual(0);
    expect(server.keepAlive).toBe(false);
    const result = await requestHttpIpc(endpoint, Buffer.from('hello'));

    expect(result.equals(Buffer.from('olleh'))).toBe(true);
    expect(server.requestCount).toBe(1);
    expect(server.connectionCount).toBe(1);
  });

  it('rejects an oversized request before invoking the handler', async () => {
    let handlerCalls = 0;
    const { endpoint } = await startServer(
      () => {
        handlerCalls += 1;
        return Buffer.from('unexpected');
      },
      { maxBodyBytes: 4 },
    );

    const response = await requestHttpIpcResponse(endpoint, Buffer.from('12345'));

    expect(response.statusCode).toBe(413);
    expect(handlerCalls).toBe(0);
  });

  it('rejects an oversized response without retaining an unbounded body', async () => {
    const { endpoint } = await startServer(() => Buffer.alloc(32, 0x41), {
      maxResponseBytes: 64,
    });

    await expect(
      requestHttpIpc(endpoint, Buffer.from('request'), { maxResponseBytes: 8 }),
    ).rejects.toBeInstanceOf(HttpIpcBodyLimitError);
  });

  it('bounds raw HTTP response capture', async () => {
    const responseCandidate = await startServer(() => Buffer.alloc(64, 0x41));
    await expect(
      sendRawHttp(
        responseCandidate.endpoint,
        ['POST / HTTP/1.1\r\nHost: local\r\nContent-Length: 1\r\nConnection: close\r\n\r\nx'],
        { maxResponseBytes: 32 },
      ),
    ).rejects.toThrow(/raw HTTP response reached/);
  });

  it('applies finite connect, write, and read phase deadlines', async () => {
    const unavailableEndpoint = createHttpIpcEndpoint();
    await expect(
      requestHttpIpc(unavailableEndpoint, Buffer.from('x'), { connectTimeoutMs: 25 }),
    ).rejects.toBeDefined();

    const writeCandidate = await startServer(() => Buffer.from('ok'));
    await expect(
      requestHttpIpc(writeCandidate.endpoint, Buffer.from('x'), { writeTimeoutMs: 0 }),
    ).rejects.toBeInstanceOf(PhaseDeadlineExceededError);

    const readCandidate = await startServer(async () => {
      await delay(80);
      return Buffer.from('late');
    });
    await expect(
      requestHttpIpc(readCandidate.endpoint, Buffer.from('x'), { readTimeoutMs: 15 }),
    ).rejects.toMatchObject({
      name: 'PhaseDeadlineExceededError',
      phase: 'read',
    });
  });

  it('destroys the request when the caller aborts', async () => {
    const candidate = await startServer(async () => {
      await delay(100);
      return Buffer.from('late');
    });
    const controller = new AbortController();
    const pending = requestHttpIpc(candidate.endpoint, Buffer.from('x'), {
      signal: controller.signal,
      readTimeoutMs: 500,
    });

    await delay(10);
    controller.abort('test cancellation');

    await expect(pending).rejects.toBeInstanceOf(AbortError);
  });

  it('handles split HTTP headers/body and rejects malformed HTTP through the parser', async () => {
    const payloads: Buffer[] = [];
    const candidate = await startServer((payload) => {
      payloads.push(payload);
      return Buffer.from('parsed');
    });

    const response = await sendRawHttp(candidate.endpoint, [
      'POST / HTTP/1.1\r\nHost: local\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n',
      '5\r\nhello\r\n',
      '6\r\n world\r\n0\r\n\r\n',
    ]);
    expect(response.toString('utf8')).toContain('200 OK');
    expect(payloads.map((payload) => payload.toString('utf8'))).toEqual(['hello world']);

    const malformed = await sendRawHttp(candidate.endpoint, ['not-http\r\n\r\n']);
    expect(malformed.toString('utf8')).toContain('400 Bad Request');
    expect(payloads).toHaveLength(1);
    await sendRawHttp(candidate.endpoint, [
      'POST / HTTP/1.1\r\nHost: local\r\nContent-Length: 5\r\nConnection: close\r\n\r\nhe',
    ]);
    expect(payloads).toHaveLength(1);
  });

  it('supports concurrent one-operation requests and preserves response association', async () => {
    const candidate = await startServer(async (payload) => {
      const value = payload.toString('utf8');
      await delay(value === 'slow' ? 20 : 2);
      return Buffer.from(value.toUpperCase());
    });

    const values = await Promise.all(
      ['first', 'slow', 'third'].map((value) =>
        requestHttpIpc(candidate.endpoint, Buffer.from(value)),
      ),
    );

    expect(values.map((value) => value.toString('utf8'))).toEqual(['FIRST', 'SLOW', 'THIRD']);
    expect(candidate.server.requestCount).toBe(3);
    expect(candidate.server.connectionCount).toBe(3);
  });

  it('closes the HTTP server, disables keep-alive, and removes its POSIX socket', async () => {
    const candidate = await startServer((payload) => payload);
    const endpoint = candidate.endpoint;
    const response = await requestHttpIpcResponse(endpoint, Buffer.from('x'));

    expect(response.headers.connection).toBe('close');
    expect(candidate.server.keepAlive).toBe(false);
    await candidate.server.close();

    expect(candidate.server.activeConnectionCount).toBe(0);
    if (process.platform !== 'win32') {
      expect(existsSync(endpoint)).toBe(false);
    }
  });

  it('represents Windows named pipes explicitly even when this run is not Windows', () => {
    const endpoint = createHttpIpcEndpoint({ platform: 'win32', runtimeId: 'http-test' });
    expect(getHttpIpcEndpointKind(endpoint)).toBe('named-pipe');
    const support = getHttpIpcPlatformSupport(endpoint, 'win32');

    expect(support.supported).toBe(true);
    expect(support.note).toContain('run on Windows');
  });
});
