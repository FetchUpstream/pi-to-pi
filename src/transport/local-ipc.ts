/**
 * Bounded native local IPC over Unix-domain sockets or Windows named pipes.
 *
 * Every request uses one connection and exactly one length-prefixed request and
 * response. The implementation is deliberately byte-oriented; callers own all
 * protocol and application semantics.
 */

import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import type { Stats } from 'node:fs';
import { createConnection, createServer } from 'node:net';
import type { Server, Socket } from 'node:net';

import { assertIpcEndpoint, isGeneratedPosixEndpoint } from './endpoint.js';
import {
  FrameCodecError,
  FrameDecoder,
  encodeFrame,
  normalizeMaxPayloadBytes,
} from './frame-codec.js';
import {
  AbortError,
  DEFAULT_CONNECT_TIMEOUT_MS,
  DEFAULT_FORCE_SHUTDOWN_TIMEOUT_MS,
  DEFAULT_MAX_PAYLOAD_BYTES,
  DEFAULT_OVERALL_TIMEOUT_MS,
  DEFAULT_READ_TIMEOUT_MS,
  DEFAULT_SHUTDOWN_TIMEOUT_MS,
  DEFAULT_STALE_PROBE_TIMEOUT_MS,
  DEFAULT_WRITE_TIMEOUT_MS,
  LocalIpcError,
  MAX_TIMER_DELAY_MS,
  PhaseDeadlineExceededError,
  TransportError,
} from './transport.js';
import type {
  BoundTransportServer,
  LocalIpcTransport as LocalIpcTransportContract,
  LocalIpcTransportOptions,
  TransportDeadline,
  TransportDeadlineInput,
  TransportHandler,
  TransportPayload,
  TransportRequestOptions,
} from './transport.js';

export {
  AbortError,
  FrameCodecError,
  PhaseDeadlineExceededError,
  TransportError,
  DEFAULT_CONNECT_TIMEOUT_MS,
  DEFAULT_FORCE_SHUTDOWN_TIMEOUT_MS,
  DEFAULT_MAX_PAYLOAD_BYTES,
  DEFAULT_OVERALL_TIMEOUT_MS,
  DEFAULT_READ_TIMEOUT_MS,
  DEFAULT_SHUTDOWN_TIMEOUT_MS,
  DEFAULT_STALE_PROBE_TIMEOUT_MS,
  DEFAULT_WRITE_TIMEOUT_MS,
};
export type {
  BoundTransportServer,
  TransportDeadline,
  TransportDeadlineInput,
} from './transport.js';
export type { FrameCodecErrorCode } from './frame-codec.js';

export type SocketFactory = (endpoint: string) => Socket;
export type WriteBackpressureObserver = (direction: 'request' | 'response') => void;

export interface LocalIpcOptions extends LocalIpcTransportOptions {
  /** Test seam; production defaults to node:net's path-based connection API. */
  readonly socketFactory?: SocketFactory;
  /** Optional bounded write-backpressure instrumentation. */
  readonly onWriteBackpressure?: WriteBackpressureObserver;
}

export type LocalIpcRequestOptions = LocalIpcOptions & TransportRequestOptions;

interface NormalizedOptions {
  readonly maxPayloadBytes: number;
  readonly posixEndpointMaxBytes: number;
  readonly connectTimeoutMs: number;
  readonly writeTimeoutMs: number;
  readonly readTimeoutMs: number;
  readonly shutdownTimeoutMs: number;
  readonly forceShutdownTimeoutMs: number;
  readonly staleProbeTimeoutMs: number;
  readonly overallTimeoutMs: number;
  readonly socketFactory: SocketFactory;
  readonly onWriteBackpressure: WriteBackpressureObserver | undefined;
}

type AbsoluteDeadline = TransportDeadline;

interface PosixSocketIdentity {
  readonly dev: number;
  readonly ino: number;
  readonly ctimeMs: number;
  readonly birthtimeMs: number;
}

interface OwnedEndpoint {
  readonly endpoint: string;
  readonly identity: PosixSocketIdentity | undefined;
}

type PosixEndpointProbeState = 'live' | 'stale' | 'inconclusive';

interface SocketCloseState {
  readonly completion: Promise<void>;
  readonly resolve: () => void;
  closed: boolean;
}

const socketCloseStates = new WeakMap<Socket, SocketCloseState>();

function asError(value: unknown): Error {
  return value instanceof Error
    ? value
    : new Error(typeof value === 'string' ? value : String(value));
}

function errorCode(value: unknown): string | undefined {
  return value instanceof Error && 'code' in value && typeof value.code === 'string'
    ? value.code
    : undefined;
}

function normalizeTimeout(value: number | undefined, fallback: number, name: string): number {
  const timeout = value ?? fallback;
  if (!Number.isSafeInteger(timeout) || timeout < 0 || timeout > MAX_TIMER_DELAY_MS) {
    throw new LocalIpcError(
      'invalid-options',
      `${name} must be a non-negative safe integer no greater than ${MAX_TIMER_DELAY_MS}, got ${String(timeout)}`,
    );
  }
  return timeout;
}

