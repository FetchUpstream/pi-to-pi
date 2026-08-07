/**
 * Throwaway HTTP-over-local-IPC comparison candidate.
 *
 * This fixture deliberately stays under tests/fixtures and does not import any
 * production transport or Pi message/task module. It uses Node's HTTP parser on
 * top of the path-based IPC endpoint accepted by `http.Server.listen` and
 * `http.request({ socketPath })`.
 */
import { lstat, unlink } from 'node:fs/promises';
import { createConnection, type Socket } from 'node:net';
import { createServer, request as createRequest } from 'node:http';
import type {
  ClientRequest,
  IncomingHttpHeaders,
  IncomingMessage,
  Server,
  ServerResponse,
} from 'node:http';
import { performance } from 'node:perf_hooks';

import { createIpcEndpoint, type IpcEndpointOptions } from '../local-ipc/index.js';
import {
  AbortError,
  PhaseDeadlineExceededError,
  onAbort,
  throwIfAborted,
  withPhaseDeadline,
} from '../local-ipc-spike/test-helpers.js';

export const DEFAULT_HTTP_MAX_BODY_BYTES = 64 * 1024;
export const DEFAULT_HTTP_MAX_RESPONSE_BYTES = 64 * 1024;
export const DEFAULT_HTTP_CONNECT_TIMEOUT_MS = 1_000;
export const DEFAULT_HTTP_WRITE_TIMEOUT_MS = 1_000;
export const DEFAULT_HTTP_READ_TIMEOUT_MS = 1_000;
export const DEFAULT_HTTP_REQUEST_TIMEOUT_MS = 1_000;
export const DEFAULT_HTTP_HANDLER_TIMEOUT_MS = 1_000;
export const DEFAULT_HTTP_CLOSE_TIMEOUT_MS = 1_000;
export const DEFAULT_HTTP_FORCE_CLOSE_TIMEOUT_MS = 250;

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
  /** Absolute deadline for receiving one request body. */
  readonly requestTimeoutMs?: number;
  /** Absolute deadline for executing one handler. */
  readonly handlerTimeoutMs?: number;
}

export interface HttpIpcRequestOptions {
  readonly connectTimeoutMs?: number;
  readonly writeTimeoutMs?: number;
  readonly readTimeoutMs?: number;
  /** Maximum request body sent by the HTTP client. */
  readonly maxBodyBytes?: number;
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
  readonly requestTimeoutMs: number;
  readonly handlerTimeoutMs: number;
  readonly keepAlive: false;
  readonly connectionCount: number;
  readonly requestCount: number;
  readonly activeConnectionCount: number;
  close(options?: HttpIpcCloseOptions): Promise<void>;
}

export type HttpIpcHandler = (
  payload: Buffer,
  request: IncomingMessage,
  signal: AbortSignal,
) => Awaitable<Uint8Array>;

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

interface ServerCounters {
  connectionCount: number;
  requestCount: number;
}

interface UnixSocketIdentity {
  readonly dev: number;
  readonly ino: number;
}

