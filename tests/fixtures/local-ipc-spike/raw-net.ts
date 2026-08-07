/**
 * Throwaway raw node:net local-IPC candidate.
 *
 * This module is deliberately fixture-only. It exercises one bounded request and
 * one bounded response on each path-based local endpoint, then closes the
 * connection. It does not import production transport or Pi protocol modules.
 */
import { randomUUID } from 'node:crypto';
import { lstatSync, linkSync, promises as fs, renameSync, unlinkSync } from 'node:fs';
import { basename } from 'node:path';
import { createConnection, createServer } from 'node:net';
import type { Server, Socket } from 'node:net';
import { TextDecoder } from 'node:util';

import {
  AbortError,
  createPhaseDeadline,
  MAX_TIMER_DELAY_MS,
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
import {
  createIpcEndpoint,
  DEFAULT_POSIX_ENDPOINT_ROOT,
  POSIX_ENDPOINT_PREFIX,
  POSIX_ENDPOINT_SUFFIX,
} from '../local-ipc/endpoint.js';

export const DEFAULT_RAW_NET_CONNECT_TIMEOUT_MS = 1_000;
export const DEFAULT_RAW_NET_WRITE_TIMEOUT_MS = 1_000;
export const DEFAULT_RAW_NET_READ_TIMEOUT_MS = 1_000;
export const DEFAULT_RAW_NET_SHUTDOWN_TIMEOUT_MS = 1_000;
export const DEFAULT_RAW_NET_FORCE_SHUTDOWN_TIMEOUT_MS = 250;
export const DEFAULT_RAW_NET_STALE_PROBE_TIMEOUT_MS = 250;
const DEFAULT_GENERATED_RUNTIME_ID_PATTERN = /^[a-f0-9]{24}$/;

interface PosixSocketIdentity {
  readonly dev: number;
  readonly ino: number;
  readonly ctimeMs: number;
  readonly birthtimeMs: number;
}

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
  if (!Number.isSafeInteger(timeout) || timeout < 0 || timeout > MAX_TIMER_DELAY_MS) {
    throw new RangeError(
      `${name} must be a non-negative safe integer no greater than ${MAX_TIMER_DELAY_MS}, got ${String(timeout)}`,
    );
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

function socketIdentity(stats: {
  dev: number;
  ino: number;
  ctimeMs: number;
  birthtimeMs: number;
}): PosixSocketIdentity {
  return {
    dev: stats.dev,
    ino: stats.ino,
    ctimeMs: stats.ctimeMs,
    birthtimeMs: stats.birthtimeMs,
  };
}

function sameSocketIdentity(left: PosixSocketIdentity, right: PosixSocketIdentity): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.ctimeMs === right.ctimeMs &&
    left.birthtimeMs === right.birthtimeMs
  );
}

function sameSocketObjectIdentity(left: PosixSocketIdentity, right: PosixSocketIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.birthtimeMs === right.birthtimeMs;
}