function normalizeEndpointLimit(value: number | undefined): number {
  const limit = value ?? 100;
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw new LocalIpcError(
      'invalid-options',
      'posixEndpointMaxBytes must be a positive safe integer',
    );
  }
  return limit;
}

function normalizeOptions(options: LocalIpcOptions): NormalizedOptions {
  return {
    maxPayloadBytes: normalizeMaxPayloadBytes(options.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES),
    posixEndpointMaxBytes: normalizeEndpointLimit(options.posixEndpointMaxBytes),
    connectTimeoutMs: normalizeTimeout(
      options.connectTimeoutMs,
      DEFAULT_CONNECT_TIMEOUT_MS,
      'connectTimeoutMs',
    ),
    writeTimeoutMs: normalizeTimeout(
      options.writeTimeoutMs,
      DEFAULT_WRITE_TIMEOUT_MS,
      'writeTimeoutMs',
    ),
    readTimeoutMs: normalizeTimeout(
      options.readTimeoutMs,
      DEFAULT_READ_TIMEOUT_MS,
      'readTimeoutMs',
    ),
    shutdownTimeoutMs: normalizeTimeout(
      options.shutdownTimeoutMs,
      DEFAULT_SHUTDOWN_TIMEOUT_MS,
      'shutdownTimeoutMs',
    ),
    forceShutdownTimeoutMs: normalizeTimeout(
      options.forceShutdownTimeoutMs,
      DEFAULT_FORCE_SHUTDOWN_TIMEOUT_MS,
      'forceShutdownTimeoutMs',
    ),
    staleProbeTimeoutMs: normalizeTimeout(
      options.staleProbeTimeoutMs,
      DEFAULT_STALE_PROBE_TIMEOUT_MS,
      'staleProbeTimeoutMs',
    ),
    overallTimeoutMs: normalizeTimeout(
      options.overallTimeoutMs,
      DEFAULT_OVERALL_TIMEOUT_MS,
      'overallTimeoutMs',
    ),
    socketFactory: options.socketFactory ?? ((endpoint) => createConnection(endpoint)),
    onWriteBackpressure: options.onWriteBackpressure,
  };
}

function payloadBytes(payload: TransportPayload): Buffer {
  if (!(payload instanceof Uint8Array)) {
    throw new TypeError('Local IPC payload must be a Uint8Array or Buffer');
  }
  return Buffer.from(payload);
}

function frameErrorOrTransport(
  error: unknown,
  fallbackCode: 'read-error' | 'handler-error',
): Error {
  if (error instanceof FrameCodecError || error instanceof TransportError) {
    return error;
  }
  return new TransportError(fallbackCode, asError(error).message, { cause: error });
}

function validatePhaseName(phase: string): string {
  if (typeof phase !== 'string' || phase.trim().length === 0) {
    throw new LocalIpcError('invalid-options', 'deadline phase must be a non-empty string');
  }
  return phase;
}

function validateAbsoluteTimestamp(at: number, name: string): number {
  if (!Number.isFinite(at) || !Number.isSafeInteger(at) || at < 0) {
    throw new LocalIpcError(
      'invalid-options',
      `${name} must be a non-negative safe integer timestamp`,
    );
  }
  return at;
}

function deadlineFrom(
  phase: string,
  input: TransportDeadlineInput | undefined,
  timeoutMs: number,
  now = Date.now(),
): AbsoluteDeadline {
  if (input === undefined) {
    const deadline = now + timeoutMs;
    if (!Number.isSafeInteger(deadline)) {
      throw new LocalIpcError(
        'invalid-options',
        `${phase} deadline is outside the supported timestamp range`,
      );
    }
    return { phase, at: deadline };
  }

  if (typeof input === 'number') {
    return { phase, at: validateAbsoluteTimestamp(input, `${phase} deadline`) };
  }

  if (input === null || typeof input !== 'object') {
    throw new LocalIpcError(
      'invalid-options',
      `${phase} deadline must be a timestamp or deadline object`,
    );
  }
  return {
    phase: validatePhaseName(input.phase),
    at: validateAbsoluteTimestamp(input.at, `${phase} deadline`),
  };
}

function earlierDeadline(left: AbsoluteDeadline, right: AbsoluteDeadline): AbsoluteDeadline {
  return left.at <= right.at ? left : right;
}

function abortErrorFromReason(reason: unknown): AbortError {
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

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw abortErrorFromReason(signal.reason);
  }
}