interface NormalizedHttpIpcServerOptions {
  readonly endpoint: string;
  readonly handler: HttpIpcHandler;
  readonly maxBodyBytes: number;
  readonly maxResponseBytes: number;
  readonly requestTimeoutMs: number;
  readonly handlerTimeoutMs: number;
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

function parseContentLength(headers: IncomingHttpHeaders, label: string): number | undefined {
  const value = headers['content-length'];
  if (value === undefined) {
    return undefined;
  }
  if (Array.isArray(value) || !/^\d+$/.test(value)) {
    throw new HttpIpcProtocolError(
      `${label} Content-Length must be a non-negative decimal integer`,
    );
  }
  const length = Number(value);
  if (!Number.isSafeInteger(length)) {
    throw new HttpIpcProtocolError(`${label} Content-Length exceeds the safe integer range`);
  }
  return length;
}

function responseBodyText(message: string): Buffer {
  return Buffer.from(message, 'utf8');
}

function closeResponse(response: ServerResponse, statusCode: number, body: Buffer): void {
  if (response.destroyed || response.writableEnded) {
    return;
  }
  if (response.headersSent) {
    response.destroy();
    return;
  }
  response.statusCode = statusCode;
  response.shouldKeepAlive = false;
  response.setHeader('Connection', 'close');
  response.setHeader('Content-Length', body.byteLength);
  response.end(body);
}

function destroyRequestAfterResponse(request: IncomingMessage, response: ServerResponse): void {
  if (!request.destroyed) {
    request.resume();
  }
  const destroyRequest = (): void => {
    if (!request.destroyed) {
      request.destroy();
    }
  };
  response.once('finish', destroyRequest);
  response.once('close', destroyRequest);
  if (response.writableEnded) {
    queueMicrotask(destroyRequest);
  }
}

async function collectRequestBody(
  request: IncomingMessage,
  maxBodyBytes: number,
  signal: AbortSignal,
): Promise<Buffer> {
  const declaredLength = parseContentLength(request.headers, 'HTTP request');
  if (declaredLength !== undefined && declaredLength > maxBodyBytes) {
    throw new HttpIpcBodyLimitError('request', maxBodyBytes, declaredLength);
  }

  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let receivedBytes = 0;
    let settled = false;
    let removeAbort = (): void => undefined;

    const cleanup = (): void => {
      request.off('data', onData);
      request.off('end', onEnd);
      request.off('aborted', onAborted);
      request.off('error', onError);
      request.off('close', onClose);
      removeAbort();
    };
    const settleSuccess = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve(Buffer.concat(chunks, receivedBytes));
    };
    const settleFailure = (error: unknown): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(error instanceof Error ? error : new Error(String(error)));
    };
    const onData = (chunk: Buffer | string): void => {
      if (settled) {
        return;
      }
      const chunkBytes = Buffer.isBuffer(chunk) ? chunk.byteLength : Buffer.byteLength(chunk);
      if (chunkBytes > maxBodyBytes - receivedBytes) {
        const received = maxBodyBytes + 1;
        settleFailure(new HttpIpcBodyLimitError('request', maxBodyBytes, received));
        if (!request.destroyed) {
          request.destroy();
        }
        return;
      }
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      receivedBytes += bytes.byteLength;
      chunks.push(bytes);
    };
    const onEnd = (): void => {
      settleSuccess();
    };
    const onAborted = (): void => {
      settleFailure(new HttpIpcProtocolError('HTTP request ended before its body completed'));
    };
    const onError = (error: Error): void => {
      settleFailure(error);
    };
    const onClose = (): void => {
      if (!settled && !request.complete) {
        settleFailure(new HttpIpcProtocolError('HTTP request closed before its body completed'));
      }
    };

    request.on('data', onData);
    request.once('end', onEnd);
    request.once('aborted', onAborted);
    request.once('error', onError);
    request.once('close', onClose);
    removeAbort = onAbort(signal, (error) => {
      if (!request.destroyed) {
        request.destroy();
      }
      settleFailure(error);
    });
  });
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  options: NormalizedHttpIpcServerOptions,
  counters: ServerCounters,
  shutdownSignal: AbortSignal,
  lifecycleController: AbortController,
): Promise<void> {
  counters.requestCount += 1;
  response.shouldKeepAlive = false;
  response.setHeader('Connection', 'close');

  const removeShutdownAbort = onAbort(shutdownSignal, (error) => {
    lifecycleController.abort(error);
    if (!request.destroyed) {
      request.destroy();
    }
    if (!response.destroyed) {
      response.destroy();
    }
  });
  const onRequestAborted = (): void => {
    if (!request.complete) {
      lifecycleController.abort(new AbortError('HTTP request was aborted'));
    }
  };
  const onRequestError = (error: Error): void => {
    lifecycleController.abort(new AbortError(error.message, error));
  };
  const onResponseError = (error: Error): void => {
    lifecycleController.abort(new AbortError(error.message, error));
  };
  const onResponseClose = (): void => {
    if (!response.writableEnded) {
      lifecycleController.abort(new AbortError('HTTP response was closed'));
    }
  };

  request.once('aborted', onRequestAborted);
  request.once('error', onRequestError);
  response.once('error', onResponseError);
  response.once('close', onResponseClose);

  try {
    if (shutdownSignal.aborted || lifecycleController.signal.aborted) {
      return;
    }

    if (request.method !== HTTP_METHOD || request.url !== HTTP_PATH) {
      closeResponse(
        response,
        request.method === HTTP_METHOD ? 404 : 405,
        responseBodyText('not found'),
      );
      destroyRequestAfterResponse(request, response);
      return;
    }

    const payload = await withPhaseDeadline(
      'request',
      options.requestTimeoutMs,
      (signal) => collectRequestBody(request, options.maxBodyBytes, signal),
      {
        signal: lifecycleController.signal,
        onTimeout: () => {
          if (!request.destroyed) {
            request.destroy();
          }
        },
      },
    );

    if (lifecycleController.signal.aborted) {
      return;
    }

    const responsePayload = await withPhaseDeadline(
      'handler',
      options.handlerTimeoutMs,
      (signal) => options.handler(payload, request, signal),
      {
        signal: lifecycleController.signal,
        onTimeout: () => {
          if (!request.destroyed) {
            request.destroy();
          }
        },
      },
    );

    if (lifecycleController.signal.aborted || response.destroyed) {
      return;
    }
    if (!(responsePayload instanceof Uint8Array)) {
      throw new TypeError('HTTP IPC handler must return a Uint8Array or Buffer');
    }
    if (responsePayload.byteLength > options.maxResponseBytes) {
      throw new HttpIpcBodyLimitError(
        'response',
        options.maxResponseBytes,
        responsePayload.byteLength,
      );
    }

    const body = Buffer.from(responsePayload);
    response.statusCode = 200;
    response.shouldKeepAlive = false;
    response.setHeader('Connection', 'close');
    response.setHeader('Content-Type', 'application/octet-stream');
    response.setHeader('Content-Length', body.byteLength);
    response.end(body);
    destroyRequestAfterResponse(request, response);
  } catch (error: unknown) {
    if (error instanceof HttpIpcBodyLimitError) {
      closeResponse(
        response,
        error.side === 'request' ? 413 : 500,
        responseBodyText(error.message),
      );
      destroyRequestAfterResponse(request, response);
      return;
    }
    if (error instanceof PhaseDeadlineExceededError) {
      const statusCode = error.phase === 'request' ? 408 : 504;
      closeResponse(response, statusCode, responseBodyText(error.message));
      destroyRequestAfterResponse(request, response);
      return;
    }
    if (lifecycleController.signal.aborted || error instanceof AbortError) {
      return;
    }
    closeResponse(response, 500, responseBodyText('handler failed'));
    destroyRequestAfterResponse(request, response);
  } finally {
    removeShutdownAbort();
    request.off('aborted', onRequestAborted);
    request.off('error', onRequestError);
    response.off('error', onResponseError);
    response.off('close', onResponseClose);
  }
}

