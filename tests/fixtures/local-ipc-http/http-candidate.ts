/**
 * Throwaway HTTP-over-local-IPC comparison candidate.
 *
 * This fixture deliberately stays under tests/fixtures and does not import any
 * production transport or Pi message/task module. It uses Node's HTTP parser on
 * top of the path-based IPC endpoint accepted by `http.Server.listen` and
 * `http.request({ socketPath })`.
 */
import { link, lstat, readlink, rename, symlink, unlink } from 'node:fs/promises';
import type { BigIntStats } from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { EventEmitter } from 'node:events';
import { createConnection, type Socket } from 'node:net';
import { createServer, request as createRequest } from 'node:http';
import type { Duplex } from 'node:stream';
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
  createPhaseDeadline,
  PhaseDeadlineExceededError,
  onAbort,
  throwIfAborted,
  withDeadline,
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
  /** Absolute deadline for writing one response to the peer. */
  readonly writeTimeoutMs?: number;
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
  readonly writeTimeoutMs: number;
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

type UnixSocketIdentity = Pick<
  BigIntStats,
  'dev' | 'ino' | 'mode' | 'uid' | 'gid' | 'size' | 'mtimeNs' | 'ctimeNs' | 'birthtimeNs'
>;
type UnixObjectIdentity = Omit<UnixSocketIdentity, 'ctimeNs'>;
interface EndpointOperationLockOptions {
  readonly deadline?: ReturnType<typeof createPhaseDeadline>;
  readonly signal?: AbortSignal;
  /** Keep the lock held until detached resource work has actually settled. */
  readonly completion?: () => PromiseLike<unknown> | undefined;
}

interface NormalizedHttpIpcServerOptions {
  readonly endpoint: string;
  readonly handler: HttpIpcHandler;
  readonly maxBodyBytes: number;
  readonly maxResponseBytes: number;
  readonly requestTimeoutMs: number;
  readonly handlerTimeoutMs: number;
  readonly writeTimeoutMs: number;
}

const endpointOperationLocks = new Map<string, Promise<void>>();

/** Serialize candidate ownership transitions for an endpoint in this process. */
async function withEndpointOperationLock<T>(
  endpoint: string,
  operation: () => Promise<T>,
  lockOptions: EndpointOperationLockOptions = {},
): Promise<T> {
  const predecessor = endpointOperationLocks.get(endpoint);
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  endpointOperationLocks.set(endpoint, current);

  try {
    if (predecessor !== undefined) {
      if (lockOptions.deadline !== undefined) {
        await withDeadline(predecessor, lockOptions.deadline, { signal: lockOptions.signal });
      } else {
        await predecessor;
      }
    }
    return await operation();
  } finally {
    let completion: PromiseLike<unknown> | undefined;
    try {
      completion = lockOptions.completion?.();
    } catch {
      completion = undefined;
    }
    // A detached probe/startup completion must not strand this lock forever. The
    // completion remains part of ownership until it settles, while the absolute
    // deadline provides a terminal release point after the resource was forced to
    // close by the timed-out operation.
    const releasePredecessor =
      predecessor === undefined
        ? Promise.resolve()
        : settleLockCompletion(predecessor, lockOptions.deadline);
    const releaseCompletion = settleLockCompletion(completion, lockOptions.deadline);
    void Promise.all([releasePredecessor, releaseCompletion]).then(() => {
      release();
      if (endpointOperationLocks.get(endpoint) === current) {
        endpointOperationLocks.delete(endpoint);
      }
    });
  }
}

function settleLockCompletion(
  completion: PromiseLike<unknown> | undefined,
  deadline: ReturnType<typeof createPhaseDeadline> | undefined,
): Promise<void> {
  if (completion === undefined) {
    return Promise.resolve();
  }
  const observed = Promise.resolve(completion);
  if (deadline === undefined) {
    return observed.then(
      () => undefined,
      () => undefined,
    );
  }
  // Do not pass the caller signal here: cancellation stops the operation, but the
  // endpoint lock remains owned until detached work settles or its absolute
  // deadline is reached.
  return withDeadline(observed, deadline).then(
    () => undefined,
    () => undefined,
  );
}

interface EndpointCleanupTracker {
  readonly completion: Promise<void>;
  readonly track: <T>(operation: PromiseLike<T>) => Promise<T>;
  readonly finish: () => void;
}

