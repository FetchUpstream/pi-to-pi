import { existsSync } from 'node:fs';
import { createConnection } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import { AbortError, PhaseDeadlineExceededError } from '../local-ipc-spike/test-helpers.js';
import {
  bindHttpIpc,
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

function sendRawHttp(endpoint: string, chunks: readonly string[]): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const socket = createConnection(endpoint);
    const responseChunks: Buffer[] = [];
    let index = 0;

    socket.once('connect', () => {
      const writeNext = (): void => {
        const chunk = chunks[index];
        index += 1;
        if (chunk === undefined) {
          socket.end();
          return;
        }
        socket.write(chunk, () => {
          setTimeout(writeNext, 2);
        });
      };
      writeNext();
    });
    socket.on('data', (chunk: Buffer) => responseChunks.push(chunk));
    socket.once('error', reject);
    socket.once('end', () => resolve(Buffer.concat(responseChunks)));
  });
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
      'POST / HTTP/1.1\r\nHost: local\r\nContent-Length: 11\r\nConnection: close\r\n\r\nhel',
      'lo world',
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