async function captureOwnedUnixSocket(endpoint: string): Promise<UnixSocketIdentity | undefined> {
  if (process.platform === 'win32' || endpointKind(endpoint) !== 'unix-socket') {
    return undefined;
  }
  const stat = await lstat(endpoint);
  if (!stat.isSocket()) {
    throw new HttpIpcProtocolError('HTTP IPC endpoint is not a Unix socket after listening');
  }
  return { dev: stat.dev, ino: stat.ino };
}

function sameUnixSocketIdentity(
  stat: { readonly dev: number; readonly ino: number },
  identity: UnixSocketIdentity,
): boolean {
  return stat.dev === identity.dev && stat.ino === identity.ino;
}

/**
 * A successful probe proves that another listener currently owns the path. A
 * probe that cannot finish is treated as live/unknown so cleanup never unlinks
 * an endpoint without first establishing that no replacement is listening.
 */
async function hasLiveUnixListener(endpoint: string): Promise<boolean> {
  let probe: Socket | undefined;
  const completion = new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (live: boolean): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (probe !== undefined && !probe.destroyed) {
        probe.destroy();
      }
      resolve(live);
    };

    try {
      probe = createConnection(endpoint);
      probe.once('connect', () => finish(true));
      probe.once('error', () => finish(false));
    } catch {
      finish(false);
    }
  });

  try {
    return await withPhaseDeadline(
      'endpoint-cleanup-probe',
      DEFAULT_HTTP_CLOSE_TIMEOUT_MS,
      completion,
      {
        onTimeout: () => {
          probe?.destroy();
        },
      },
    );
  } catch (error: unknown) {
    if (error instanceof PhaseDeadlineExceededError) {
      return true;
    }
    return true;
  }
}