function createEndpointCleanupTracker(): EndpointCleanupTracker {
  let pending = 0;
  let finished = false;
  let resolveCompletion!: () => void;
  const completion = new Promise<void>((resolve) => {
    resolveCompletion = resolve;
  });
  const settleIfFinished = (): void => {
    if (finished && pending === 0) {
      resolveCompletion();
    }
  };
  const track = <T>(operation: PromiseLike<T>): Promise<T> => {
    pending += 1;
    const tracked = Promise.resolve(operation);
    void tracked.then(
      () => {
        pending -= 1;
        settleIfFinished();
      },
      () => {
        pending -= 1;
        settleIfFinished();
      },
    );
    return tracked;
  };
  return {
    completion,
    track,
    finish: () => {
      finished = true;
      settleIfFinished();
    },
  };
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

const retainedErrorObservers = new WeakSet<EventEmitter>();

function retainErrorListenerUntilClose(
  stream: EventEmitter & { readonly destroyed?: boolean; readonly closed?: boolean },
): void {
  if (stream.destroyed === true || stream.closed === true || retainedErrorObservers.has(stream)) {
    return;
  }
  retainedErrorObservers.add(stream);
  const onError = (): void => undefined;
  const onClose = (): void => {
    retainedErrorObservers.delete(stream);
    stream.off('error', onError);
    stream.off('close', onClose);
  };
  stream.on('error', onError);
  stream.once('close', onClose);
}

function writeHttpResponse(
  response: ServerResponse,
  body: Buffer,
  signal: AbortSignal,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    let finished = false;
    let removeAbort = (): void => undefined;

    const cleanup = (): void => {
      response.off('finish', onFinish);
      response.off('close', onClose);
      response.off('error', onError);
      removeAbort();
    };
    const settleSuccess = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      retainErrorListenerUntilClose(response);
      cleanup();
      resolve();
    };
    const settleFailure = (error: unknown): void => {
      if (settled) {
        return;
      }
      settled = true;
      retainErrorListenerUntilClose(response);
      cleanup();
      reject(error instanceof Error ? error : new Error(String(error)));
    };
    const onFinish = (): void => {
      finished = true;
      settleSuccess();
    };
    const onClose = (): void => {
      if (!finished) {
        settleFailure(new HttpIpcProtocolError('HTTP response closed before its body was written'));
      }
    };
    const onError = (error: Error): void => {
      settleFailure(error);
    };

    response.once('finish', onFinish);
    response.once('close', onClose);
    response.once('error', onError);
    removeAbort = onAbort(signal, (error) => {
      if (!response.destroyed) {
        response.destroy();
      }
      settleFailure(error);
    });
    if (settled) {
      return;
    }

    try {
      response.end(body);
    } catch (error: unknown) {
      settleFailure(error);
    }
  });
}

function writeSocketAndEnd(
  socket: Socket | Duplex,
  body: Buffer,
  signal: AbortSignal,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    let finished = false;
    let removeAbort = (): void => undefined;

    const cleanup = (): void => {
      socket.off('finish', onFinish);
      socket.off('close', onClose);
      socket.off('error', onError);
      removeAbort();
    };
    const settleSuccess = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      retainErrorListenerUntilClose(socket);
      cleanup();
      resolve();
    };
    const settleFailure = (error: unknown): void => {
      if (settled) {
        return;
      }
      settled = true;
      retainErrorListenerUntilClose(socket);
      cleanup();
      reject(error instanceof Error ? error : new Error(String(error)));
    };
    const onFinish = (): void => {
      finished = true;
      settleSuccess();
    };
    const onClose = (): void => {
      if (!finished) {
        settleFailure(
          new HttpIpcProtocolError('HTTP socket closed before its response was written'),
        );
      }
    };
    const onError = (error: Error): void => {
      settleFailure(error);
    };

    socket.once('finish', onFinish);
    socket.once('close', onClose);
    socket.once('error', onError);
    removeAbort = onAbort(signal, (error) => {
      if (!socket.destroyed) {
        socket.destroy();
      }
      settleFailure(error);
    });
    if (settled) {
      return;
    }

    try {
      socket.end(body, onFinish);
    } catch (error: unknown) {
      settleFailure(error);
    }
  });
}

