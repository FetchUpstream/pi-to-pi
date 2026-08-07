/**
 * Throwaway HTTP-over-local-IPC comparison candidate.
 *
 * This fixture deliberately stays under tests/fixtures and does not import any
 * production transport or Pi message/task module. It uses Node's HTTP parser on
 * top of the path-based IPC endpoint accepted by `http.Server.listen` and
 * `http.request({ socketPath })`.
 */
import { lstat, unlink } from 'node:fs/promises';
import { createServer, request as createRequest } from 'node:http';
import type {
  ClientRequest,
  IncomingHttpHeaders,
  IncomingMessage,
  Server,
  ServerResponse,
} from 'node:http';
import { performance } from 'node:perf_hooks';
import type { Socket } from 'node:net';

import { createIpcEndpoint, type IpcEndpointOptions } from '../local-ipc/index.js';
import {
  AbortError,
  createPhaseDeadline,
  PhaseDeadlineExceededError,
  remainingMs,
} from '../local-ipc-spike/test-helpers.js';

export const DEFAULT_HTTP_MAX_BODY_BYTES = 64 * 1024;
export const DEFAULT_HTTP_MAX_RESPONSE_BYTES = 64 * 1024;
export const DEFAULT_HTTP_CONNECT_TIMEOUT_MS = 1_000;
export const DEFAULT_HTTP_WRITE_TIMEOUT_MS = 1_000;
export const DEFAULT_HTTP_READ_TIMEOUT_MS = 1_000;
export const DEFAULT_HTTP_CLOSE_TIMEOUT_MS = 1_000;

const HTTP_METHOD = 'POST';
const HTTP_PATH = '/';
const UNIX_SOCKET_PREFIXES = ['/'];
const WINDOWS_PIPE_PREFIXES = ['\\\\?\\pipe\\', '\\\\.\\pipe\\'];

type Awaitable<T> = T | PromiseLike<T>;

export type HttpIpcEndpointKind = 'unix-socket' | 'named-pipe' | 'unknown';

export interface HttpIpcPlatformSupport {
  readonly platform: NodeJS.Platform;
  readonly endpointKind: HttpIpcEndpointKind;
  readonly supported: boolean;
  readonly note: string;
}

export interface HttpIpcServerOptions {
  readonly endpoint: string;
  readonly handler: HttpIpcHandler;
  /** Maximum request body retained by the HTTP candidate. */
  readonly maxBodyBytes?: number;
  /** Maximum response body produced by the bound handler. */
  readonly maxResponseBytes?: number;
}

export interface HttpIpcRequestOptions {
  readonly connectTimeoutMs?: number;
  readonly writeTimeoutMs?: number;
  readonly readTimeoutMs?: number;
  /** Maximum response body retained by the HTTP client. */
  readonly maxResponseBytes?: number;
  readonly signal?: AbortSignal;
  readonly path?: string;
}

export interface HttpIpcResponse {
  readonly statusCode: number;
  readonly headers: IncomingHttpHeaders;
  readonly body: Buffer;
}

export interface HttpIpcCloseOptions {
  readonly timeoutMs?: number;
}

export interface HttpIpcServer {
  readonly endpoint: string;
  readonly startupMs: number;
  readonly maxBodyBytes: number;
  readonly maxResponseBytes: number;
  readonly keepAlive: false;
  readonly connectionCount: number;
  readonly requestCount: number;
  readonly activeConnectionCount: number;
  close(options?: HttpIpcCloseOptions): Promise<void>;
}

export type HttpIpcHandler = (payload: Buffer, request: IncomingMessage) => Awaitable<Uint8Array>;

export class HttpIpcResponseError extends Error {
  readonly code = 'ERR_HTTP_IPC_RESPONSE_STATUS';
  readonly response: HttpIpcResponse;

  constructor(response: HttpIpcResponse) {
    super(`HTTP IPC request returned status ${response.statusCode}`);
    this.name = 'HttpIpcResponseError';
    this.response = response;
  }
}

export class HttpIpcBodyLimitError extends Error {
  readonly code = 'ERR_HTTP_IPC_BODY_LIMIT';
  readonly side: 'request' | 'response';
  readonly maxBytes: number;
  readonly receivedBytes: number;

  constructor(side: 'request' | 'response', maxBytes: number, receivedBytes: number) {
    super(`HTTP IPC ${side} body reached ${receivedBytes} bytes; maximum is ${maxBytes} bytes`);
    this.name = 'HttpIpcBodyLimitError';
    this.side = side;
    this.maxBytes = maxBytes;
    this.receivedBytes = receivedBytes;
  }
}