/** Remove only the exact socket inode created by this bound server. */
async function removeOwnedUnixSocket(
  endpoint: string,
  identity: UnixSocketIdentity | undefined,
): Promise<void> {
  if (
    identity === undefined ||
    process.platform === 'win32' ||
    endpointKind(endpoint) !== 'unix-socket'
  ) {
    return;
  }

  let stat;
  try {
    stat = await lstat(endpoint);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return;
    }
    throw error;
  }
  if (!stat.isSocket() || !sameUnixSocketIdentity(stat, identity)) {
    return;
  }
  if (await hasLiveUnixListener(endpoint)) {
    return;
  }

  const finalStat = await lstat(endpoint).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined;
    }
    throw error;
  });
  if (
    finalStat === undefined ||
    !finalStat.isSocket() ||
    !sameUnixSocketIdentity(finalStat, identity)
  ) {
    return;
  }
  if (await hasLiveUnixListener(endpoint)) {
    return;
  }

  try {
    await unlink(endpoint);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }
}

function forceCloseServer(server: Server, sockets: Set<Socket>): void {
  for (const socket of sockets) {
    socket.destroy();
  }
  server.closeAllConnections();
}

async function closeServer(
  server: Server,
  endpoint: string,
  identity: UnixSocketIdentity | undefined,
  sockets: Set<Socket>,
  activeRequests: Set<AbortController>,
  pendingHeaders: Map<Socket, () => void>,
  shutdownController: AbortController,
  options: HttpIpcCloseOptions,
): Promise<void> {
  const timeoutMs = normalizeTimeout(
    options.timeoutMs,
    DEFAULT_HTTP_CLOSE_TIMEOUT_MS,
    'closeTimeoutMs',
  );
  const shutdownError = new AbortError('HTTP IPC server is closing');
  shutdownController.abort(shutdownError);
  for (const controller of activeRequests) {
    controller.abort(shutdownError);
  }
  for (const [socket, settle] of pendingHeaders) {
    settle();
    socket.destroy();
  }

  let closeFailure: unknown;
  let closeOperation: Promise<void>;
  try {
    closeOperation = new Promise<void>((resolve, reject) => {
      try {
        server.close((error?: Error) => {
          if (
            error !== undefined &&
            (error as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING'
          ) {
            reject(error);
            return;
          }
          resolve();
        });
      } catch (error: unknown) {
        reject(error);
      }
    });
  } catch (error: unknown) {
    closeFailure = error;
    closeOperation = Promise.resolve();
  }

  try {
    await withPhaseDeadline('close', timeoutMs, closeOperation, {
      onTimeout: () => forceCloseServer(server, sockets),
    });
  } catch (error: unknown) {
    if (error instanceof PhaseDeadlineExceededError) {
      forceCloseServer(server, sockets);
      try {
        await withPhaseDeadline(
          'close-force',
          DEFAULT_HTTP_FORCE_CLOSE_TIMEOUT_MS,
          closeOperation,
          { onTimeout: () => forceCloseServer(server, sockets) },
        );
      } catch (forceError: unknown) {
        if (!(forceError instanceof PhaseDeadlineExceededError)) {
          closeFailure ??= forceError;
        }
      }
    } else {
      closeFailure ??= error;
    }
  }

  let cleanupFailure: unknown;
  try {
    await removeOwnedUnixSocket(endpoint, identity);
  } catch (error: unknown) {
    cleanupFailure = error;
  }

  if (closeFailure !== undefined && cleanupFailure !== undefined) {
    throw new AggregateError([closeFailure, cleanupFailure], 'HTTP IPC close failed');
  }
  if (closeFailure !== undefined) {
    throw closeFailure;
  }
  if (cleanupFailure !== undefined) {
    throw cleanupFailure;
  }
}

/** Bind one HTTP request/response operation to a local IPC endpoint. */
export async function bindHttpIpc(options: HttpIpcServerOptions): Promise<HttpIpcServer> {
  if (typeof options.endpoint !== 'string' || options.endpoint.length === 0) {
    throw new TypeError('HTTP IPC endpoint must be a non-empty string');
  }
  if (typeof options.handler !== 'function') {
    throw new TypeError('HTTP IPC handler must be a function');
  }

  const normalized: NormalizedHttpIpcServerOptions = {
    endpoint: options.endpoint,
    handler: options.handler,
    maxBodyBytes: normalizeByteLimit(
      options.maxBodyBytes,
      DEFAULT_HTTP_MAX_BODY_BYTES,
      'maxBodyBytes',
    ),
    maxResponseBytes: normalizeByteLimit(
      options.maxResponseBytes,
      DEFAULT_HTTP_MAX_RESPONSE_BYTES,
      'maxResponseBytes',
    ),
    requestTimeoutMs: normalizeTimeout(
      options.requestTimeoutMs,
      DEFAULT_HTTP_REQUEST_TIMEOUT_MS,
      'requestTimeoutMs',
    ),
    handlerTimeoutMs: normalizeTimeout(
      options.handlerTimeoutMs,
      DEFAULT_HTTP_HANDLER_TIMEOUT_MS,
      'handlerTimeoutMs',
    ),
  };
  const counters: ServerCounters = { connectionCount: 0, requestCount: 0 };
  const sockets = new Set<Socket>();
  const activeRequests = new Set<AbortController>();
  const pendingHeaders = new Map<Socket, () => void>();
  const shutdownController = new AbortController();
  const server = createServer((request, response) => {
    pendingHeaders.get(request.socket)?.();

    const lifecycleController = new AbortController();
    activeRequests.add(lifecycleController);
    void handleRequest(
      request,
      response,
      normalized,
      counters,
      shutdownController.signal,
      lifecycleController,
    ).finally(() => {
      activeRequests.delete(lifecycleController);
    });
  });

  server.keepAliveTimeout = 0;
  server.maxRequestsPerSocket = 1;
  server.requestTimeout = Math.max(1, normalized.requestTimeoutMs);
  server.headersTimeout = Math.max(1, normalized.requestTimeoutMs);
  server.on('connection', (socket) => {
    counters.connectionCount += 1;
    sockets.add(socket);

    let settleHeaderDeadline = (): void => undefined;
    const completion = new Promise<void>((resolve) => {
      settleHeaderDeadline = resolve;
    });
    pendingHeaders.set(socket, settleHeaderDeadline);
    void withPhaseDeadline('request-headers', normalized.requestTimeoutMs, completion, {
      onTimeout: () => socket.destroy(),
    })
      .catch(() => undefined)
      .finally(() => {
        if (pendingHeaders.get(socket) === settleHeaderDeadline) {
          pendingHeaders.delete(socket);
        }
      });

    socket.once('close', () => {
      sockets.delete(socket);
      settleHeaderDeadline();
    });
  });
  server.on('clientError', (_error, socket) => {
    if (!socket.destroyed) {
      socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    }
  });

  let ownedEndpoint: UnixSocketIdentity | undefined;
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
      server.listen(normalized.endpoint);
    });
    ownedEndpoint = await captureOwnedUnixSocket(normalized.endpoint);
  } catch (error: unknown) {
    try {
      await closeServer(
        server,
        normalized.endpoint,
        ownedEndpoint,
        sockets,
        activeRequests,
        pendingHeaders,
        shutdownController,
        { timeoutMs: DEFAULT_HTTP_CLOSE_TIMEOUT_MS },
      );
    } catch (cleanupError: unknown) {
      throw new AggregateError([error, cleanupError], 'HTTP IPC startup and cleanup failed');
    }
    throw error;
  }

  let boundServer: Server | undefined = server;
  let closePromise: Promise<void> | undefined;
  const bound: HttpIpcServer = {
    endpoint: normalized.endpoint,
    startupMs: performance.now() - startedAt,
    maxBodyBytes: normalized.maxBodyBytes,
    maxResponseBytes: normalized.maxResponseBytes,
    requestTimeoutMs: normalized.requestTimeoutMs,
    handlerTimeoutMs: normalized.handlerTimeoutMs,
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
      closePromise ??= closeServer(
        boundServer,
        normalized.endpoint,
        ownedEndpoint,
        sockets,
        activeRequests,
        pendingHeaders,
        shutdownController,
        closeOptions,
      ).finally(() => {
        boundServer = undefined;
      });
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

function waitForSocketConnected(
  request: ClientRequest,
  signal: AbortSignal,
  assignSocket: (socket: Socket) => void,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let socket: Socket | undefined;
    let settled = false;
    let removeAbort = (): void => undefined;

    const cleanup = (): void => {
      request.off('socket', onSocket);
      request.off('error', onError);
      socket?.off('connect', onConnect);
      socket?.off('error', onError);
      removeAbort();
    };
    const settleSuccess = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve();
    };
    const settleFailure = (error: unknown): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(error instanceof Error ? error : new Error(String(error)));
    };
    const onConnect = (): void => {
      settleSuccess();
    };
    const onError = (error: Error): void => {
      settleFailure(error);
    };
    const onSocket = (candidate: Socket): void => {
      socket = candidate;
      assignSocket(candidate);
      candidate.once('connect', onConnect);
      candidate.once('error', onError);
      if (!candidate.connecting) {
        queueMicrotask(onConnect);
      }
    };

    request.once('socket', onSocket);
    request.once('error', onError);
    removeAbort = onAbort(signal, settleFailure);
  });
}