async function closeResponse(
  request: IncomingMessage,
  response: ServerResponse,
  statusCode: number,
  body: Buffer,
  signal: AbortSignal,
  writeTimeoutMs: number,
): Promise<void> {
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
  await withPhaseDeadline(
    'response-write',
    writeTimeoutMs,
    (writeSignal) => writeHttpResponse(response, body, writeSignal),
    {
      signal,
      onTimeout: () => {
        if (!request.destroyed) {
          request.destroy();
        }
        if (!response.destroyed) {
          response.destroy();
        }
      },
    },
  );
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
      retainErrorListenerUntilClose(request);
      cleanup();
      resolve(Buffer.concat(chunks, receivedBytes));
    };
    const settleFailure = (error: unknown): void => {
      if (settled) {
        return;
      }
      settled = true;
      retainErrorListenerUntilClose(request);
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
      if (!settled) {
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
      if (!response.destroyed) {
        response.destroy();
      }
    }
  };
  const onRequestError = (error: Error): void => {
    lifecycleController.abort(new AbortError(error.message, error));
    if (!request.destroyed) {
      request.destroy();
    }
    if (!response.destroyed) {
      response.destroy();
    }
  };
  const onResponseError = (error: Error): void => {
    lifecycleController.abort(new AbortError(error.message, error));
    if (!request.destroyed) {
      request.destroy();
    }
    if (!response.destroyed) {
      response.destroy();
    }
  };
  const onResponseClose = (): void => {
    if (!response.writableEnded) {
      lifecycleController.abort(new AbortError('HTTP response was closed'));
      if (!request.destroyed) {
        request.destroy();
      }
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
      await closeResponse(
        request,
        response,
        request.method === HTTP_METHOD ? 404 : 405,
        responseBodyText('not found'),
        lifecycleController.signal,
        options.writeTimeoutMs,
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
    await closeResponse(
      request,
      response,
      200,
      body,
      lifecycleController.signal,
      options.writeTimeoutMs,
    );
    destroyRequestAfterResponse(request, response);
  } catch (error: unknown) {
    if (error instanceof HttpIpcBodyLimitError) {
      await closeResponse(
        request,
        response,
        error.side === 'request' ? 413 : 500,
        responseBodyText(error.message),
        lifecycleController.signal,
        options.writeTimeoutMs,
      );
      destroyRequestAfterResponse(request, response);
      return;
    }
    if (error instanceof PhaseDeadlineExceededError) {
      const statusCode = error.phase === 'request' ? 408 : 504;
      await closeResponse(
        request,
        response,
        statusCode,
        responseBodyText(error.message),
        lifecycleController.signal,
        options.writeTimeoutMs,
      );
      destroyRequestAfterResponse(request, response);
      return;
    }
    if (lifecycleController.signal.aborted || error instanceof AbortError) {
      return;
    }
    await closeResponse(
      request,
      response,
      500,
      responseBodyText('handler failed'),
      lifecycleController.signal,
      options.writeTimeoutMs,
    );
    destroyRequestAfterResponse(request, response);
  } finally {
    retainErrorListenerUntilClose(request);
    retainErrorListenerUntilClose(response);
    removeShutdownAbort();
    request.off('aborted', onRequestAborted);
    request.off('error', onRequestError);
    response.off('error', onResponseError);
    response.off('close', onResponseClose);
  }
}

async function captureOwnedUnixSocket(
  endpoint: string,
  deadline: ReturnType<typeof createPhaseDeadline>,
  signal: AbortSignal,
  tracker: EndpointCleanupTracker,
): Promise<UnixSocketIdentity | undefined> {
  if (process.platform === 'win32' || endpointKind(endpoint) !== 'unix-socket') {
    return undefined;
  }
  const stat = await withDeadline(tracker.track(lstat(endpoint, { bigint: true })), deadline, {
    signal,
  });
  if (!stat.isSocket()) {
    throw new HttpIpcProtocolError('HTTP IPC endpoint is not a Unix socket after listening');
  }
  return {
    dev: stat.dev,
    ino: stat.ino,
    mode: stat.mode,
    uid: stat.uid,
    gid: stat.gid,
    size: stat.size,
    mtimeNs: stat.mtimeNs,
    ctimeNs: stat.ctimeNs,
    birthtimeNs: stat.birthtimeNs,
  };
}

function sameUnixSocketIdentity(stat: UnixSocketIdentity, identity: UnixSocketIdentity): boolean {
  return (
    stat.dev === identity.dev &&
    stat.ino === identity.ino &&
    stat.mode === identity.mode &&
    stat.uid === identity.uid &&
    stat.gid === identity.gid &&
    stat.size === identity.size &&
    stat.mtimeNs === identity.mtimeNs &&
    stat.ctimeNs === identity.ctimeNs &&
    stat.birthtimeNs === identity.birthtimeNs
  );
}

/** Rename changes ctime; compare the object fields that remain stable across quarantine. */
function sameUnixObjectIdentity(stat: UnixObjectIdentity, identity: UnixSocketIdentity): boolean {
  return (
    stat.dev === identity.dev &&
    stat.ino === identity.ino &&
    stat.mode === identity.mode &&
    stat.uid === identity.uid &&
    stat.gid === identity.gid &&
    stat.size === identity.size &&
    stat.mtimeNs === identity.mtimeNs &&
    stat.birthtimeNs === identity.birthtimeNs
  );
}

type UnixListenerProbeResult = 'live' | 'stale' | 'unknown';

function classifyUnixListenerProbeError(error: unknown): UnixListenerProbeResult {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  // ECONNREFUSED/ENOENT are the only probe outcomes that establish that no
  // listener accepted this connection attempt. All other failures are unknown.
  if (code === 'ECONNREFUSED' || code === 'ENOENT') {
    return 'stale';
  }
  return 'unknown';
}

/**
 * Probe for a listener without treating unknown probe failures as stale.
 * The caller's absolute cleanup deadline bounds both the connection attempt and
 * the final ownership decision.
 */
async function hasLiveUnixListener(
  endpoint: string,
  deadline: ReturnType<typeof createPhaseDeadline>,
  signal: AbortSignal,
  tracker: EndpointCleanupTracker,
): Promise<UnixListenerProbeResult> {
  let probe: Socket | undefined;
  let removeAbort = (): void => undefined;
  let cleanupProbeListeners = (): void => undefined;
  let removeCloseListener = (): void => undefined;
  const completion = new Promise<UnixListenerProbeResult>((resolve) => {
    let settled = false;
    let result: UnixListenerProbeResult | undefined;
    const finish = (probeResult: UnixListenerProbeResult): void => {
      if (settled) {
        return;
      }
      settled = true;
      result = probeResult;
      resolve(probeResult);
    };
    const onConnect = (): void => {
      result = 'live';
      if (probe !== undefined && !probe.destroyed) {
        probe.destroy();
      }
    };
    const onError = (error: Error): void => {
      result = classifyUnixListenerProbeError(error);
      if (probe !== undefined && !probe.destroyed) {
        probe.destroy();
      }
    };
    const onClose = (): void => {
      finish(result ?? 'unknown');
      removeCloseListener();
    };

    try {
      probe = createConnection(endpoint);
      probe.once('connect', onConnect);
      probe.once('error', onError);
      probe.once('close', onClose);
    } catch {
      finish('unknown');
    }

    // Keep the close observer until the destroyed probe has emitted close. A
    // timeout/abort may settle the outer deadline first, but the close event is
    // the completion that releases the endpoint-operation ownership.
    cleanupProbeListeners = (): void => {
      probe?.off('connect', onConnect);
      probe?.off('error', onError);
    };
    removeCloseListener = (): void => {
      probe?.off('close', onClose);
    };
  });

  const destroyProbe = (): void => {
    if (probe !== undefined && !probe.destroyed) {
      probe.destroy();
    }
  };
  removeAbort = onAbort(signal, destroyProbe);
  try {
    return await withDeadline(tracker.track(completion), deadline, {
      signal,
      onTimeout: destroyProbe,
    });
  } finally {
    if (probe !== undefined) {
      retainErrorListenerUntilClose(probe);
    }
    removeAbort();
    destroyProbe();
    cleanupProbeListeners();
    // Do not remove the close listener here: timeout and abort paths must observe
    // the forced socket completion before releasing endpoint ownership.
  }
}

async function restoreQuarantinedUnixEntry(
  endpoint: string,
  quarantine: string,
  identity: UnixSocketIdentity,
  tracker: EndpointCleanupTracker,
  deadline = createPhaseDeadline('endpoint-quarantine-recovery', DEFAULT_HTTP_CLOSE_TIMEOUT_MS),
  beforeRelink?: () => void | PromiseLike<void>,
): Promise<void> {
  let quarantinedStat: BigIntStats;
  try {
    quarantinedStat = await withDeadline(
      tracker.track(lstat(quarantine, { bigint: true })),
      deadline,
    );
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return;
    }
    throw error;
  }
  const quarantinedIsOwned = sameUnixObjectIdentity(quarantinedStat, identity);
  const quarantineKind = quarantinedIsOwned ? 'owned' : 'replacement';
  // The quarantine path was created by our rename. Even if the inode changed
  // between the ownership probe and rename, restore that exact moved entry only
  // when the endpoint is vacant; never overwrite a replacement endpoint.
  let operationError: unknown;
  let relinkSawEexist = false;
  let relinkRestored = false;
  try {
    let endpointStat: BigIntStats | undefined;
    try {
      endpointStat = await withDeadline(tracker.track(lstat(endpoint, { bigint: true })), deadline);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
    if (endpointStat === undefined) {
      if (beforeRelink !== undefined) {
        await withDeadline(Promise.resolve().then(beforeRelink), deadline);
      }
      try {
        if (quarantinedStat.isSymbolicLink()) {
          const target = await withDeadline(tracker.track(readlink(quarantine, 'utf8')), deadline);
          await withDeadline(tracker.track(symlink(target, endpoint)), deadline);
        } else {
          await withDeadline(tracker.track(link(quarantine, endpoint)), deadline);
        }
        relinkRestored = true;
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
          throw error;
        }
        relinkSawEexist = true;
        endpointStat = await withDeadline(
          tracker.track(lstat(endpoint, { bigint: true })),
          deadline,
        );
      }
    }
  } catch (error: unknown) {
    operationError = error;
  }
  let unlinkError: unknown;
  try {
    const finalQuarantineStat = await withDeadline(
      tracker.track(lstat(quarantine, { bigint: true })),
      deadline,
    );
    if (!sameUnixObjectIdentity(finalQuarantineStat, quarantinedStat)) {
      throw new HttpIpcProtocolError('HTTP IPC endpoint quarantine ownership changed');
    }
    let finalEndpointStat: BigIntStats | undefined;
    try {
      finalEndpointStat = await withDeadline(
        tracker.track(lstat(endpoint, { bigint: true })),
        deadline,
      );
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
    const endpointSharesQuarantine =
      finalEndpointStat !== undefined &&
      sameUnixObjectIdentity(finalEndpointStat, finalQuarantineStat);
    // An EEXIST relink means another owner has claimed the endpoint. Preserve
    // a non-owned quarantine entry even when it is unchanged: it may be the
    // only pathname for a live listener moved by the racing rename. Only an
    // unchanged moved entry can be removed, and owned residuals are removable
    // even when the replacement owns the endpoint.
    if (quarantinedIsOwned || (!relinkSawEexist && (endpointSharesQuarantine || relinkRestored))) {
      await withDeadline(tracker.track(unlink(quarantine)), deadline);
    }
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      unlinkError = error;
    }
  }
  if (operationError !== undefined && unlinkError !== undefined) {
    throw new AggregateError(
      [operationError, unlinkError],
      `HTTP IPC ${quarantineKind} quarantine recovery failed`,
    );
  }
  if (operationError !== undefined) {
    throw operationError;
  }
  if (unlinkError !== undefined) {
    throw unlinkError;
  }
}
async function removeOwnedUnixSocketWithinDeadline(
  endpoint: string,
  identity: UnixSocketIdentity,
  deadline: ReturnType<typeof createPhaseDeadline>,
  signal: AbortSignal,
  tracker: EndpointCleanupTracker,
): Promise<void> {
  throwIfAborted(signal);
  let stat: BigIntStats;
  try {
    stat = await withDeadline(tracker.track(lstat(endpoint, { bigint: true })), deadline, {
      signal,
    });
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return;
    }
    throw error;
  }
  throwIfAborted(signal);
  if (!stat.isSocket() || !sameUnixSocketIdentity(stat, identity)) {
    return;
  }
  const firstProbe = await hasLiveUnixListener(endpoint, deadline, signal, tracker);
  if (firstProbe === 'unknown') {
    throw new HttpIpcProtocolError('HTTP IPC endpoint listener probe was inconclusive');
  }
  if (firstProbe === 'live') {
    return;
  }
  throwIfAborted(signal);
  const finalStat = await withDeadline(tracker.track(lstat(endpoint, { bigint: true })), deadline, {
    signal,
  }).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined;
    }
    throw error;
  });
  throwIfAborted(signal);
  if (
    finalStat === undefined ||
    !finalStat.isSocket() ||
    !sameUnixSocketIdentity(finalStat, identity)
  ) {
    return;
  }
  const finalProbe = await hasLiveUnixListener(endpoint, deadline, signal, tracker);
  if (finalProbe === 'unknown') {
    throw new HttpIpcProtocolError('HTTP IPC endpoint listener probe was inconclusive');
  }
  if (finalProbe === 'live') {
    return;
  }
  throwIfAborted(signal);

  // Quarantine the exact entry atomically before unlinking it. A rename that is
  // still in flight remains owned by this transaction and gets a detached recovery
  // continuation if the caller aborts or the absolute deadline expires.
  const quarantine = `${endpoint}.cleanup-${randomUUID()}`;
  let quarantineCreated = false;
  let renamePromise: Promise<void> | undefined;
  let renameObserved: Promise<void> | undefined;
  let recoveryPromise: Promise<void> | undefined;
  const scheduleRecovery = (): void => {
    if (recoveryPromise !== undefined || renameObserved === undefined) {
      return;
    }
    recoveryPromise = tracker.track(
      renameObserved.then(async () => {
        if (!quarantineCreated) {
          return;
        }
        await restoreQuarantinedUnixEntry(endpoint, quarantine, identity, tracker, deadline);
        quarantineCreated = false;
      }),
    );
    // The primary deadline has already won. Keep recovery observed and let the
    // endpoint lock wait for it when it settles, without rethrowing asynchronously.
    void recoveryPromise.catch(() => undefined);
  };
  try {
    quarantineCreated = true;
    renamePromise = tracker.track(rename(endpoint, quarantine));
    renameObserved = tracker.track(
      renamePromise.then(
        () => {
          quarantineCreated = true;
        },
        () => {
          quarantineCreated = false;
        },
      ),
    );
    try {
      await withDeadline(renamePromise, deadline, { signal });
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        quarantineCreated = false;
        return;
      }
      scheduleRecovery();
      throw error;
    }
    quarantineCreated = true;
    throwIfAborted(signal);
    const quarantinedStat = await withDeadline(
      tracker.track(lstat(quarantine, { bigint: true })),
      deadline,
      { signal },
    );
    throwIfAborted(signal);
    if (quarantinedStat.isSocket() && sameUnixObjectIdentity(quarantinedStat, identity)) {
      await withDeadline(tracker.track(unlink(quarantine)), deadline, { signal }).catch(
        (error: unknown) => {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
            throw error;
          }
        },
      );
      quarantineCreated = false;
      return;
    }

    // A different inode was moved by the race. Restore it without replacing an
    // endpoint that another listener may have claimed while the path was absent.
    try {
      await withDeadline(tracker.track(link(quarantine, endpoint)), deadline, { signal });
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new HttpIpcProtocolError(
          'HTTP IPC endpoint replacement owns the path; quarantine will be released',
        );
      }
      throw error;
    }
    await withDeadline(tracker.track(unlink(quarantine)), deadline, { signal }).catch(
      (error: unknown) => {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw error;
        }
      },
    );
    quarantineCreated = false;
  } catch (error: unknown) {
    if (quarantineCreated || renamePromise !== undefined) {
      scheduleRecovery();
    }
    if (recoveryPromise !== undefined && !signal.aborted && Date.now() < deadline.at) {
      try {
        await withDeadline(recoveryPromise, deadline);
      } catch {
        // Preserve the primary lifecycle failure; recovery remains tracked for the
        // endpoint lock and its eventual result is observed there.
      }
    }
    throw error;
  }
}

