/**
 * Throwaway raw node:net local-IPC candidate.
 *
 * This module is deliberately fixture-only. It exercises one bounded request and
 * one bounded response on each path-based local endpoint, then closes the
 * connection. It does not import production transport or Pi protocol modules.
 */
import { promises as fs } from 'node:fs';
import { basename } from 'node:path';
import { createConnection, createServer } from 'node:net';
import type { Server, Socket } from 'node:net';
import { TextDecoder } from 'node:util';

import {
  AbortError,
  createPhaseDeadline,
  type Deadline,
  onAbort,
  PhaseDeadlineExceededError,
  remainingMs,
  throwIfAborted,
  withDeadline,
} from './test-helpers.js';
import {
  DEFAULT_MAX_PAYLOAD_BYTES,
  FrameCodecError,
  FrameDecoder,
  encodeFrame,
  normalizeMaxPayloadBytes,
} from './frame-codec.js';
import type { FrameCodecErrorCode } from './frame-codec.js';

export const DEFAULT_RAW_NET_CONNECT_TIMEOUT_MS = 1_000;
export const DEFAULT_RAW_NET_WRITE_TIMEOUT_MS = 1_000;
export const DEFAULT_RAW_NET_READ_TIMEOUT_MS = 1_000;
export const DEFAULT_RAW_NET_SHUTDOWN_TIMEOUT_MS = 1_000;
export const DEFAULT_RAW_NET_STALE_PROBE_TIMEOUT_MS = 250;

const GENERATED_POSIX_ENDPOINT = /^p2p-[a-z0-9_-]+\.sock$/;
export type RawNetErrorCode =
  | FrameCodecErrorCode
  | 'connect-error'
  | 'connect-closed'
  | 'write-error'
  | 'write-closed'
  | 'read-error'
  | 'premature-close'
  | 'malformed-payload'
  | 'endpoint-in-use'
  | 'endpoint-not-owned'
  | 'shutdown-error';

/** Error reported by the fixture candidate at an IPC lifecycle boundary. */
export class RawNetError extends Error {
  readonly code: RawNetErrorCode;

  constructor(code: RawNetErrorCode, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'RawNetError';
    this.code = code;
  }
}

export type RawNetHandler = (payload: Buffer) => Uint8Array | PromiseLike<Uint8Array>;
export type RawNetPayloadValidator = (payload: Buffer) => void | PromiseLike<void>;
export type RawNetSocketFactory = (endpoint: string) => Socket;

export interface RawNetRequestOptions {
  readonly connectTimeoutMs?: number;
  readonly writeTimeoutMs?: number;
  readonly readTimeoutMs?: number;
  readonly connectDeadline?: Deadline;
  readonly writeDeadline?: Deadline;
  readonly readDeadline?: Deadline;
  readonly signal?: AbortSignal;
}

export interface RawNetTransportOptions {
  readonly maxPayloadBytes?: number;
  readonly connectTimeoutMs?: number;
  readonly writeTimeoutMs?: number;
  readonly readTimeoutMs?: number;
  readonly shutdownTimeoutMs?: number;
  readonly staleProbeTimeoutMs?: number;
  /** Optional content validation for the JSON-oriented spike candidate. */
  readonly validatePayload?: RawNetPayloadValidator;
  /** Test instrumentation; called whenever a write enters the drain path. */
  readonly onWriteBackpressure?: (direction: 'request' | 'response') => void;
  /** Test seam for deterministic connect/write deadline checks. */
  readonly socketFactory?: RawNetSocketFactory;
}

export interface RawNetBoundServer {
  readonly endpoint: string;
  close(): Promise<void>;
}

interface NormalizedRawNetOptions {
  readonly maxPayloadBytes: number;
  readonly connectTimeoutMs: number;
  readonly writeTimeoutMs: number;
  readonly readTimeoutMs: number;
  readonly shutdownTimeoutMs: number;
  readonly staleProbeTimeoutMs: number;
  readonly validatePayload?: RawNetPayloadValidator;
  readonly onWriteBackpressure?: (direction: 'request' | 'response') => void;
  readonly socketFactory: RawNetSocketFactory;
}

function asError(value: unknown): Error {
  if (value instanceof Error) {
    return value;
  }
  return new Error(typeof value === 'string' ? value : String(value));
}