export class HttpIpcProtocolError extends Error {
  readonly code = 'ERR_HTTP_IPC_PROTOCOL';

  constructor(message: string) {
    super(message);
    this.name = 'HttpIpcProtocolError';
  }
}

interface PhaseTimer {
  readonly deadline: number;
  cancel(): void;
}

interface ServerCounters {
  connectionCount: number;
  requestCount: number;
}

function normalizeByteLimit(value: number | undefined, fallback: number, label: string): number {
  const limit = value ?? fallback;
  if (!Number.isSafeInteger(limit) || limit < 0) {
    throw new RangeError(`${label} must be a non-negative safe integer`);
  }
  return limit;
}

function normalizeTimeout(value: number | undefined, fallback: number, label: string): number {
  const timeout = value ?? fallback;
  if (!Number.isFinite(timeout) || timeout < 0 || timeout > 2_147_483_647) {
    throw new RangeError(`${label} must be finite and between 0 and 2147483647 milliseconds`);
  }
  return timeout;
}

function endpointKind(endpoint: string): HttpIpcEndpointKind {
  if (UNIX_SOCKET_PREFIXES.some((prefix) => endpoint.startsWith(prefix))) {
    return 'unix-socket';
  }
  if (WINDOWS_PIPE_PREFIXES.some((prefix) => endpoint.startsWith(prefix))) {
    return 'named-pipe';
  }
  return 'unknown';
}

/** Return the endpoint kind without interpreting the endpoint as a filesystem path on Windows. */
export function getHttpIpcEndpointKind(endpoint: string): HttpIpcEndpointKind {
  if (typeof endpoint !== 'string' || endpoint.length === 0) {
    throw new TypeError('HTTP IPC endpoint must be a non-empty string');
  }
  return endpointKind(endpoint);
}

/** Generate the same opaque platform-specific endpoint used by the raw candidate. */
export function createHttpIpcEndpoint(options?: IpcEndpointOptions): string {
  return createIpcEndpoint(options);
}

/**
 * Report whether this Node runtime can represent the endpoint as a local HTTP
 * transport. The Windows value is intentionally reported as supported by the
 * implementation but still needs a real Windows run for evidence.
 */
export function getHttpIpcPlatformSupport(
  endpoint = createHttpIpcEndpoint(),
  platform = process.platform,
): HttpIpcPlatformSupport {
  const kind = getHttpIpcEndpointKind(endpoint);
  if (platform === 'linux' || platform === 'darwin') {
    return {
      platform,
      endpointKind: kind,
      supported: kind === 'unix-socket',
      note:
        kind === 'unix-socket'
          ? 'Node HTTP server.listen/request socketPath use a Unix domain socket.'
          : 'This POSIX runtime requires a Unix-socket endpoint.',
    };
  }
  if (platform === 'win32') {
    return {
      platform,
      endpointKind: kind,
      supported: kind === 'named-pipe',
      note:
        kind === 'named-pipe'
          ? 'Node HTTP server.listen/request socketPath are expected to use a named pipe; run on Windows to verify.'
          : 'Windows requires a named-pipe namespace endpoint.',
    };
  }
  return {
    platform,
    endpointKind: kind,
    supported: false,
    note: 'The spike only defines POSIX Unix sockets and Windows named pipes.',
  };
}

function errorFromAbortReason(reason: unknown): AbortError {
  if (reason instanceof AbortError) {
    return reason;
  }
  if (reason instanceof Error) {
    return new AbortError(reason.message, reason);
  }
  if (typeof reason === 'string' && reason.length > 0) {
    return new AbortError(reason);
  }
  return new AbortError();
}

function armPhaseTimer(
  phase: string,
  timeoutMs: number,
  onTimeout: (error: PhaseDeadlineExceededError) => void,
): PhaseTimer {
  const deadline = createPhaseDeadline(phase, timeoutMs);
  let timer: NodeJS.Timeout | undefined;
  let cancelled = false;
  const fire = (): void => {
    if (!cancelled) {
      onTimeout(new PhaseDeadlineExceededError(phase, deadline.at));
    }
  };

  if (timeoutMs === 0 || remainingMs(deadline) === 0) {
    fire();
  } else {
    timer = setTimeout(fire, remainingMs(deadline));
  }

  return {
    deadline: deadline.at,
    cancel: (): void => {
      cancelled = true;
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    },
  };
}