/** Remove only the exact socket inode created by this bound server. */
async function removeOwnedUnixSocket(
  endpoint: string,
  identity: UnixSocketIdentity | undefined,
  timeoutMs: number,
  signal?: AbortSignal,
  deadlineOverride?: ReturnType<typeof createPhaseDeadline>,
): Promise<void> {
  if (
    identity === undefined ||
    process.platform === 'win32' ||
    endpointKind(endpoint) !== 'unix-socket'
  ) {
    return;
  }

  const deadline = deadlineOverride ?? createPhaseDeadline('endpoint-cleanup', timeoutMs);
  let cleanupPromise: Promise<void> | undefined;
  const cleanupTracker = createEndpointCleanupTracker();
  await withEndpointOperationLock(
    endpoint,
    () =>
      withDeadline(
        (operationSignal) => {
          cleanupPromise = removeOwnedUnixSocketWithinDeadline(
            endpoint,
            identity,
            deadline,
            operationSignal,
            cleanupTracker,
          );
          void cleanupPromise.then(
            () => cleanupTracker.finish(),
            () => cleanupTracker.finish(),
          );
          return cleanupPromise;
        },
        deadline,
        { signal },
      ),
    {
      deadline,
      signal,
      completion: () => {
        if (cleanupPromise === undefined) {
          cleanupTracker.finish();
        }
        return cleanupTracker.completion;
      },
    },
  );
}