/** Race a promise against one absolute deadline and an optional caller signal. */
function withDeadline<T>(
  operation: PromiseLike<T> | (() => PromiseLike<T> | T),
  deadline: AbsoluteDeadline,
  options: {
    readonly signal?: AbortSignal;
    readonly onTimeout?: () => void;
  } = {},
): Promise<T> {
  let operationPromise: Promise<T>;
  try {
    operationPromise =
      typeof operation === 'function'
        ? Promise.resolve((operation as () => PromiseLike<T> | T)())
        : Promise.resolve(operation);
  } catch (error: unknown) {
    return Promise.reject(error);
  }
  void operationPromise.catch(() => undefined);

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abortListener: (() => void) | undefined;
    let timerCancelled = false;

    const cancelTimer = (): void => {
      timerCancelled = true;
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
    };
    const cleanup = (): void => {
      cancelTimer();
      if (abortListener !== undefined && options.signal !== undefined) {
        options.signal.removeEventListener('abort', abortListener);
        abortListener = undefined;
      }
    };
    const settle = (callback: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      callback();
    };
    const rejectForTimeout = (): void => {
      if (settled) {
        return;
      }
      try {
        options.onTimeout?.();
      } catch {
        // Resource cleanup is best effort and must not replace the deadline error.
      }
      settle(() => reject(new PhaseDeadlineExceededError(deadline.phase, deadline.at)));
    };
    const rejectForAbort = (): void => {
      if (settled) {
        return;
      }
      try {
        options.onTimeout?.();
      } catch {
        // Resource cleanup is best effort and must not replace the cancellation error.
      }
      settle(() => reject(abortErrorFromReason(options.signal?.reason)));
    };
    const schedule = (): void => {
      if (settled || timerCancelled) {
        return;
      }
      const remaining = deadline.at - Date.now();
      if (remaining <= 0) {
        rejectForTimeout();
        return;
      }
      timer = setTimeout(
        () => {
          timer = undefined;
          schedule();
        },
        Math.min(MAX_TIMER_DELAY_MS, Math.ceil(remaining)),
      );
    };

    if (options.signal?.aborted) {
      rejectForAbort();
      return;
    }
    if (deadline.at <= Date.now()) {
      rejectForTimeout();
      return;
    }

    if (options.signal !== undefined) {
      abortListener = rejectForAbort;
      options.signal.addEventListener('abort', abortListener, { once: true });
    }
    schedule();
    if (settled) {
      return;
    }

    operationPromise.then(
      (value) => settle(() => resolve(value)),
      (error: unknown) => settle(() => reject(error)),
    );
  });
}

function destroySocket(socket: Socket): void {
  if (!socket.destroyed) {
    socket.destroy();
  }
}

function trackSocket(set: Set<Socket>, socket: Socket): void {
  set.add(socket);
  let state = socketCloseStates.get(socket);
  if (state === undefined) {
    let resolve!: () => void;
    const completion = new Promise<void>((promiseResolve) => {
      resolve = promiseResolve;
    });
    state = { completion, resolve, closed: false };
    socketCloseStates.set(socket, state);
    const onClose = (): void => {
      if (!state?.closed) {
        state!.closed = true;
        state!.resolve();
      }
      socket.off('error', onTrackedError);
      set.delete(socket);
    };
    const onTrackedError = (): void => undefined;
    socket.on('error', onTrackedError);
    socket.once('close', onClose);
  }
}

function socketClosed(socket: Socket): Promise<void> {
  const state = socketCloseStates.get(socket);
  if (state !== undefined) {
    return state.completion;
  }
  return Promise.resolve();
}