function parseContentLength(request: IncomingMessage): number | undefined {
  const value = request.headers['content-length'];
  if (value === undefined) {
    return undefined;
  }
  if (Array.isArray(value) || !/^\d+$/.test(value)) {
    throw new HttpIpcProtocolError('HTTP Content-Length must be a non-negative decimal integer');
  }
  const length = Number(value);
  if (!Number.isSafeInteger(length)) {
    throw new HttpIpcProtocolError('HTTP Content-Length exceeds the safe integer range');
  }
  return length;
}

function responseBodyText(message: string): Buffer {
  return Buffer.from(message, 'utf8');
}

function closeResponse(response: ServerResponse, statusCode: number, body: Buffer): void {
  if (response.headersSent || response.writableEnded) {
    return;
  }
  response.statusCode = statusCode;
  response.shouldKeepAlive = false;
  response.setHeader('Connection', 'close');
  response.setHeader('Content-Length', body.byteLength);
  response.end(body);
}

function destroyRequestAfterResponse(request: IncomingMessage, response: ServerResponse): void {
  request.resume();
  response.once('finish', () => {
    if (!request.destroyed) {
      request.destroy();
    }
  });
}

async function removeOwnedUnixSocket(endpoint: string): Promise<void> {
  if (process.platform === 'win32' || endpointKind(endpoint) !== 'unix-socket') {
    return;
  }
  try {
    const stat = await lstat(endpoint);
    if (stat.isSocket()) {
      await unlink(endpoint);
    }
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }
}

function closeServer(
  server: Server,
  endpoint: string,
  sockets: Set<Socket>,
  options: HttpIpcCloseOptions,
): Promise<void> {
  const timeoutMs = normalizeTimeout(
    options.timeoutMs,
    DEFAULT_HTTP_CLOSE_TIMEOUT_MS,
    'closeTimeoutMs',
  );

  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => forceClose(), timeoutMs);

    const finish = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      void removeOwnedUnixSocket(endpoint).then(resolve, reject);
    };

    const forceClose = (): void => {
      if (settled) {
        return;
      }
      for (const socket of sockets) {
        socket.destroy();
      }
      server.closeAllConnections();
    };

    try {
      server.close((error?: Error) => {
        if (
          error !== undefined &&
          (error as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING'
        ) {
          if (!settled) {
            settled = true;
            if (timer !== undefined) {
              clearTimeout(timer);
            }
            reject(error);
          }
          return;
        }
        finish();
      });
    } catch (error: unknown) {
      if (!settled) {
        settled = true;
        if (timer !== undefined) {
          clearTimeout(timer);
        }
        reject(error);
      }
    }
  });
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  options: HttpIpcServerOptions & { maxBodyBytes: number; maxResponseBytes: number },
  counters: ServerCounters,
): Promise<void> {
  counters.requestCount += 1;
  response.shouldKeepAlive = false;
  response.setHeader('Connection', 'close');

  if (request.method !== HTTP_METHOD || request.url !== HTTP_PATH) {
    closeResponse(
      response,
      request.method === HTTP_METHOD ? 404 : 405,
      responseBodyText('not found'),
    );
    destroyRequestAfterResponse(request, response);
    return;
  }

  let declaredLength: number | undefined;
  try {
    declaredLength = parseContentLength(request);
  } catch (error: unknown) {
    closeResponse(response, 400, responseBodyText((error as Error).message));
    destroyRequestAfterResponse(request, response);
    return;
  }

  if (declaredLength !== undefined && declaredLength > options.maxBodyBytes) {
    closeResponse(response, 413, responseBodyText('request body too large'));
    destroyRequestAfterResponse(request, response);
    return;
  }

  const chunks: Buffer[] = [];
  let receivedBytes = 0;
  let rejected = false;

  request.on('data', (chunk: Buffer | string) => {
    if (rejected) {
      return;
    }
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    receivedBytes += bytes.byteLength;
    if (receivedBytes > options.maxBodyBytes) {
      rejected = true;
      chunks.length = 0;
      closeResponse(
        response,
        413,
        responseBodyText(
          new HttpIpcBodyLimitError('request', options.maxBodyBytes, receivedBytes).message,
        ),
      );
      destroyRequestAfterResponse(request, response);
      return;
    }
    chunks.push(bytes);
  });

  request.once('aborted', () => {
    rejected = true;
  });
  request.once('error', () => {
    rejected = true;
  });
  request.once('end', async () => {
    if (rejected || response.writableEnded) {
      return;
    }

    const payload = Buffer.concat(chunks, receivedBytes);
    try {
      const responsePayload = Buffer.from(await options.handler(payload, request));
      if (responsePayload.byteLength > options.maxResponseBytes) {
        closeResponse(response, 500, responseBodyText('response body too large'));
        return;
      }
      response.statusCode = 200;
      response.shouldKeepAlive = false;
      response.setHeader('Connection', 'close');
      response.setHeader('Content-Type', 'application/octet-stream');
      response.setHeader('Content-Length', responsePayload.byteLength);
      response.end(responsePayload);
    } catch {
      closeResponse(response, 500, responseBodyText('handler failed'));
    }
  });
}