/** Test-only stale endpoint cleanup seam used to exercise HTTP ownership recovery. */
export async function __removeStaleHttpIpcEndpointForTest(
  endpoint: string,
  options: { readonly timeoutMs?: number; readonly signal?: AbortSignal } = {},
): Promise<void> {
  if (process.platform === 'win32' || endpointKind(endpoint) !== 'unix-socket') {
    return;
  }
  const timeoutMs = normalizeTimeout(
    options.timeoutMs,
    DEFAULT_HTTP_CLOSE_TIMEOUT_MS,
    'endpointCleanupTimeoutMs',
  );
  const deadline = createPhaseDeadline('endpoint-cleanup', timeoutMs);
  const signal = options.signal ?? new AbortController().signal;
  const tracker = createEndpointCleanupTracker();
  const identity = await captureOwnedUnixSocket(endpoint, deadline, signal, tracker);
  tracker.finish();
  if (identity === undefined) {
    return;
  }
  await removeOwnedUnixSocket(endpoint, identity, timeoutMs, signal, deadline);
}

/** Test-only detached quarantine recovery seam for non-socket replacement entries. */
export async function __recoverHttpIpcEndpointQuarantineForTest(
  endpoint: string,
  quarantine: string,
  identity: UnixSocketIdentity,
  beforeRelink?: () => void | PromiseLike<void>,
): Promise<void> {
  if (process.platform === 'win32' || endpointKind(endpoint) !== 'unix-socket') {
    return;
  }
  const tracker = createEndpointCleanupTracker();
  try {
    await restoreQuarantinedUnixEntry(
      endpoint,
      quarantine,
      identity,
      tracker,
      undefined,
      beforeRelink,
    );
  } finally {
    tracker.finish();
  }
}