function sendRequestAndWaitForFinish(
  request: ClientRequest,
  body: Buffer,
  signal: AbortSignal,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    let removeAbort = (): void => undefined;

    const cleanup = (): void => {
      request.off('finish', onFinish);
      request.off('error', onError);
      removeAbort();
    };
    const settleSuccess = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve();
    };
    const settleFailure = (error: unknown): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(error instanceof Error ? error : new Error(String(error)));
    };
    const onFinish = (): void => {
      settleSuccess();
    };
    const onError = (error: Error): void => {
      settleFailure(error);
    };

    request.once('finish', onFinish);
    request.once('error', onError);
    removeAbort = onAbort(signal, settleFailure);
    try {
      request.end(body);
    } catch (error: unknown) {
      settleFailure(error);
    }
  });
}

function waitForResponse(request: ClientRequest, signal: AbortSignal): Promise<IncomingMessage> {
  return new Promise<IncomingMessage>((resolve, reject) => {
    let settled = false;
    let removeAbort = (): void => undefined;

    const cleanup = (): void => {
      request.off('response', onResponse);
      request.off('error', onError);
      removeAbort();
    };
    const settleSuccess = (response: IncomingMessage): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve(response);
    };
    const settleFailure = (error: unknown): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(error instanceof Error ? error : new Error(String(error)));
    };
    const onResponse = (response: IncomingMessage): void => {
      settleSuccess(response);
    };
    const onError = (error: Error): void => {
      settleFailure(error);
    };

    request.once('response', onResponse);
    request.once('error', onError);
    removeAbort = onAbort(signal, settleFailure);
  });
}