async function lstatSocket(endpoint: string): Promise<PosixSocketIdentity | undefined> {
  try {
    const stats = await fs.lstat(endpoint);
    return stats.isSocket() ? socketIdentity(stats) : undefined;
  } catch (error: unknown) {
    if (errorCode(error) === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
}

/**
 * Remove only the exact socket inode observed by the caller.
 *
 * The endpoint is atomically renamed to a private quarantine path before it is
 * unlinked. If the inode changed while the probe was running, the quarantine is
 * linked back only when the endpoint is still vacant; an existing replacement is
 * never overwritten or removed.
 */
function restoreQuarantinedSocket(endpoint: string, quarantine: string): void {
  try {
    lstatSync(quarantine);
  } catch (error: unknown) {
    if (errorCode(error) === 'ENOENT') {
      return;
    }
    throw error;
  }
  try {
    linkSync(quarantine, endpoint);
  } catch (error: unknown) {
    if (errorCode(error) === 'EEXIST') {
      try {
        unlinkSync(quarantine);
      } catch (cleanupError: unknown) {
        if (errorCode(cleanupError) !== 'ENOENT') {
          throw cleanupError;
        }
      }
      return;
    }
    throw error;
  }
  try {
    unlinkSync(quarantine);
  } catch (error: unknown) {
    if (errorCode(error) !== 'ENOENT') {
      throw error;
    }
  }
}
/** Test-only seam for exercising replacement-safe quarantine recovery. */
export const restoreQuarantinedSocketForTest = restoreQuarantinedSocket;

function unlinkOwnedSocket(endpoint: string, expected?: PosixSocketIdentity): boolean {
  if (!isPosixRuntime()) {
    return false;
  }
  let stats: ReturnType<typeof lstatSync>;
  try {
    stats = lstatSync(endpoint);
  } catch (error: unknown) {
    if (errorCode(error) === 'ENOENT') {
      return false;
    }
    throw error;
  }
  if (!stats.isSocket()) {
    throw new RawNetError(
      'endpoint-not-owned',
      `Refusing to remove non-socket endpoint path ${endpoint}`,
    );
  }
  const current = socketIdentity(stats);
  if (expected !== undefined && !sameSocketIdentity(current, expected)) {
    return false;
  }

  const quarantine = `${endpoint}.cleanup-${randomUUID()}`;
  let quarantineCreated = false;
  try {
    try {
      renameSync(endpoint, quarantine);
    } catch (error: unknown) {
      if (errorCode(error) === 'ENOENT') {
        return false;
      }
      throw error;
    }
    quarantineCreated = true;

    let quarantinedStats: ReturnType<typeof lstatSync>;
    try {
      quarantinedStats = lstatSync(quarantine);
    } catch (error: unknown) {
      if (errorCode(error) === 'ENOENT') {
        quarantineCreated = false;
        return false;
      }
      throw error;
    }
    if (
      !quarantinedStats.isSocket() ||
      (expected !== undefined &&
        !sameSocketObjectIdentity(socketIdentity(quarantinedStats), expected))
    ) {
      restoreQuarantinedSocket(endpoint, quarantine);
      quarantineCreated = false;
      return false;
    }

    try {
      unlinkSync(quarantine);
    } catch (error: unknown) {
      if (errorCode(error) === 'ENOENT') {
        quarantineCreated = false;
        return false;
      }
      throw error;
    }
    quarantineCreated = false;
    return true;
  } catch (error: unknown) {
    if (quarantineCreated) {
      try {
        restoreQuarantinedSocket(endpoint, quarantine);
      } catch (recoveryError: unknown) {
        throw new AggregateError(
          [error, recoveryError],
          'Raw node:net endpoint quarantine recovery failed',
        );
      }
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
  endAfterWrite = true,
  destroyAfterEnd = false,
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
    const onEnd = (): void => {
      settle(resolve);
      if (destroyAfterEnd) {
        destroySocket(socket);
      }
    };
    const maybeEnd = (): void => {
      if (settled || ended || !writeReturned || !callbackCompleted || !drained) {
        return;
      }
      ended = true;
      if (!endAfterWrite) {
        settle(resolve);
        return;
      }
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
    let complete = false;
    let removeAbort = (): void => undefined;
    let completionTimer: ReturnType<typeof setImmediate> | undefined;

    const cancelCompletion = (): void => {
      if (completionTimer !== undefined) {
        clearImmediate(completionTimer);
        completionTimer = undefined;
      }
    };
    const cleanup = (): void => {
      cancelCompletion();
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
    const settleSuccess = (payload: Buffer): void => {
      if (settled) {
        return;
      }
      settled = true;
      // Keep the stream listeners until the socket closes so late bytes cannot
      // be silently accepted after a successful frame.
      removeAbort();
      resolve(payload);
    };
    const scheduleSuccess = (payload: Buffer): void => {
      if (settled || completionTimer !== undefined) {
        return;
      }
      // Defer across a poll turn so trailing data can reject before success
      // reaches the caller; the handle remains cancelable on failure.
      completionTimer = setImmediate(() => {
        completionTimer = setImmediate(() => {
          completionTimer = undefined;
          settleSuccess(payload);
        });
      });
    };
    const fail = (error: Error): void => {
      if (settled) {
        // The response is already delivered, but a later trailing byte still
        // invalidates this one-operation connection.
        destroySocket(socket);
        return;
      }
      settle(() => reject(error));
    };
    const onError = (error: Error): void =>
      fail(new RawNetError('read-error', error.message, error));
    const finish = (payload: Buffer): void => {
      if (settled || settling) {
        return;
      }
      complete = true;
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
          () => scheduleSuccess(payload),
          (error: unknown) => fail(protocolError(error)),
        )
        .catch((error: unknown) => fail(protocolError(error)));
    };
    const onData = (chunk: Buffer): void => {
      try {
        const payload = decoder.push(chunk);
        if (payload !== undefined) {
          // A complete frame is sufficient; EOF is not part of response validity.
          finish(payload);
        }
      } catch (error: unknown) {
        fail(protocolError(error));
      }
    };
    const onEnd = (): void => {
      if (settled || settling || complete) {
        return;
      }
      try {
        finish(decoder.finish());
      } catch (error: unknown) {
        fail(new RawNetError('premature-close', asError(error).message, error));
      }
    };
    const onClose = (): void => {
      if (settled) {
        cleanup();
        return;
      }
      if (settling || complete) {
        return;
      }
      fail(new RawNetError('premature-close', 'Socket closed before a complete response'));
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

function isGeneratedPosixEndpoint(endpoint: string): boolean {
  const name = basename(endpoint);
  if (!name.startsWith(POSIX_ENDPOINT_PREFIX) || !name.endsWith(POSIX_ENDPOINT_SUFFIX)) {
    return false;
  }
  const runtimeId = name.slice(
    POSIX_ENDPOINT_PREFIX.length,
    name.length - POSIX_ENDPOINT_SUFFIX.length,
  );
  if (!DEFAULT_GENERATED_RUNTIME_ID_PATTERN.test(runtimeId)) {
    return false;
  }
  try {
    return (
      createIpcEndpoint({
        platform: 'linux',
        posixRoot: DEFAULT_POSIX_ENDPOINT_ROOT,
        runtimeId,
      }) === endpoint
    );
  } catch {
    return false;
  }
}

/**
 * Probe and remove a default-generated POSIX endpoint only after verifying it is a
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
  if (!isGeneratedPosixEndpoint(endpoint)) {
    throw new RawNetError(
      'endpoint-not-owned',
      `Refusing stale cleanup for an unowned endpoint path ${endpoint}`,
    );
  }
  const observed = await lstatSocket(endpoint);
  if (observed === undefined) {
    return false;
  }

  const state = await probePosixEndpoint(endpoint, timeoutMs);
  if (state === 'live') {
    throw new RawNetError('endpoint-in-use', `A live listener owns endpoint ${endpoint}`);
  }

  return unlinkOwnedSocket(endpoint, observed);
}

interface SocketClosureState {
  readonly completion: Promise<void>;
  readonly markClosed: () => void;
}

const socketClosureStates = new WeakMap<Socket, SocketClosureState>();

function trackSocketClosure(socket: Socket): SocketClosureState {
  const existing = socketClosureStates.get(socket);
  if (existing !== undefined) {
    return existing;
  }
  let markClosed!: () => void;
  const completion = new Promise<void>((resolve) => {
    markClosed = resolve;
  });
  const state: SocketClosureState = { completion, markClosed };
  socketClosureStates.set(socket, state);
  socket.once('close', () => {
    state.markClosed();
  });
  return state;
}

function waitForSocketClosure(socket: Socket): Promise<void> {
  return trackSocketClosure(socket).completion;
}
export class RawNetTransport {
  readonly maxPayloadBytes: number;

  private readonly options: NormalizedRawNetOptions;
  private readonly serverSockets = new Set<Socket>();
  private readonly clientSockets = new Set<Socket>();
  private lifecycleTail: Promise<void> = Promise.resolve();
  private server: Server | undefined;
  private boundEndpoint: string | undefined;
  private ownedEndpoint: { endpoint: string; identity?: PosixSocketIdentity } | undefined;
  private handler: RawNetHandler | undefined;
  private closing = false;
  private closed = false;
  private closePromise: Promise<void> | undefined;

  constructor(options: RawNetTransportOptions = {}) {
    this.options = normalizeOptions(options);
    this.maxPayloadBytes = this.options.maxPayloadBytes;
  }

  /** Bind exactly one local endpoint and install one byte-oriented handler. */
  async bind(endpoint: string, handler: RawNetHandler): Promise<RawNetBoundServer> {
    return this.enqueueLifecycle(() => this.bindInternal(endpoint, handler));
  }

  private enqueueLifecycle<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.lifecycleTail;
    let release!: () => void;
    this.lifecycleTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    return previous.then(operation).finally(release);
  }

  private async bindInternal(endpoint: string, handler: RawNetHandler): Promise<RawNetBoundServer> {
    if (this.closing || this.closed) {
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
    const discard = async (clearHandler = true): Promise<void> => {
      if (this.server === server) {
        this.server = undefined;
        this.boundEndpoint = undefined;
        this.ownedEndpoint = undefined;
        if (clearHandler) {
          this.handler = undefined;
        }
      }
      await closeServer(server);
    };
    const publish = async (): Promise<RawNetBoundServer> => {
      if (this.closing || this.closed) {
        await discard();
        throw new RawNetError('shutdown-error', 'Transport is shutting down');
      }
      const identity = isPosixRuntime() ? await lstatSocket(endpoint) : undefined;
      if (isPosixRuntime() && identity === undefined) {
        await discard();
        throw new RawNetError('endpoint-not-owned', `Bound endpoint disappeared: ${endpoint}`);
      }
      if (this.closing || this.closed) {
        await discard();
        throw new RawNetError('shutdown-error', 'Transport is shutting down');
      }
      this.ownedEndpoint = { endpoint, identity };
      this.boundEndpoint = endpoint;
      return {
        endpoint,
        close: () => this.close(),
      };
    };

    try {
      await listenServer(server, endpoint);
      return await publish();
    } catch (error: unknown) {
      if (!isAddressInUse(error) || !isPosixRuntime() || this.closing || this.closed) {
        await discard();
        throw error;
      }

      try {
        await removeStalePosixEndpoint(endpoint, this.options.staleProbeTimeoutMs);
      } catch (staleError: unknown) {
        await discard();
        if (staleError instanceof RawNetError && staleError.code === 'endpoint-in-use') {
          throw staleError;
        }
        throw error;
      }

      await discard(false);
      server = this.createServer();
      this.server = server;
      try {
        await listenServer(server, endpoint);
        return await publish();
      } catch (retryError: unknown) {
        await discard();
        throw retryError;
      }
    }
  }

  /** Request one response frame and release the socket after that exchange. */
  async request(
    endpoint: string,
    payload: Uint8Array,
    options: RawNetRequestOptions = {},
  ): Promise<Buffer> {
    if (this.closing || this.closed) {
      throw new RawNetError('shutdown-error', 'Transport is shutting down');
    }
    const bytes = payloadBytes(payload);
    const frame = encodeFrame(bytes, { maxPayloadBytes: this.maxPayloadBytes });
    throwIfAborted(options.signal);
    if (this.closing || this.closed) {
      throw new RawNetError('shutdown-error', 'Transport is shutting down');
    }

    const socket = this.options.socketFactory(endpoint);
    trackSocketClosure(socket);
    if (this.closing || this.closed) {
      destroySocket(socket);
      await waitForSocketClosure(socket);
      throw new RawNetError('shutdown-error', 'Transport is shutting down');
    }
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
            false,
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
      destroySocket(socket);
      await waitForSocketClosure(socket);
      this.clientSockets.delete(socket);
    }
  }

  /** Stop accepting, force-close active sockets within the shutdown bound, and clean up. */
  async close(): Promise<void> {
    if (this.closePromise !== undefined) {
      return this.closePromise;
    }
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.closing = true;
    this.closePromise = this.enqueueLifecycle(() => this.closeInternal()).finally(() => {
      this.closing = false;
    });
    return this.closePromise;
  }

  private createServer(): Server {
    const server = createServer({ allowHalfOpen: false }, (socket) =>
      this.handleConnection(socket),
    );
    // A listener keeps asynchronous server errors from becoming uncaught errors
    // after bind has resolved. Individual connection errors are handled below.
    server.on('error', () => undefined);
    return server;
  }

  private handleConnection(socket: Socket): void {
    trackSocketClosure(socket);
    this.serverSockets.add(socket);
    const handler = this.handler;
    if (handler === undefined || this.closing || this.closed) {
      socket.once('close', () => this.serverSockets.delete(socket));
      destroySocket(socket);
      return;
    }

    const decoder = new FrameDecoder({ maxPayloadBytes: this.maxPayloadBytes });
    let settled = false;
    let requestComplete = false;
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
    const processRequest = async (request: Buffer): Promise<void> => {
      if (settled || handlerStarted) {
        return;
      }
      handlerStarted = true;
      if (readTimer !== undefined) {
        clearTimeout(readTimer);
        readTimer = undefined;
      }
      if (this.closing || this.closed) {
        fail();
        return;
      }
      try {
        await this.options.validatePayload?.(request);
        if (settled || this.closing || this.closed) {
          fail();
          return;
        }
        const response = payloadBytes(await handler(request));
        await this.options.validatePayload?.(response);
        if (settled || this.closing || this.closed) {
          fail();
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
              true,
            ),
          deadline,
          { onTimeout: () => destroySocket(socket) },
        );
        settled = true;
      } catch {
        fail();
      }
    };
    const onData = (chunk: Buffer): void => {
      try {
        const request = decoder.push(chunk);
        if (request !== undefined) {
          requestComplete = true;
          void processRequest(request);
        }
      } catch {
        fail();
      }
    };
    const onEnd = (): void => {
      if (settled || requestComplete) {
        return;
      }
      try {
        const request = decoder.finish();
        requestComplete = true;
        void processRequest(request);
      } catch {
        fail();
      }
    };

    socket.on('data', onData);
    socket.once('end', onEnd);
    socket.once('error', onError);
    socket.once('close', onClose);
    let deadline: Deadline;
    try {
      deadline = createPhaseDeadline('server-read', this.options.readTimeoutMs);
    } catch {
      fail();
      return;
    }
    const delay = remainingMs(deadline);
    readTimer = setTimeout(() => {
      fail();
    }, delay);
  }

  private async closeInternal(): Promise<void> {
    let deadline: Deadline;
    try {
      deadline = createPhaseDeadline('shutdown', this.options.shutdownTimeoutMs);
    } catch (error: unknown) {
      throw new RawNetError('shutdown-error', asError(error).message, error);
    }
    const server = this.server;
    const ownedEndpoint = this.ownedEndpoint;
    this.server = undefined;
    this.boundEndpoint = undefined;
    this.ownedEndpoint = undefined;
    this.handler = undefined;

    let closeError: unknown;
    let serverClosed = server === undefined;
    let serverCloseError: unknown;
    const serverCloseCompletion = (async (): Promise<void> => {
      if (server === undefined) {
        return;
      }
      try {
        await closeServer(server);
      } catch (error: unknown) {
        serverCloseError = error;
      } finally {
        serverClosed = true;
      }
    })();
    const drainResources = async (): Promise<void> => {
      for (;;) {
        const sockets = new Set([...this.clientSockets, ...this.serverSockets]);
        if (sockets.size > 0) {
          const socketClosures = [...sockets].map((socket) => waitForSocketClosure(socket));
          for (const socket of sockets) {
            destroySocket(socket);
          }
          await Promise.all(socketClosures);
          continue;
        }
        if (!serverClosed) {
          await new Promise<void>((resolve) => setImmediate(resolve));
          continue;
        }
        // Give a pending connection callback one turn to register its socket before
        // declaring the tracked resource sets drained.
        await new Promise<void>((resolve) => setImmediate(resolve));
        if (this.clientSockets.size === 0 && this.serverSockets.size === 0) {
          return;
        }
      }
    };
    const closeAllConnections = (): void => {
      for (const socket of new Set([...this.clientSockets, ...this.serverSockets])) {
        trackSocketClosure(socket);
        destroySocket(socket);
      }
      (
        server as (Server & { closeAllConnections?: () => void }) | undefined
      )?.closeAllConnections?.();
    };
    const resourcesCompletion = Promise.all([serverCloseCompletion, drainResources()]).then(() => {
      if (serverCloseError !== undefined) {
        throw serverCloseError;
      }
    });
    let resourcesConfirmed = false;
    try {
      await withDeadline(resourcesCompletion, deadline, { onTimeout: closeAllConnections });
      resourcesConfirmed = true;
    } catch (error: unknown) {
      if (error instanceof PhaseDeadlineExceededError) {
        closeAllConnections();
        try {
          const forceDeadline = createPhaseDeadline(
            'shutdown-force',
            DEFAULT_RAW_NET_FORCE_SHUTDOWN_TIMEOUT_MS,
          );
          await withDeadline(resourcesCompletion, forceDeadline, {
            onTimeout: closeAllConnections,
          });
          resourcesConfirmed = true;
        } catch (forceError: unknown) {
          closeError = forceError;
        }
      } else {
        closeError = error;
      }
    }

    if (
      resourcesConfirmed &&
      ownedEndpoint !== undefined &&
      isPosixRuntime() &&
      (server === undefined || !server.listening)
    ) {
      try {
        unlinkOwnedSocket(ownedEndpoint.endpoint, ownedEndpoint.identity);
      } catch (error: unknown) {
        closeError ??= error;
      }
    }

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