function forceCloseServer(server: Server, sockets: Set<Socket>): void {
  for (const socket of sockets) {
    socket.destroy();
  }
  server.closeAllConnections();
}

function waitForSetEmpty<T>(items: Set<T>, signal: AbortSignal): Promise<void> {
  if (items.size === 0) {
    return Promise.resolve();
  }
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    let timer: NodeJS.Immediate | undefined;
    let removeAbort = (): void => undefined;

    const cleanup = (): void => {
      if (timer !== undefined) {
        clearImmediate(timer);
      }
      removeAbort();
    };
    const settle = (callback: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      callback();
    };
    const check = (): void => {
      if (items.size === 0) {
        settle(resolve);
        return;
      }
      timer = setImmediate(check);
    };
    removeAbort = onAbort(signal, (error) => settle(() => reject(error)));
    if (!settled) {
      check();
    }
  });
}

async function waitForServerResources(
  closeOperation: Promise<void>,
  sockets: Set<Socket>,
  activeRequests: Set<AbortController>,
  signal: AbortSignal,
): Promise<void> {
  const resourceController = new AbortController();
  let closeFailure: unknown;
  const removeAbort = onAbort(signal, (error) => resourceController.abort(error));
  const observedClose = closeOperation.catch((error: unknown) => {
    closeFailure = error;
    resourceController.abort(error);
    throw error;
  });

  try {
    try {
      await Promise.all([
        observedClose,
        waitForSetEmpty(sockets, resourceController.signal),
        waitForSetEmpty(activeRequests, resourceController.signal),
      ]);
    } catch (error: unknown) {
      throw closeFailure ?? error;
    }
  } finally {
    removeAbort();
    resourceController.abort();
  }
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
  const closeDeadline = createPhaseDeadline('close', timeoutMs);
  const cleanupDeadline = { phase: 'endpoint-cleanup', at: closeDeadline.at };
  const shutdownError = new AbortError('HTTP IPC server is closing');
  shutdownController.abort(shutdownError);
  for (const controller of activeRequests) {
    controller.abort(shutdownError);
  }
  for (const [socket, settle] of pendingHeaders) {
    settle();
    socket.destroy();
  }

  const closeOperation = new Promise<void>((resolve, reject) => {
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
  const waitForResources = (signal: AbortSignal): Promise<void> =>
    waitForServerResources(closeOperation, sockets, activeRequests, signal);

  let closeFailure: unknown;
  let resourcesConfirmed = false;
  try {
    await withDeadline(waitForResources, closeDeadline, {
      onTimeout: () => forceCloseServer(server, sockets),
    });
    resourcesConfirmed = true;
  } catch (error: unknown) {
    // The caller's absolute close deadline is terminal. Force-close resources
    // for eventual cleanup, but never turn a late cleanup into success.
    closeFailure = error;
    if (error instanceof PhaseDeadlineExceededError) {
      forceCloseServer(server, sockets);
    }
  }

  let cleanupFailure: unknown;
  if (resourcesConfirmed) {
    try {
      await removeOwnedUnixSocket(endpoint, identity, timeoutMs, undefined, cleanupDeadline);
    } catch (error: unknown) {
      cleanupFailure = error;
    }
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
    writeTimeoutMs: normalizeTimeout(
      options.writeTimeoutMs,
      DEFAULT_HTTP_WRITE_TIMEOUT_MS,
      'writeTimeoutMs',
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
    )
      .catch(() => {
        // Observe response-write failures and tear down both HTTP streams without
        // allowing the per-request promise to become an unhandled rejection.
        if (!request.destroyed) {
          request.destroy();
        }
        if (!response.destroyed) {
          response.destroy();
        }
      })
      .finally(() => {
        activeRequests.delete(lifecycleController);
      });
  });

  server.keepAliveTimeout = 0;
  server.maxRequestsPerSocket = 1;
  server.requestTimeout = Math.max(1, normalized.requestTimeoutMs);
  server.headersTimeout = Math.max(1, normalized.requestTimeoutMs);
  server.on('error', () => undefined);
  server.on('connection', (socket) => {
    counters.connectionCount += 1;
    sockets.add(socket);
    retainErrorListenerUntilClose(socket);

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
    if (socket.destroyed) {
      return;
    }
    const body = Buffer.from(
      'HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n',
      'ascii',
    );
    void withPhaseDeadline(
      'client-error-write',
      normalized.writeTimeoutMs,
      (signal) => writeSocketAndEnd(socket, body, signal),
      { onTimeout: () => socket.destroy() },
    ).catch(() => {
      if (!socket.destroyed) {
        socket.destroy();
      }
    });
  });

  let ownedEndpoint: UnixSocketIdentity | undefined;
  const startedAt = performance.now();
  const startupDeadline = createPhaseDeadline('endpoint-startup', DEFAULT_HTTP_CLOSE_TIMEOUT_MS);
  const startupTracker = createEndpointCleanupTracker();
  let startupPromise: Promise<void> | undefined;
  let settleListening: ((error?: unknown) => void) | undefined;
  const abortStartup = (): void => {
    settleListening?.(new AbortError('HTTP IPC endpoint startup was aborted'));
    try {
      server.close(() => undefined);
    } catch {
      // Startup cleanup is retried by closeServer below.
    }
  };
  try {
    await withEndpointOperationLock(
      normalized.endpoint,
      () => {
        startupPromise = withDeadline(
          async (startupSignal) => {
            const listening = new Promise<void>((resolve, reject) => {
              let settled = false;
              const settle = (error?: unknown): void => {
                if (settled) {
                  return;
                }
                settled = true;
                server.off('listening', onListening);
                server.off('error', onError);
                if (error === undefined) {
                  resolve();
                } else {
                  reject(error);
                }
              };
              const onListening = (): void => {
                settle();
              };
              const onError = (error: Error): void => {
                settle(error);
              };
              settleListening = (error?: unknown): void => {
                settle(error ?? new AbortError('HTTP IPC endpoint startup was aborted'));
              };
              server.once('listening', onListening);
              server.once('error', onError);
              try {
                server.listen(normalized.endpoint);
              } catch (error: unknown) {
                settle(error);
              }
            });
            await withDeadline(startupTracker.track(listening), startupDeadline, {
              signal: startupSignal,
              onTimeout: abortStartup,
            });
            ownedEndpoint = await captureOwnedUnixSocket(
              normalized.endpoint,
              startupDeadline,
              startupSignal,
              startupTracker,
            );
          },
          startupDeadline,
          { onTimeout: abortStartup },
        );
        void startupPromise.then(
          () => startupTracker.finish(),
          () => startupTracker.finish(),
        );
        return startupPromise;
      },
      {
        deadline: startupDeadline,
        completion: () => {
          if (startupPromise === undefined) {
            startupTracker.finish();
          }
          return startupTracker.completion;
        },
      },
    );
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
    writeTimeoutMs: normalized.writeTimeoutMs,
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
      ).then(() => {
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
      retainErrorListenerUntilClose(candidate);
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
      retainErrorListenerUntilClose(request);
      cleanup();
      resolve();
    };
    const settleFailure = (error: unknown): void => {
      if (settled) {
        return;
      }
      settled = true;
      retainErrorListenerUntilClose(request);
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
      retainErrorListenerUntilClose(request);
      cleanup();
      resolve(response);
    };
    const settleFailure = (error: unknown): void => {
      if (settled) {
        return;
      }
      settled = true;
      retainErrorListenerUntilClose(request);
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
  retainErrorListenerUntilClose(response);
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
      retainErrorListenerUntilClose(response);
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
      retainErrorListenerUntilClose(response);
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
      if (!settled) {
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
      destroyResources();
      resolve(response);
    };
    const onRequestError = (error: Error): void => {
      settleFailure(error);
    };
    const captureResponse = (response: IncomingMessage): void => {
      retainErrorListenerUntilClose(response);
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