function errorCode(value: unknown): string | undefined {
  return value instanceof Error && 'code' in value && typeof value.code === 'string'
    ? value.code
    : undefined;
}

function normalizeTimeout(value: number | undefined, fallback: number, name: string): number {
  const timeout = value ?? fallback;
  if (!Number.isSafeInteger(timeout) || timeout < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer, got ${String(timeout)}`);
  }
  return timeout;
}

function normalizeOptions(options: RawNetTransportOptions): NormalizedRawNetOptions {
  return {
    maxPayloadBytes: normalizeMaxPayloadBytes(options.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES),
    connectTimeoutMs: normalizeTimeout(
      options.connectTimeoutMs,
      DEFAULT_RAW_NET_CONNECT_TIMEOUT_MS,
      'connectTimeoutMs',
    ),
    writeTimeoutMs: normalizeTimeout(
      options.writeTimeoutMs,
      DEFAULT_RAW_NET_WRITE_TIMEOUT_MS,
      'writeTimeoutMs',
    ),
    readTimeoutMs: normalizeTimeout(
      options.readTimeoutMs,
      DEFAULT_RAW_NET_READ_TIMEOUT_MS,
      'readTimeoutMs',
    ),
    shutdownTimeoutMs: normalizeTimeout(
      options.shutdownTimeoutMs,
      DEFAULT_RAW_NET_SHUTDOWN_TIMEOUT_MS,
      'shutdownTimeoutMs',
    ),
    staleProbeTimeoutMs: normalizeTimeout(
      options.staleProbeTimeoutMs,
      DEFAULT_RAW_NET_STALE_PROBE_TIMEOUT_MS,
      'staleProbeTimeoutMs',
    ),
    validatePayload: options.validatePayload,
    onWriteBackpressure: options.onWriteBackpressure,
    socketFactory: options.socketFactory ?? ((endpoint) => createConnection(endpoint)),
  };
}

function payloadBytes(payload: Uint8Array): Buffer {
  if (!(payload instanceof Uint8Array)) {
    throw new TypeError('Raw node:net payload must be a Uint8Array or Buffer');
  }
  return Buffer.from(payload);
}

function protocolError(error: unknown): RawNetError {
  if (error instanceof RawNetError) {
    return error;
  }
  if (error instanceof FrameCodecError) {
    return new RawNetError(error.code, error.message, error);
  }
  return new RawNetError('malformed-payload', asError(error).message, error);
}

function phaseDeadline(
  phase: string,
  configured: Deadline | undefined,
  timeoutMs: number,
): Deadline {
  return configured ?? createPhaseDeadline(phase, timeoutMs);
}

function destroySocket(socket: Socket): void {
  if (!socket.destroyed) {
    socket.destroy();
  }
}

function isPosixRuntime(): boolean {
  return process.platform === 'linux' || process.platform === 'darwin';
}

function isAddressInUse(error: unknown): boolean {
  return errorCode(error) === 'EADDRINUSE';
}

function isRefusedOrMissing(error: unknown): boolean {
  const code = errorCode(error);
  return code === 'ECONNREFUSED' || code === 'ENOENT' || code === 'ENOTDIR';
}

async function lstatSocket(endpoint: string): Promise<boolean> {
  try {
    const stats = await fs.lstat(endpoint);
    return stats.isSocket();
  } catch (error: unknown) {
    if (errorCode(error) === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

async function unlinkOwnedSocket(endpoint: string): Promise<void> {
  if (!isPosixRuntime()) {
    return;
  }

  try {
    const stats = await fs.lstat(endpoint);
    if (!stats.isSocket()) {
      throw new RawNetError(
        'endpoint-not-owned',
        `Refusing to remove non-socket endpoint path ${endpoint}`,
      );
    }
    await fs.unlink(endpoint);
  } catch (error: unknown) {
    if (errorCode(error) === 'ENOENT') {
      return;
    }
    throw error;
  }
}

function closeServer(server: Server): Promise<void> {
  if (!server.listening) {
    return Promise.resolve();
  }

  return new Promise<void>((resolve, reject) => {
    try {
      server.close((error?: Error) => {
        if (error !== undefined) {
          reject(error);
        } else {
          resolve();
        }
      });
    } catch (error: unknown) {
      if (errorCode(error) === 'ERR_SERVER_NOT_RUNNING') {
        resolve();
      } else {
        reject(error);
      }
    }
  });
}

function listenServer(server: Server, endpoint: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const cleanup = (): void => {
      server.off('error', onError);
    };
    const settle = (callback: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      callback();
    };
    const onError = (error: Error): void => settle(() => reject(error));

    server.once('error', onError);
    try {
      server.listen(endpoint, () => settle(resolve));
    } catch (error: unknown) {
      settle(() => reject(error));
    }
  });
}

/**
 * Validate the JSON payload shape used by the spike tests. The transport itself
 * stays byte-oriented; callers opt into this validator when exercising the JSON
 * candidate and malformed-input path.
 */
export function validateUtf8JsonPayload(payload: Buffer): void {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(payload);
  } catch (error: unknown) {
    throw new RawNetError('malformed-payload', 'Payload is not valid UTF-8', error);
  }

  try {
    JSON.parse(text);
  } catch (error: unknown) {
    throw new RawNetError('malformed-payload', 'Payload is not valid JSON', error);
  }
}

function waitForConnect(socket: Socket, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    let removeAbort = (): void => undefined;
    const cleanup = (): void => {
      socket.off('connect', onConnect);
      socket.off('error', onError);
      socket.off('close', onClose);
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
    const onConnect = (): void => settle(resolve);
    const onError = (error: Error): void =>
      settle(() => reject(new RawNetError('connect-error', error.message, error)));
    const onClose = (): void =>
      settle(() => reject(new RawNetError('connect-closed', 'Socket closed before connect')));

    socket.once('connect', onConnect);
    socket.once('error', onError);
    socket.once('close', onClose);
    removeAbort = onAbort(signal, (error) => {
      destroySocket(socket);
      settle(() => reject(error));
    });
    if (settled) {
      return;
    }
  });
}

function writeFrameAndEnd(
  socket: Socket,
  frame: Buffer,
  signal: AbortSignal,
  onBackpressure: (() => void) | undefined,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    let callbackCompleted = false;
    let writeReturned = false;
    let drained = true;
    let ended = false;
    let removeAbort = (): void => undefined;

    const cleanup = (): void => {
      socket.off('error', onError);
      socket.off('close', onClose);
      socket.off('drain', onDrain);
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
    const fail = (error: Error): void => settle(() => reject(error));
    const onError = (error: Error): void =>
      fail(new RawNetError('write-error', error.message, error));
    const onClose = (): void =>
      fail(new RawNetError('write-closed', 'Socket closed before the frame was written'));
    const onDrain = (): void => {
      drained = true;
      maybeEnd();
    };
    const onWrite = (): void => {
      callbackCompleted = true;
      maybeEnd();
    };
    const onEnd = (): void => settle(resolve);
    const maybeEnd = (): void => {
      if (settled || ended || !writeReturned || !callbackCompleted || !drained) {
        return;
      }
      ended = true;
      try {
        socket.end(onEnd);
      } catch (error: unknown) {
        fail(new RawNetError('write-error', asError(error).message, error));
      }
    };

    socket.once('error', onError);
    socket.once('close', onClose);
    removeAbort = onAbort(signal, (error) => {
      destroySocket(socket);
      fail(error);
    });
    if (settled) {
      return;
    }

    let accepted: boolean;
    try {
      accepted = socket.write(frame, onWrite);
    } catch (error: unknown) {
      fail(new RawNetError('write-error', asError(error).message, error));
      return;
    }
    writeReturned = true;
    if (!accepted) {
      drained = false;
      onBackpressure?.();
      socket.once('drain', onDrain);
    }
    maybeEnd();
  });
}

function readResponse(
  socket: Socket,
  maxPayloadBytes: number,
  signal: AbortSignal,
  validator: RawNetPayloadValidator | undefined,
): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const decoder = new FrameDecoder({ maxPayloadBytes });
    let settled = false;
    let settling = false;
    let response: Buffer | undefined;
    let removeAbort = (): void => undefined;

    const cleanup = (): void => {
      socket.off('data', onData);
      socket.off('end', onEnd);
      socket.off('error', onError);
      socket.off('close', onClose);
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
    const fail = (error: Error): void => settle(() => reject(error));
    const onError = (error: Error): void =>
      fail(new RawNetError('read-error', error.message, error));
    const onData = (chunk: Buffer): void => {
      if (settled || settling) {
        return;
      }
      try {
        const payload = decoder.push(chunk);
        if (payload !== undefined) {
          response = payload;
        }
      } catch (error: unknown) {
        fail(protocolError(error));
      }
    };
    const finish = (payload: Buffer): void => {
      if (settled || settling) {
        return;
      }
      settling = true;
      let validation: void | PromiseLike<void>;
      try {
        validation = validator?.(payload);
      } catch (error: unknown) {
        fail(protocolError(error));
        return;
      }
      Promise.resolve(validation)
        .then(
          () => settle(() => resolve(payload)),
          (error: unknown) => fail(protocolError(error)),
        )
        .catch((error: unknown) => fail(protocolError(error)));
    };
    const onEnd = (): void => {
      if (settled || settling) {
        return;
      }
      try {
        const payload = decoder.finish();
        response = payload;
        finish(payload);
      } catch (error: unknown) {
        fail(new RawNetError('premature-close', asError(error).message, error));
      }
    };
    const onClose = (): void => {
      if (settled || settling) {
        return;
      }
      if (response === undefined) {
        fail(new RawNetError('premature-close', 'Socket closed before a complete response'));
        return;
      }
      finish(response);
    };

    socket.on('data', onData);
    socket.once('end', onEnd);
    socket.once('error', onError);
    socket.once('close', onClose);
    removeAbort = onAbort(signal, (error) => {
      destroySocket(socket);
      fail(error);
    });
    if (settled) {
      return;
    }
  });
}

async function probePosixEndpoint(endpoint: string, timeoutMs: number): Promise<'live' | 'stale'> {
  const socket = createConnection(endpoint);
  try {
    const deadline = createPhaseDeadline('stale-probe', timeoutMs);
    const connected = await withDeadline(
      () =>
        new Promise<boolean>((resolve, reject) => {
          let settled = false;
          const cleanup = (): void => {
            socket.off('connect', onConnect);
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
          const onConnect = (): void => settle(() => resolve(true));
          const onError = (error: Error): void => {
            if (isRefusedOrMissing(error)) {
              settle(() => resolve(false));
            } else {
              settle(() => reject(error));
            }
          };
          const onClose = (): void => settle(() => resolve(false));

          socket.once('connect', onConnect);
          socket.once('error', onError);
          socket.once('close', onClose);
        }),
      deadline,
      { onTimeout: () => destroySocket(socket) },
    );
    return connected ? 'live' : 'stale';
  } finally {
    destroySocket(socket);
  }
}

/**
 * Probe and remove a generated POSIX endpoint only after verifying it is a
 * socket path with no live listener. Windows named pipes are managed by the OS
 * and therefore do not enter this cleanup path.
 */
export async function removeStalePosixEndpoint(
  endpoint: string,
  timeoutMs = DEFAULT_RAW_NET_STALE_PROBE_TIMEOUT_MS,
): Promise<boolean> {
  if (!isPosixRuntime()) {
    return false;
  }
  if (!GENERATED_POSIX_ENDPOINT.test(basename(endpoint))) {
    throw new RawNetError(
      'endpoint-not-owned',
      `Refusing stale cleanup for an unowned endpoint path ${endpoint}`,
    );
  }
  if (!(await lstatSocket(endpoint))) {
    return false;
  }

  const state = await probePosixEndpoint(endpoint, timeoutMs);
  if (state === 'live') {
    throw new RawNetError('endpoint-in-use', `A live listener owns endpoint ${endpoint}`);
  }

  await fs.unlink(endpoint);
  return true;
}

export class RawNetTransport {
  readonly maxPayloadBytes: number;

  private readonly options: NormalizedRawNetOptions;
  private readonly serverSockets = new Set<Socket>();
  private readonly clientSockets = new Set<Socket>();
  private server: Server | undefined;
  private boundEndpoint: string | undefined;
  private handler: RawNetHandler | undefined;
  private closing = false;
  private closePromise: Promise<void> | undefined;

  constructor(options: RawNetTransportOptions = {}) {
    this.options = normalizeOptions(options);
    this.maxPayloadBytes = this.options.maxPayloadBytes;
  }

  /** Bind exactly one local endpoint and install one byte-oriented handler. */
  async bind(endpoint: string, handler: RawNetHandler): Promise<RawNetBoundServer> {
    if (this.closing) {
      throw new RawNetError('shutdown-error', 'Transport is shutting down');
    }
    if (this.server !== undefined || this.boundEndpoint !== undefined) {
      throw new Error('Raw node:net transport already has a bound endpoint');
    }
    if (typeof endpoint !== 'string' || endpoint.length === 0) {
      throw new TypeError('Raw node:net endpoint must be a non-empty string');
    }

    this.handler = handler;
    let server = this.createServer();
    this.server = server;

    try {
      await listenServer(server, endpoint);
    } catch (error: unknown) {
      if (!isAddressInUse(error) || !isPosixRuntime()) {
        this.server = undefined;
        this.handler = undefined;
        await closeServer(server);
        throw error;
      }

      try {
        await removeStalePosixEndpoint(endpoint, this.options.staleProbeTimeoutMs);
      } catch (staleError: unknown) {
        this.server = undefined;
        this.handler = undefined;
        await closeServer(server);
        if (staleError instanceof RawNetError && staleError.code === 'endpoint-in-use') {
          throw staleError;
        }
        throw error;
      }

      await closeServer(server);
      server = this.createServer();
      this.server = server;
      try {
        await listenServer(server, endpoint);
      } catch (retryError: unknown) {
        this.server = undefined;
        this.handler = undefined;
        await closeServer(server);
        throw retryError;
      }
    }

    this.boundEndpoint = endpoint;
    return {
      endpoint,
      close: () => this.close(),
    };
  }

  /** Request one response frame and release the socket after that exchange. */
  async request(
    endpoint: string,
    payload: Uint8Array,
    options: RawNetRequestOptions = {},
  ): Promise<Buffer> {
    const bytes = payloadBytes(payload);
    const frame = encodeFrame(bytes, { maxPayloadBytes: this.maxPayloadBytes });
    throwIfAborted(options.signal);

    const socket = this.options.socketFactory(endpoint);
    this.clientSockets.add(socket);
    try {
      const connectDeadline = phaseDeadline(
        'connect',
        options.connectDeadline,
        options.connectTimeoutMs ?? this.options.connectTimeoutMs,
      );
      await withDeadline((signal) => waitForConnect(socket, signal), connectDeadline, {
        signal: options.signal,
        onTimeout: () => destroySocket(socket),
      });

      const writeDeadline = phaseDeadline(
        'write',
        options.writeDeadline,
        options.writeTimeoutMs ?? this.options.writeTimeoutMs,
      );
      await withDeadline(
        (signal) =>
          writeFrameAndEnd(
            socket,
            frame,
            signal,
            this.options.onWriteBackpressure === undefined
              ? undefined
              : () => this.options.onWriteBackpressure?.('request'),
          ),
        writeDeadline,
        { signal: options.signal, onTimeout: () => destroySocket(socket) },
      );

      const readDeadline = phaseDeadline(
        'read',
        options.readDeadline,
        options.readTimeoutMs ?? this.options.readTimeoutMs,
      );
      return await withDeadline(
        (signal) =>
          readResponse(socket, this.maxPayloadBytes, signal, this.options.validatePayload),
        readDeadline,
        { signal: options.signal, onTimeout: () => destroySocket(socket) },
      );
    } finally {
      this.clientSockets.delete(socket);
      destroySocket(socket);
    }
  }

  /** Stop accepting, force-close active sockets within the shutdown bound, and clean up. */
  async close(): Promise<void> {
    if (this.closePromise !== undefined) {
      return this.closePromise;
    }

    this.closePromise = this.closeInternal();
    try {
      await this.closePromise;
    } finally {
      this.closePromise = undefined;
    }
  }

  private createServer(): Server {
    const server = createServer({ allowHalfOpen: true }, (socket) => this.handleConnection(socket));
    // A listener keeps asynchronous server errors from becoming uncaught errors
    // after bind has resolved. Individual connection errors are handled below.
    server.on('error', () => undefined);
    return server;
  }

  private handleConnection(socket: Socket): void {
    this.serverSockets.add(socket);
    const handler = this.handler;
    if (handler === undefined) {
      destroySocket(socket);
      return;
    }

    const decoder = new FrameDecoder({ maxPayloadBytes: this.maxPayloadBytes });
    let settled = false;
    let handlerStarted = false;
    let readTimer: NodeJS.Timeout | undefined;

    const cleanup = (): void => {
      if (readTimer !== undefined) {
        clearTimeout(readTimer);
        readTimer = undefined;
      }
      this.serverSockets.delete(socket);
      socket.off('data', onData);
      socket.off('end', onEnd);
      socket.off('error', onError);
      socket.off('close', onClose);
    };
    const fail = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      // Keep the socket in serverSockets until close confirms resource release.
      if (readTimer !== undefined) {
        clearTimeout(readTimer);
        readTimer = undefined;
      }
      destroySocket(socket);
    };
    const onClose = (): void => {
      settled = true;
      cleanup();
    };
    const onError = (): void => fail();
    const onData = (chunk: Buffer): void => {
      if (settled || handlerStarted) {
        return;
      }
      try {
        decoder.push(chunk);
      } catch {
        fail();
      }
    };
    const onEnd = (): void => {
      void processRequest();
    };
    const processRequest = async (): Promise<void> => {
      if (settled || handlerStarted) {
        return;
      }
      let request: Buffer;
      try {
        request = decoder.finish();
      } catch {
        fail();
        return;
      }
      if (readTimer !== undefined) {
        clearTimeout(readTimer);
        readTimer = undefined;
      }
      try {
        await this.options.validatePayload?.(request);
        if (settled) {
          return;
        }
        handlerStarted = true;
        const response = payloadBytes(await handler(request));
        await this.options.validatePayload?.(response);
        if (settled) {
          return;
        }
        const frame = encodeFrame(response, { maxPayloadBytes: this.maxPayloadBytes });
        const deadline = createPhaseDeadline('server-write', this.options.writeTimeoutMs);
        await withDeadline(
          (signal) =>
            writeFrameAndEnd(
              socket,
              frame,
              signal,
              this.options.onWriteBackpressure === undefined
                ? undefined
                : () => this.options.onWriteBackpressure?.('response'),
            ),
          deadline,
          { onTimeout: () => destroySocket(socket) },
        );
        settled = true;
      } catch {
        fail();
      }
    };

    socket.on('data', onData);
    socket.once('end', onEnd);
    socket.once('error', onError);
    socket.once('close', onClose);
    const deadline = createPhaseDeadline('server-read', this.options.readTimeoutMs);
    const delay = remainingMs(deadline);
    readTimer = setTimeout(() => {
      fail();
    }, delay);
  }

  private async closeInternal(): Promise<void> {
    this.closing = true;
    const server = this.server;
    const endpoint = this.boundEndpoint;
    this.server = undefined;
    this.boundEndpoint = undefined;
    this.handler = undefined;

    for (const socket of this.clientSockets) {
      destroySocket(socket);
    }
    for (const socket of this.serverSockets) {
      destroySocket(socket);
    }

    let closeError: unknown;
    if (server !== undefined) {
      const deadline = createPhaseDeadline('shutdown', this.options.shutdownTimeoutMs);
      try {
        await withDeadline(closeServer(server), deadline, {
          onTimeout: () => {
            for (const socket of this.serverSockets) {
              destroySocket(socket);
            }
            (server as Server & { closeAllConnections?: () => void }).closeAllConnections?.();
          },
        });
      } catch (error: unknown) {
        if (!(error instanceof PhaseDeadlineExceededError)) {
          closeError = error;
        }
      }
    }

    for (const socket of this.serverSockets) {
      destroySocket(socket);
    }
    for (const socket of this.clientSockets) {
      destroySocket(socket);
    }

    if (endpoint !== undefined && isPosixRuntime()) {
      try {
        await unlinkOwnedSocket(endpoint);
      } catch (error: unknown) {
        closeError ??= error;
      }
    }

    this.closing = false;
    if (closeError !== undefined) {
      throw new RawNetError('shutdown-error', asError(closeError).message, closeError);
    }
  }
}

export const RawNetServer = RawNetTransport;

export async function bindRawNet(
  endpoint: string,
  handler: RawNetHandler,
  options: RawNetTransportOptions = {},
): Promise<RawNetBoundServer & { transport: RawNetTransport }> {
  const transport = new RawNetTransport(options);
  const bound = await transport.bind(endpoint, handler);
  return { ...bound, transport };
}

export async function requestRawNet(
  endpoint: string,
  payload: Uint8Array,
  options: RawNetTransportOptions & RawNetRequestOptions = {},
): Promise<Buffer> {
  const transport = new RawNetTransport(options);
  try {
    return await transport.request(endpoint, payload, options);
  } finally {
    await transport.close();
  }
}

export { AbortError, PhaseDeadlineExceededError };