function closeServer(server: Server): Promise<void> {
  if (!server.listening) {
    return Promise.resolve();
  }
  return new Promise<void>((resolve, reject) => {
    try {
      server.close((error?: Error) => {
        if (error === undefined) {
          resolve();
        } else {
          reject(error);
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

function socketIdentity(stats: Stats): PosixSocketIdentity {
  return {
    dev: stats.dev,
    ino: stats.ino,
    ctimeMs: stats.ctimeMs,
    birthtimeMs: stats.birthtimeMs,
  };
}

function sameSocketObjectIdentity(left: PosixSocketIdentity, right: PosixSocketIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.birthtimeMs === right.birthtimeMs;
}

function sameSocketIdentity(left: PosixSocketIdentity, right: PosixSocketIdentity): boolean {
  return sameSocketObjectIdentity(left, right) && left.ctimeMs === right.ctimeMs;
}

async function lstatWithinDeadline(
  endpoint: string,
  deadline: AbsoluteDeadline,
): Promise<Stats | undefined> {
  try {
    return await withDeadline(fs.lstat(endpoint), deadline);
  } catch (error: unknown) {
    if (errorCode(error) === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
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

function isPosixRuntime(): boolean {
  return process.platform === 'linux' || process.platform === 'darwin';
}

function isRefusedOrMissing(error: unknown): boolean {
  const code = errorCode(error);
  return code === 'ECONNREFUSED' || code === 'ENOENT' || code === 'ENOTDIR';
}

function isAddressInUse(error: unknown): boolean {
  return errorCode(error) === 'EADDRINUSE';
}

async function probePosixEndpoint(
  endpoint: string,
  timeoutMs: number,
  socketFactory: SocketFactory,
): Promise<PosixEndpointProbeState> {
  let socket: Socket;
  try {
    socket = socketFactory(endpoint);
  } catch (error: unknown) {
    return isRefusedOrMissing(error) ? 'stale' : 'inconclusive';
  }

  try {
    const deadline = deadlineFrom('stale-probe', undefined, timeoutMs);
    return await withDeadline(
      () =>
        new Promise<PosixEndpointProbeState>((resolve) => {
          let settled = false;
          const cleanup = (): void => {
            socket.off('connect', onConnect);
            socket.off('error', onError);
            socket.off('close', onClose);
          };
          const settle = (state: PosixEndpointProbeState): void => {
            if (settled) {
              return;
            }
            settled = true;
            cleanup();
            resolve(state);
          };
          const onConnect = (): void => settle('live');
          const onError = (error: Error): void =>
            settle(isRefusedOrMissing(error) ? 'stale' : 'inconclusive');
          const onClose = (): void => settle('inconclusive');

          socket.once('connect', onConnect);
          socket.once('error', onError);
          socket.once('close', onClose);
        }),
      deadline,
      { onTimeout: () => destroySocket(socket) },
    );
  } catch (error: unknown) {
    if (error instanceof PhaseDeadlineExceededError) {
      return 'inconclusive';
    }
    return isRefusedOrMissing(error) ? 'stale' : 'inconclusive';
  } finally {
    destroySocket(socket);
  }
}

async function restoreQuarantine(
  endpoint: string,
  quarantine: string,
  deadline: AbsoluteDeadline,
): Promise<void> {
  const quarantineStats = await lstatWithinDeadline(quarantine, deadline);
  if (quarantineStats === undefined) {
    return;
  }
  const endpointStats = await lstatWithinDeadline(endpoint, deadline);
  if (endpointStats !== undefined) {
    // A replacement owns the public endpoint. Never overwrite it.
    return;
  }
  try {
    await withDeadline(fs.rename(quarantine, endpoint), deadline);
  } catch (error: unknown) {
    if (errorCode(error) !== 'EEXIST') {
      throw error;
    }
  }
}

/**
 * Remove only a socket inode that the caller has already proven stale and owns.
 * The rename/quarantine step makes replacement endpoint races identity-safe.
 */
async function unlinkOwnedSocket(
  endpoint: string,
  expected: PosixSocketIdentity | undefined,
  deadline: AbsoluteDeadline,
  socketFactory: SocketFactory = (candidateEndpoint) => createConnection(candidateEndpoint),
): Promise<boolean> {
  if (!isPosixRuntime()) {
    return false;
  }

  const stats = await lstatWithinDeadline(endpoint, deadline);
  if (stats === undefined) {
    return false;
  }
  if (!stats.isSocket()) {
    throw new TransportError(
      'endpoint-not-owned',
      `Refusing to remove non-socket endpoint path ${endpoint}`,
    );
  }
  const current = socketIdentity(stats);
  if (expected !== undefined && !sameSocketIdentity(current, expected)) {
    return false;
  }

  const quarantine = `${endpoint}.cleanup-${randomUUID()}`;
  let moved = false;
  try {
    try {
      await withDeadline(fs.rename(endpoint, quarantine), deadline);
      moved = true;
    } catch (error: unknown) {
      if (errorCode(error) === 'ENOENT') {
        return false;
      }
      throw error;
    }

    const quarantinedStats = await lstatWithinDeadline(quarantine, deadline);
    if (quarantinedStats === undefined || !quarantinedStats.isSocket()) {
      await restoreQuarantine(endpoint, quarantine, deadline);
      moved = false;
      return false;
    }
    const quarantinedIdentity = socketIdentity(quarantinedStats);
    if (expected !== undefined && !sameSocketObjectIdentity(quarantinedIdentity, expected)) {
      await restoreQuarantine(endpoint, quarantine, deadline);
      moved = false;
      return false;
    }

    const finalStats = await lstatWithinDeadline(quarantine, deadline);
    if (
      finalStats === undefined ||
      !finalStats.isSocket() ||
      !sameSocketObjectIdentity(socketIdentity(finalStats), quarantinedIdentity)
    ) {
      await restoreQuarantine(endpoint, quarantine, deadline);
      moved = false;
      return false;
    }
    const quarantineState = await probePosixEndpoint(
      quarantine,
      Math.max(0, deadline.at - Date.now()),
      socketFactory,
    );
    if (quarantineState !== 'stale') {
      await restoreQuarantine(endpoint, quarantine, deadline);
      moved = false;
      return false;
    }

    try {
      await withDeadline(fs.unlink(quarantine), deadline);
    } catch (error: unknown) {
      if (errorCode(error) === 'ENOENT') {
        moved = false;
        return false;
      }
      throw error;
    }
    moved = false;
    return true;
  } catch (error: unknown) {
    if (moved) {
      try {
        await restoreQuarantine(endpoint, quarantine, deadline);
      } catch (restoreError: unknown) {
        throw new AggregateError(
          [error, restoreError],
          'Local IPC endpoint quarantine recovery failed',
        );
      }
    }
    throw error;
  }
}

/**
 * Probe and remove a default-generated POSIX endpoint only after definitive
 * stale evidence. Windows named pipes are owned by the OS and never enter this
 * filesystem cleanup path.
 */
export async function removeStalePosixEndpoint(
  endpoint: string,
  timeoutMs = DEFAULT_STALE_PROBE_TIMEOUT_MS,
  socketFactory: SocketFactory = (candidateEndpoint) => createConnection(candidateEndpoint),
): Promise<boolean> {
  if (!isPosixRuntime()) {
    return false;
  }
  if (!isGeneratedPosixEndpoint(endpoint)) {
    throw new TransportError(
      'endpoint-not-owned',
      `Refusing stale cleanup for an unowned endpoint path ${endpoint}`,
    );
  }

  const timeout = normalizeTimeout(
    timeoutMs,
    DEFAULT_STALE_PROBE_TIMEOUT_MS,
    'staleProbeTimeoutMs',
  );
  const deadline = deadlineFrom('stale-cleanup', undefined, timeout);
  const observedStats = await lstatWithinDeadline(endpoint, deadline);
  if (observedStats === undefined) {
    return false;
  }
  if (!observedStats.isSocket()) {
    throw new TransportError(
      'endpoint-not-owned',
      `Refusing stale cleanup for non-socket endpoint path ${endpoint}`,
    );
  }
  const observed = socketIdentity(observedStats);
  const state = await probePosixEndpoint(
    endpoint,
    Math.max(0, deadline.at - Date.now()),
    socketFactory,
  );
  if (state === 'live') {
    throw new TransportError('endpoint-in-use', `A live listener owns endpoint ${endpoint}`);
  }
  if (state !== 'stale') {
    return false;
  }
  return unlinkOwnedSocket(endpoint, observed, deadline, socketFactory);
}

function writeFrameAndEnd(
  socket: Socket,
  frame: Buffer,
  onBackpressure: (() => void) | undefined,
  endAfterWrite: boolean,
  destroyAfterEnd: boolean,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    let writeReturned = false;
    let callbackCompleted = false;
    let drained = true;
    let ended = false;

    const cleanup = (): void => {
      socket.off('error', onError);
      socket.off('close', onClose);
      socket.off('drain', onDrain);
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
      fail(new TransportError('write-error', error.message, { cause: error, phase: 'write' }));
    const onClose = (): void =>
      fail(new TransportError('write-closed', 'Socket closed before the frame was written'));
    const onDrain = (): void => {
      drained = true;
      maybeEnd();
    };
    const onWrite = (): void => {
      callbackCompleted = true;
      maybeEnd();
    };
    const onEnd = (): void => {
      if (destroyAfterEnd) {
        destroySocket(socket);
      }
      settle(resolve);
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
        fail(new TransportError('write-error', asError(error).message, { cause: error }));
      }
    };

    socket.once('error', onError);
    socket.once('close', onClose);
    try {
      const accepted = socket.write(frame, onWrite);
      writeReturned = true;
      if (!accepted) {
        drained = false;
        onBackpressure?.();
        socket.once('drain', onDrain);
      }
      maybeEnd();
    } catch (error: unknown) {
      fail(new TransportError('write-error', asError(error).message, { cause: error }));
    }
  });
}

function waitForConnect(socket: Socket): Promise<void> {
  return new Promise<void>((resolve, reject) => {
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
    const onConnect = (): void => settle(resolve);
    const onError = (error: Error): void =>
      settle(() => reject(new TransportError('connect-error', error.message, { cause: error })));
    const onClose = (): void =>
      settle(() => reject(new TransportError('connect-closed', 'Socket closed before connect')));

    if (socket.destroyed) {
      settle(() => reject(new TransportError('connect-closed', 'Socket was already destroyed')));
      return;
    }
    socket.once('connect', onConnect);
    socket.once('error', onError);
    socket.once('close', onClose);
  });
}

function readResponse(socket: Socket, maxPayloadBytes: number): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const decoder = new FrameDecoder({ maxPayloadBytes });
    let settled = false;
    let settling = false;
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
    };
    const settle = (callback: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      callback();
    };
    const fail = (error: Error): void => {
      if (settled) {
        destroySocket(socket);
        return;
      }
      settle(() => reject(error));
    };
    const scheduleSuccess = (payload: Buffer): void => {
      if (settled || completionTimer !== undefined) {
        return;
      }
      settling = true;
      completionTimer = setImmediate(() => {
        completionTimer = setImmediate(() => {
          completionTimer = undefined;
          settle(() => resolve(payload));
        });
      });
    };
    const onData = (chunk: Buffer): void => {
      try {
        const payload = decoder.push(chunk);
        if (payload !== undefined) {
          scheduleSuccess(payload);
        }
      } catch (error: unknown) {
        fail(error instanceof FrameCodecError ? error : frameErrorOrTransport(error, 'read-error'));
      }
    };
    const onEnd = (): void => {
      if (settled || settling) {
        return;
      }
      try {
        scheduleSuccess(decoder.finish());
      } catch (error: unknown) {
        fail(
          error instanceof FrameCodecError
            ? error
            : new TransportError('premature-close', asError(error).message, { cause: error }),
        );
      }
    };
    const onError = (error: Error): void =>
      fail(new TransportError('read-error', error.message, { cause: error, phase: 'read' }));
    const onClose = (): void => {
      if (settled || settling) {
        return;
      }
      fail(new TransportError('premature-close', 'Socket closed before a complete response'));
    };

    socket.on('data', onData);
    socket.once('end', onEnd);
    socket.once('error', onError);
    socket.once('close', onClose);
  });
}

function readFrame(socket: Socket, maxPayloadBytes: number): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const decoder = new FrameDecoder({ maxPayloadBytes });
    let settled = false;
    const cleanup = (): void => {
      socket.off('data', onData);
      socket.off('end', onEnd);
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
    const fail = (error: Error): void => settle(() => reject(error));
    const onData = (chunk: Buffer): void => {
      try {
        const payload = decoder.push(chunk);
        if (payload !== undefined) {
          settle(() => resolve(payload));
        }
      } catch (error: unknown) {
        fail(error instanceof FrameCodecError ? error : frameErrorOrTransport(error, 'read-error'));
      }
    };
    const onEnd = (): void => {
      if (settled) {
        return;
      }
      try {
        settle(() => resolve(decoder.finish()));
      } catch (error: unknown) {
        fail(
          error instanceof FrameCodecError
            ? error
            : new TransportError('premature-close', asError(error).message, { cause: error }),
        );
      }
    };
    const onError = (error: Error): void =>
      fail(new TransportError('read-error', error.message, { cause: error, phase: 'read' }));
    const onClose = (): void =>
      fail(new TransportError('premature-close', 'Socket closed before a complete request'));

    socket.on('data', onData);
    socket.once('end', onEnd);
    socket.once('error', onError);
    socket.once('close', onClose);
  });
}

function validateRequestOptions(options: TransportRequestOptions): void {
  normalizeTimeout(options.connectTimeoutMs, DEFAULT_CONNECT_TIMEOUT_MS, 'connectTimeoutMs');
  normalizeTimeout(options.writeTimeoutMs, DEFAULT_WRITE_TIMEOUT_MS, 'writeTimeoutMs');
  normalizeTimeout(options.readTimeoutMs, DEFAULT_READ_TIMEOUT_MS, 'readTimeoutMs');
  normalizeTimeout(options.overallTimeoutMs, DEFAULT_OVERALL_TIMEOUT_MS, 'overallTimeoutMs');
  if (options.connectDeadline !== undefined) {
    deadlineFrom('connect', options.connectDeadline, 0);
  }
  if (options.writeDeadline !== undefined) {
    deadlineFrom('write', options.writeDeadline, 0);
  }
  if (options.readDeadline !== undefined) {
    deadlineFrom('read', options.readDeadline, 0);
  }
  if (options.overallDeadline !== undefined) {
    deadlineFrom('overall', options.overallDeadline, 0);
  }
}

export class LocalIpcTransport implements LocalIpcTransportContract {
  public readonly maxPayloadBytes: number;

  private readonly options: NormalizedOptions;
  private readonly serverSockets = new Set<Socket>();
  private readonly clientSockets = new Set<Socket>();
  private lifecycleTail: Promise<void> = Promise.resolve();
  private server: Server | undefined;
  private boundEndpoint: string | undefined;
  private ownedEndpoint: OwnedEndpoint | undefined;
  private handler: TransportHandler | undefined;
  private closing = false;
  private closed = false;
  private closePromise: Promise<void> | undefined;

  public constructor(options: LocalIpcOptions = {}) {
    this.options = normalizeOptions(options);
    this.maxPayloadBytes = this.options.maxPayloadBytes;
  }

  public bind(endpoint: string, handler: TransportHandler): Promise<BoundTransportServer> {
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

  private async bindInternal(
    endpoint: string,
    handler: TransportHandler,
  ): Promise<BoundTransportServer> {
    if (this.closing || this.closed) {
      throw new TransportError('shutdown-error', 'Transport is shutting down');
    }
    if (typeof handler !== 'function') {
      throw new TypeError('Local IPC handler must be a function');
    }
    if (this.server !== undefined || this.boundEndpoint !== undefined) {
      throw new TransportError(
        'invalid-options',
        'Local IPC transport already has a bound endpoint',
      );
    }
    try {
      assertIpcEndpoint(endpoint, { maxPosixBytes: this.options.posixEndpointMaxBytes });
    } catch (error: unknown) {
      if (error instanceof TransportError) {
        throw error;
      }
      throw new TransportError('invalid-endpoint', asError(error).message, { cause: error });
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
    const publish = async (): Promise<BoundTransportServer> => {
      if (this.closing || this.closed) {
        await discard();
        throw new TransportError('shutdown-error', 'Transport is shutting down');
      }
      const identity = isPosixRuntime() ? await lstatSocket(endpoint) : undefined;
      if (isPosixRuntime() && identity === undefined) {
        await discard();
        throw new TransportError('endpoint-not-owned', `Bound endpoint disappeared: ${endpoint}`);
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

      await discard(false);
      let removed = false;
      try {
        removed = await removeStalePosixEndpoint(
          endpoint,
          this.options.staleProbeTimeoutMs,
          this.options.socketFactory,
        );
      } catch (staleError: unknown) {
        if (staleError instanceof TransportError && staleError.code === 'endpoint-in-use') {
          throw staleError;
        }
        throw error;
      }
      if (!removed) {
        throw error;
      }

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

  public async request(
    endpoint: string,
    payload: TransportPayload,
    options: TransportRequestOptions = {},
  ): Promise<Buffer> {
    if (this.closing || this.closed) {
      throw new TransportError('shutdown-error', 'Transport is shutting down');
    }
    validateRequestOptions(options);
    assertIpcEndpoint(endpoint, { maxPosixBytes: this.options.posixEndpointMaxBytes });
    throwIfAborted(options.signal);

    const startedAt = Date.now();
    const bytes = payloadBytes(payload);
    const frame = encodeFrame(bytes, { maxPayloadBytes: this.maxPayloadBytes });
    const overallDeadline = deadlineFrom(
      'overall',
      options.overallDeadline,
      options.overallTimeoutMs ?? this.options.overallTimeoutMs,
      startedAt,
    );
    let socket: Socket | undefined;

    try {
      return await withDeadline(
        () => {
          if (this.closing || this.closed) {
            throw new TransportError('shutdown-error', 'Transport is shutting down');
          }
          socket = this.options.socketFactory(endpoint);
          trackSocket(this.clientSockets, socket);
          return this.requestOnSocket(socket, frame, options, overallDeadline, startedAt);
        },
        overallDeadline,
        { signal: options.signal, onTimeout: () => socket && destroySocket(socket) },
      );
    } finally {
      if (socket !== undefined) {
        destroySocket(socket);
      }
    }
  }

  private async requestOnSocket(
    socket: Socket,
    frame: Buffer,
    options: TransportRequestOptions,
    overallDeadline: AbsoluteDeadline,
    startedAt: number,
  ): Promise<Buffer> {
    const connectDeadline = earlierDeadline(
      deadlineFrom(
        'connect',
        options.connectDeadline,
        options.connectTimeoutMs ?? this.options.connectTimeoutMs,
        startedAt,
      ),
      overallDeadline,
    );
    await withDeadline(() => waitForConnect(socket), connectDeadline, {
      signal: options.signal,
      onTimeout: () => destroySocket(socket),
    });

    const writeDeadline = earlierDeadline(
      deadlineFrom(
        'write',
        options.writeDeadline,
        options.writeTimeoutMs ?? this.options.writeTimeoutMs,
      ),
      overallDeadline,
    );
    await withDeadline(
      () =>
        writeFrameAndEnd(
          socket,
          frame,
          this.options.onWriteBackpressure === undefined
            ? undefined
            : () => this.options.onWriteBackpressure?.('request'),
          false,
          false,
        ),
      writeDeadline,
      { signal: options.signal, onTimeout: () => destroySocket(socket) },
    );

    const readDeadline = earlierDeadline(
      deadlineFrom(
        'read',
        options.readDeadline,
        options.readTimeoutMs ?? this.options.readTimeoutMs,
      ),
      overallDeadline,
    );
    return withDeadline(() => readResponse(socket, this.maxPayloadBytes), readDeadline, {
      signal: options.signal,
      onTimeout: () => destroySocket(socket),
    });
  }

  public close(): Promise<void> {
    if (this.closePromise !== undefined) {
      return this.closePromise;
    }
    if (this.closed) {
      return Promise.resolve();
    }
    this.closing = true;
    this.closed = true;
    this.closePromise = this.enqueueLifecycle(() => this.closeInternal());
    return this.closePromise;
  }

  private createServer(): Server {
    const server = createServer({ allowHalfOpen: false }, (socket) =>
      this.handleConnection(socket),
    );
    // Keep asynchronous listener failures from becoming uncaught process errors after bind.
    server.on('error', () => undefined);
    return server;
  }

  private handleConnection(socket: Socket): void {
    trackSocket(this.serverSockets, socket);
    const handler = this.handler;
    if (handler === undefined || this.closing || this.closed) {
      destroySocket(socket);
      return;
    }

    const startedAt = Date.now();
    const overallDeadline = deadlineFrom(
      'overall',
      undefined,
      this.options.overallTimeoutMs,
      startedAt,
    );
    void this.handleServerConnection(socket, handler, overallDeadline, startedAt).catch(() => {
      destroySocket(socket);
    });
  }

  private async handleServerConnection(
    socket: Socket,
    handler: TransportHandler,
    overallDeadline: AbsoluteDeadline,
    startedAt: number,
  ): Promise<void> {
    let requestComplete = false;
    let responseWritten = false;
    const rejectTrailingData = (): void => {
      if (requestComplete) {
        destroySocket(socket);
      }
    };
    socket.on('data', rejectTrailingData);

    try {
      const readDeadline = earlierDeadline(
        deadlineFrom('server-read', undefined, this.options.readTimeoutMs, startedAt),
        overallDeadline,
      );
      const request = await withDeadline(
        () => readFrame(socket, this.maxPayloadBytes),
        readDeadline,
        {
          onTimeout: () => destroySocket(socket),
        },
      );
      requestComplete = true;
      if (this.closing || this.closed || socket.destroyed) {
        throw new TransportError('shutdown-error', 'Transport is shutting down');
      }

      let response: TransportPayload;
      try {
        response = await withDeadline(() => Promise.resolve(handler(request)), overallDeadline, {
          onTimeout: () => destroySocket(socket),
        });
      } catch (error: unknown) {
        throw frameErrorOrTransport(error, 'handler-error');
      }
      const frame = encodeFrame(payloadBytes(response), { maxPayloadBytes: this.maxPayloadBytes });
      const writeDeadline = earlierDeadline(
        deadlineFrom('server-write', undefined, this.options.writeTimeoutMs),
        overallDeadline,
      );
      await withDeadline(
        () =>
          writeFrameAndEnd(
            socket,
            frame,
            this.options.onWriteBackpressure === undefined
              ? undefined
              : () => this.options.onWriteBackpressure?.('response'),
            true,
            true,
          ),
        writeDeadline,
        { onTimeout: () => destroySocket(socket) },
      );
      responseWritten = true;
    } finally {
      socket.off('data', rejectTrailingData);
      if (!responseWritten) {
        destroySocket(socket);
      }
    }
  }

  private async closeInternal(): Promise<void> {
    const shutdownDeadline = deadlineFrom('shutdown', undefined, this.options.shutdownTimeoutMs);
    const server = this.server;
    const ownedEndpoint = this.ownedEndpoint;
    this.server = undefined;
    this.boundEndpoint = undefined;
    this.ownedEndpoint = undefined;
    this.handler = undefined;

    let serverCloseError: unknown;
    let serverClosed = server === undefined;
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
        for (const socket of sockets) {
          destroySocket(socket);
        }
        if (sockets.size > 0) {
          await Promise.race([
            ...[...sockets].map((socket) => socketClosed(socket)),
            new Promise<void>((resolve) => setImmediate(resolve)),
          ]);
          continue;
        }
        if (!serverClosed) {
          await new Promise<void>((resolve) => setImmediate(resolve));
          continue;
        }
        await new Promise<void>((resolve) => setImmediate(resolve));
        if (this.clientSockets.size === 0 && this.serverSockets.size === 0) {
          return;
        }
      }
    };
    const resourcesCompletion = Promise.all([serverCloseCompletion, drainResources()]).then(() => {
      if (serverCloseError !== undefined) {
        throw serverCloseError;
      }
    });
    const forceClose = (): void => {
      for (const socket of new Set([...this.clientSockets, ...this.serverSockets])) {
        destroySocket(socket);
      }
      (
        server as (Server & { closeAllConnections?: () => void }) | undefined
      )?.closeAllConnections?.();
    };

    let resourcesConfirmed = false;
    try {
      await withDeadline(resourcesCompletion, shutdownDeadline, { onTimeout: forceClose });
      resourcesConfirmed = true;
    } catch (error: unknown) {
      if (!(error instanceof PhaseDeadlineExceededError)) {
        throw new TransportError('shutdown-error', asError(error).message, { cause: error });
      }
      forceClose();
      const forceDeadline = deadlineFrom(
        'shutdown-force',
        undefined,
        this.options.forceShutdownTimeoutMs,
      );
      try {
        await withDeadline(resourcesCompletion, forceDeadline, { onTimeout: forceClose });
        resourcesConfirmed = true;
      } catch (forceError: unknown) {
        throw new TransportError('shutdown-error', asError(forceError).message, {
          cause: forceError,
          phase: 'shutdown',
        });
      }
    }

    if (resourcesConfirmed && ownedEndpoint !== undefined && isPosixRuntime()) {
      const cleanupDeadline = deadlineFrom(
        'endpoint-cleanup',
        undefined,
        Math.max(0, shutdownDeadline.at - Date.now()),
      );
      try {
        await unlinkOwnedSocket(ownedEndpoint.endpoint, ownedEndpoint.identity, cleanupDeadline);
      } catch (error: unknown) {
        throw new TransportError('shutdown-error', asError(error).message, { cause: error });
      }
    }
  }
}

export const LocalIpcServer = LocalIpcTransport;

export function createLocalIpcTransport(options: LocalIpcOptions = {}): LocalIpcTransport {
  return new LocalIpcTransport(options);
}

export async function bindLocalIpc(
  endpoint: string,
  handler: TransportHandler,
  options: LocalIpcOptions = {},
): Promise<BoundTransportServer & { readonly transport: LocalIpcTransport }> {
  const transport = new LocalIpcTransport(options);
  const bound = await transport.bind(endpoint, handler);
  return { ...bound, transport };
}

export async function requestLocalIpc(
  endpoint: string,
  payload: TransportPayload,
  options: LocalIpcRequestOptions = {},
): Promise<TransportPayload> {
  const transport = new LocalIpcTransport(options);
  try {
    return await transport.request(endpoint, payload, options);
  } finally {
    await transport.close();
  }
}

export { FrameDecoder, encodeFrame, normalizeMaxPayloadBytes } from './frame-codec.js';
export {
  assertIpcEndpoint,
  assertPosixEndpointLength,
  createIpcEndpoint,
  DEFAULT_POSIX_ENDPOINT_MAX_BYTES,
  DEFAULT_POSIX_ENDPOINT_ROOT,
  generateRuntimeId,
  isGeneratedPosixEndpoint,
  isWindowsPipeEndpoint,
  POSIX_ENDPOINT_PREFIX,
  POSIX_ENDPOINT_SUFFIX,
  utf8ByteLength,
  WINDOWS_DOT_PIPE_NAMESPACE,
  WINDOWS_PIPE_NAMESPACE,
} from './endpoint.js';