async function readHttpResponse(
  response: IncomingMessage,
  maxResponseBytes: number,
  signal: AbortSignal,
): Promise<HttpIpcResponse> {
  const declaredLength = parseContentLength(response.headers, 'HTTP response');
  if (declaredLength !== undefined && declaredLength > maxResponseBytes) {
    throw new HttpIpcBodyLimitError('response', maxResponseBytes, declaredLength);
  }

  return new Promise<HttpIpcResponse>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let receivedBytes = 0;
    let settled = false;
    let removeAbort = (): void => undefined;

    const cleanup = (): void => {
      response.off('data', onData);
      response.off('end', onEnd);
      response.off('aborted', onAborted);
      response.off('error', onError);
      response.off('close', onClose);
      removeAbort();
    };
    const settleSuccess = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve({
        statusCode: response.statusCode ?? 0,
        headers: response.headers,
        body: Buffer.concat(chunks, receivedBytes),
      });
    };
    const settleFailure = (error: unknown): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(error instanceof Error ? error : new Error(String(error)));
    };
    const onData = (chunk: Buffer | string): void => {
      if (settled) {
        return;
      }
      const chunkBytes = Buffer.isBuffer(chunk) ? chunk.byteLength : Buffer.byteLength(chunk);
      if (chunkBytes > maxResponseBytes - receivedBytes) {
        settleFailure(
          new HttpIpcBodyLimitError('response', maxResponseBytes, maxResponseBytes + 1),
        );
        if (!response.destroyed) {
          response.destroy();
        }
        return;
      }
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      receivedBytes += bytes.byteLength;
      chunks.push(bytes);
    };
    const onEnd = (): void => {
      settleSuccess();
    };
    const onAborted = (): void => {
      settleFailure(new HttpIpcProtocolError('HTTP response ended before its body completed'));
    };
    const onError = (error: Error): void => {
      settleFailure(error);
    };
    const onClose = (): void => {
      if (!settled && !response.complete) {
        settleFailure(new HttpIpcProtocolError('HTTP response closed before its body completed'));
      }
    };

    response.on('data', onData);
    response.once('end', onEnd);
    response.once('aborted', onAborted);
    response.once('error', onError);
    response.once('close', onClose);
    removeAbort = onAbort(signal, (error) => {
      if (!response.destroyed) {
        response.destroy();
      }
      settleFailure(error);
    });
  });
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

  throwIfAborted(options.signal);
  const maxBodyBytes = normalizeByteLimit(
    options.maxBodyBytes,
    DEFAULT_HTTP_MAX_BODY_BYTES,
    'maxBodyBytes',
  );
  if (payload.byteLength > maxBodyBytes) {
    throw new HttpIpcBodyLimitError('request', maxBodyBytes, payload.byteLength);
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
    let responseMessage: IncomingMessage | undefined;
    let settled = false;
    let readStarted = false;
    let cancelPhase = (): void => undefined;
    let removeAbort = (): void => undefined;

    const destroyResources = (error?: Error): void => {
      if (clientRequest !== undefined && !clientRequest.destroyed) {
        clientRequest.destroy(error);
      }
      if (socket !== undefined && !socket.destroyed) {
        socket.destroy();
      }
    };
    const settleFailure = (error: unknown): void => {
      if (settled) {
        return;
      }
      settled = true;
      cancelPhase();
      removeAbort();
      const failure = error instanceof Error ? error : new Error(String(error));
      reject(failure);
      destroyResources(failure);
    };
    const settleSuccess = (response: HttpIpcResponse): void => {
      if (settled) {
        return;
      }
      settled = true;
      cancelPhase();
      removeAbort();
      resolve(response);
    };
    const onRequestError = (error: Error): void => {
      settleFailure(error);
    };
    const captureResponse = (response: IncomingMessage): void => {
      if (settled) {
        response.resume();
        response.destroy();
        return;
      }
      if (responseMessage !== undefined) {
        response.resume();
        response.destroy();
        return;
      }
      responseMessage = response;
    };
    const startPhase = <T>(
      phase: string,
      timeoutMs: number,
      operation: (signal: AbortSignal) => Awaitable<T>,
      onComplete: (value: T) => void,
    ): void => {
      cancelPhase();
      const phaseController = new AbortController();
      let active = true;
      const cancel = (): void => {
        if (active) {
          active = false;
          phaseController.abort(new AbortError(`HTTP IPC ${phase} phase was cancelled`));
        }
      };
      cancelPhase = cancel;
      void withPhaseDeadline(
        phase,
        timeoutMs,
        (deadlineSignal) => operation(AbortSignal.any([deadlineSignal, phaseController.signal])),
        {
          signal: options.signal,
          onTimeout: () => destroyResources(),
        },
      ).then(
        (value) => {
          active = false;
          if (!settled) {
            onComplete(value);
          }
        },
        (error: unknown) => {
          active = false;
          settleFailure(error);
        },
      );
    };
    const startReadPhase = (): void => {
      if (readStarted || settled || clientRequest === undefined) {
        return;
      }
      readStarted = true;
      startPhase(
        'read',
        readTimeoutMs,
        (signal) => {
          const response = responseMessage;
          if (response !== undefined) {
            return readHttpResponse(response, maxResponseBytes, signal);
          }
          return waitForResponse(clientRequest as ClientRequest, signal).then((nextResponse) =>
            readHttpResponse(nextResponse, maxResponseBytes, signal),
          );
        },
        settleSuccess,
      );
    };
    const startWritePhase = (): void => {
      if (settled || clientRequest === undefined) {
        return;
      }
      startPhase(
        'write',
        writeTimeoutMs,
        (signal) => sendRequestAndWaitForFinish(clientRequest as ClientRequest, body, signal),
        startReadPhase,
      );
    };

    try {
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
      clientRequest.on('response', captureResponse);
      clientRequest.on('error', onRequestError);
      removeAbort = onAbort(options.signal, settleFailure);
      startPhase(
        'connect',
        connectTimeoutMs,
        (signal) =>
          waitForSocketConnected(clientRequest as ClientRequest, signal, (candidate) => {
            socket = candidate;
          }),
        startWritePhase,
      );
    } catch (error: unknown) {
      settleFailure(error);
    }
  });
}