/** Bind one HTTP request/response operation to a local IPC endpoint. */
export async function bindHttpIpc(options: HttpIpcServerOptions): Promise<HttpIpcServer> {
  if (typeof options.endpoint !== 'string' || options.endpoint.length === 0) {
    throw new TypeError('HTTP IPC endpoint must be a non-empty string');
  }
  if (typeof options.handler !== 'function') {
    throw new TypeError('HTTP IPC handler must be a function');
  }

  const maxBodyBytes = normalizeByteLimit(
    options.maxBodyBytes,
    DEFAULT_HTTP_MAX_BODY_BYTES,
    'maxBodyBytes',
  );
  const maxResponseBytes = normalizeByteLimit(
    options.maxResponseBytes,
    DEFAULT_HTTP_MAX_RESPONSE_BYTES,
    'maxResponseBytes',
  );
  const counters: ServerCounters = { connectionCount: 0, requestCount: 0 };
  const sockets = new Set<Socket>();
  let boundServer: Server | undefined;

  const server = createServer((request, response) => {
    void handleRequest(
      request,
      response,
      {
        ...options,
        maxBodyBytes,
        maxResponseBytes,
      },
      counters,
    );
  });
  boundServer = server;
  server.keepAliveTimeout = 0;
  server.maxRequestsPerSocket = 1;
  server.requestTimeout = 0;
  server.on('connection', (socket) => {
    counters.connectionCount += 1;
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  server.on('clientError', (_error, socket) => {
    if (!socket.destroyed) {
      socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    }
  });

  const startedAt = performance.now();
  try {
    await new Promise<void>((resolve, reject) => {
      const onListening = (): void => {
        server.off('error', onError);
        resolve();
      };
      const onError = (error: Error): void => {
        server.off('listening', onListening);
        reject(error);
      };
      server.once('listening', onListening);
      server.once('error', onError);
      server.listen(options.endpoint);
    });
  } catch (error: unknown) {
    boundServer = undefined;
    sockets.clear();
    try {
      server.close();
    } catch {
      // The server may not have reached the listening state.
    }
    throw error;
  }

  let closePromise: Promise<void> | undefined;
  const bound: HttpIpcServer = {
    endpoint: options.endpoint,
    startupMs: performance.now() - startedAt,
    maxBodyBytes,
    maxResponseBytes,
    keepAlive: false,
    get connectionCount(): number {
      return counters.connectionCount;
    },
    get requestCount(): number {
      return counters.requestCount;
    },
    get activeConnectionCount(): number {
      return sockets.size;
    },
    close(closeOptions: HttpIpcCloseOptions = {}): Promise<void> {
      if (boundServer === undefined) {
        return Promise.resolve();
      }
      closePromise ??= closeServer(boundServer, options.endpoint, sockets, closeOptions).finally(
        () => {
          boundServer = undefined;
        },
      );
      return closePromise;
    },
  };
  return bound;
}

/** Request one HTTP body and return only the successful response payload. */
export async function requestHttpIpc(
  endpoint: string,
  payload: Uint8Array,
  options: HttpIpcRequestOptions = {},
): Promise<Buffer> {
  const response = await requestHttpIpcResponse(endpoint, payload, options);
  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw new HttpIpcResponseError(response);
  }
  return response.body;
}

/** Request one HTTP body and retain status/headers for comparison assertions. */
export async function requestHttpIpcResponse(
  endpoint: string,
  payload: Uint8Array,
  options: HttpIpcRequestOptions = {},
): Promise<HttpIpcResponse> {
  if (typeof endpoint !== 'string' || endpoint.length === 0) {
    return Promise.reject(new TypeError('HTTP IPC endpoint must be a non-empty string'));
  }
  if (!(payload instanceof Uint8Array)) {
    return Promise.reject(new TypeError('HTTP IPC request payload must be a Uint8Array or Buffer'));
  }

  const body = Buffer.from(payload);
  const connectTimeoutMs = normalizeTimeout(
    options.connectTimeoutMs,
    DEFAULT_HTTP_CONNECT_TIMEOUT_MS,
    'connectTimeoutMs',
  );
  const writeTimeoutMs = normalizeTimeout(
    options.writeTimeoutMs,
    DEFAULT_HTTP_WRITE_TIMEOUT_MS,
    'writeTimeoutMs',
  );
  const readTimeoutMs = normalizeTimeout(
    options.readTimeoutMs,
    DEFAULT_HTTP_READ_TIMEOUT_MS,
    'readTimeoutMs',
  );
  const maxResponseBytes = normalizeByteLimit(
    options.maxResponseBytes,
    DEFAULT_HTTP_MAX_RESPONSE_BYTES,
    'maxResponseBytes',
  );
  const path = options.path ?? HTTP_PATH;

  return new Promise<HttpIpcResponse>((resolve, reject) => {
    let clientRequest: ClientRequest | undefined;
    let socket: Socket | undefined;
    let settled = false;
    let connectTimer: PhaseTimer | undefined;
    let writeTimer: PhaseTimer | undefined;
    let readTimer: PhaseTimer | undefined;
    let removeAbortListener = (): void => undefined;
    let connectHandled = false;
    let readStarted = false;

    const clearTimers = (): void => {
      connectTimer?.cancel();
      writeTimer?.cancel();
      readTimer?.cancel();
    };

    const settleFailure = (error: unknown): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimers();
      removeAbortListener();
      const failure = error instanceof Error ? error : new Error(String(error));
      reject(failure);
      if (clientRequest !== undefined && !clientRequest.destroyed) {
        clientRequest.destroy(failure);
      }
      if (socket !== undefined && !socket.destroyed) {
        socket.destroy();
      }
    };

    const settleSuccess = (response: HttpIpcResponse): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimers();
      removeAbortListener();
      resolve(response);
    };

    const startReadPhase = (): void => {
      if (readStarted || settled) {
        return;
      }
      readStarted = true;
      readTimer = armPhaseTimer('read', readTimeoutMs, settleFailure);
    };

    const onRequestFinished = (): void => {
      writeTimer?.cancel();
      writeTimer = undefined;
      startReadPhase();
    };

    const onSocketConnected = (): void => {
      if (connectHandled || settled) {
        return;
      }
      connectHandled = true;
      connectTimer?.cancel();
      connectTimer = undefined;
      writeTimer = armPhaseTimer('write', writeTimeoutMs, settleFailure);
      if (settled) {
        return;
      }
      clientRequest?.end(body);
    };

    const onSocket = (candidate: Socket): void => {
      socket = candidate;
      candidate.once('connect', onSocketConnected);
      if (!candidate.connecting) {
        queueMicrotask(onSocketConnected);
      }
    };

    const onResponse = (response: IncomingMessage): void => {
      if (settled) {
        response.resume();
        return;
      }
      startReadPhase();
      const chunks: Buffer[] = [];
      let receivedBytes = 0;
      response.on('data', (chunk: Buffer | string) => {
        if (settled) {
          return;
        }
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        receivedBytes += bytes.byteLength;
        if (receivedBytes > maxResponseBytes) {
          settleFailure(new HttpIpcBodyLimitError('response', maxResponseBytes, receivedBytes));
          return;
        }
        chunks.push(bytes);
      });
      response.once('aborted', () => {
        settleFailure(new HttpIpcProtocolError('HTTP response ended before its body completed'));
      });
      response.once('error', settleFailure);
      response.once('end', () => {
        if (settled) {
          return;
        }
        settleSuccess({
          statusCode: response.statusCode ?? 0,
          headers: response.headers,
          body: Buffer.concat(chunks, receivedBytes),
        });
      });
    };

    const onRequestError = (error: Error): void => {
      settleFailure(error);
    };

    try {
      if (options.signal?.aborted) {
        settleFailure(errorFromAbortReason(options.signal.reason));
        return;
      }
      connectTimer = armPhaseTimer('connect', connectTimeoutMs, settleFailure);
      if (settled) {
        return;
      }
      clientRequest = createRequest({
        socketPath: endpoint,
        method: HTTP_METHOD,
        path,
        agent: false,
        headers: {
          Connection: 'close',
          'Content-Length': body.byteLength,
          'Content-Type': 'application/octet-stream',
        },
      });
      clientRequest.once('socket', onSocket);
      clientRequest.once('finish', onRequestFinished);
      clientRequest.on('response', onResponse);
      clientRequest.on('error', onRequestError);

      removeAbortListener = (): void => {
        options.signal?.removeEventListener('abort', onAbort);
      };
      const onAbort = (): void => {
        settleFailure(errorFromAbortReason(options.signal?.reason));
      };
      options.signal?.addEventListener('abort', onAbort, { once: true });
    } catch (error: unknown) {
      settleFailure(error);
    }
  });
}
