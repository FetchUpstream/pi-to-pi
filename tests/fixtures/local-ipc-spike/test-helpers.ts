/**
 * Bounded lifecycle helpers for local-IPC spike tests.
 *
 * These helpers deliberately live under the fixture area. They are not part of
 * the production transport or Pi message/task APIs.
 */

import type { ChildProcess } from 'node:child_process';

export const MAX_TIMER_DELAY_MS = 2_147_483_647;
export const DEFAULT_PHASE_TIMEOUT_MS = 5_000;
export const DEFAULT_CHILD_CLEANUP_TIMEOUT_MS = 1_000;
export const DEFAULT_FORCE_KILL_WAIT_MS = 250;
export const DEFAULT_DIAGNOSTIC_OUTPUT_BYTES = 64 * 1024;
export const DEFAULT_DIAGNOSTIC_ERROR_COUNT = 16;

export interface PhaseDeadline {
  readonly phase: string;
  readonly at: number;
}

export type Deadline = PhaseDeadline | number;

export interface DeadlineOptions {
  readonly signal?: AbortSignal;
  readonly onTimeout?: () => void;
}

export class PhaseDeadlineExceededError extends Error {
  readonly code = 'ERR_PHASE_DEADLINE_EXCEEDED';
  readonly phase: string;
  readonly deadline: number;

  constructor(phase: string, deadline: number) {
    super(`Phase "${phase}" exceeded its deadline at ${deadline}`);
    this.name = 'PhaseDeadlineExceededError';
    this.phase = phase;
    this.deadline = deadline;
  }
}

export class AbortError extends Error {
  readonly code = 'ABORT_ERR';

  constructor(message = 'The operation was aborted', cause?: unknown) {
    if (cause === undefined) {
      super(message);
    } else {
      super(message, { cause });
    }
    this.name = 'AbortError';
  }
}

function validatePhase(phase: string): string {
  if (typeof phase !== 'string' || phase.trim().length === 0) {
    throw new TypeError('phase must be a non-empty string');
  }
  return phase;
}

function validateNow(now: number): number {
  if (!Number.isFinite(now)) {
    throw new RangeError(`clock value must be finite, got ${String(now)}`);
  }
  return now;
}

function validateDuration(timeoutMs: number): number {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0 || timeoutMs > MAX_TIMER_DELAY_MS) {
    throw new RangeError(
      `timeout must be finite and between 0 and ${MAX_TIMER_DELAY_MS} milliseconds, got ${String(timeoutMs)}`,
    );
  }
  return timeoutMs;
}

function resolveDeadline(deadline: Deadline): PhaseDeadline {
  if (typeof deadline === 'number') {
    if (!Number.isFinite(deadline)) {
      throw new RangeError(`deadline must be finite, got ${String(deadline)}`);
    }
    return { phase: 'phase', at: deadline };
  }

  if (
    deadline === null ||
    typeof deadline !== 'object' ||
    typeof deadline.phase !== 'string' ||
    !Number.isFinite(deadline.at)
  ) {
    throw new TypeError('deadline must be a finite timestamp or PhaseDeadline');
  }

  return deadline;
}

/** Create a finite absolute deadline for one named phase. */
export function createPhaseDeadline(
  phase: string,
  timeoutMs: number,
  now = Date.now(),
): PhaseDeadline {
  const validPhase = validatePhase(phase);
  const validNow = validateNow(now);
  const validTimeout = validateDuration(timeoutMs);
  if (validTimeout > Number.MAX_VALUE - validNow) {
    throw new RangeError(
      `deadline must remain finite after adding timeout, got now=${validNow}, timeout=${validTimeout}`,
    );
  }
  const at = validNow + validTimeout;
  if (!Number.isFinite(at)) {
    throw new RangeError(`deadline must be finite after adding timeout, got ${String(at)}`);
  }
  return { phase: validPhase, at };
}

/** Create a finite absolute timestamp for callers that do not need a phase name. */
export function deadlineAfter(timeoutMs: number, now = Date.now()): number {
  return createPhaseDeadline('phase', timeoutMs, now).at;
}

export const createDeadline = deadlineAfter;

/** Return bounded milliseconds remaining until an absolute deadline. */
export function remainingMs(deadline: Deadline, now = Date.now()): number {
  const validNow = validateNow(now);
  const resolved = resolveDeadline(deadline);
  const remaining = resolved.at - validNow;
  if (remaining <= 0) {
    return 0;
  }
  return Math.min(MAX_TIMER_DELAY_MS, Math.ceil(remaining));
}

/** Schedule an absolute deadline without exceeding Node's maximum timer delay. */
function scheduleDeadlineTimer(deadline: PhaseDeadline, onTimeout: () => void): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancelled = false;

  const schedule = (): void => {
    if (cancelled) {
      return;
    }

    const delay = remainingMs(deadline);
    if (delay === 0) {
      onTimeout();
      return;
    }

    timer = setTimeout(() => {
      timer = undefined;
      schedule();
    }, delay);
  };

  schedule();

  return () => {
    cancelled = true;
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  };
}

export function deadlinePhase(deadline: Deadline): string {
  return resolveDeadline(deadline).phase;
}

function errorFromUnknown(value: unknown, fallback = 'Unknown error'): Error {
  if (value instanceof Error) {
    return value;
  }
  if (typeof value === 'string' && value.length > 0) {
    return new Error(value);
  }

  let rendered: string;
  try {
    rendered = JSON.stringify(value);
  } catch {
    rendered = String(value);
  }
  return new Error(rendered === undefined ? fallback : rendered);
}

function abortErrorFromReason(reason: unknown): AbortError {
  if (reason instanceof AbortError) {
    return reason;
  }
  if (reason instanceof Error && reason.name === 'AbortError') {
    return new AbortError(reason.message, reason);
  }
  if (reason instanceof Error) {
    return new AbortError(reason.message, reason);
  }
  if (typeof reason === 'string' && reason.length > 0) {
    return new AbortError(reason);
  }
  return new AbortError();
}

/** Throw a stable AbortError when a signal has already been cancelled. */
export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw abortErrorFromReason(signal.reason);
  }
}

/** Subscribe to an AbortSignal and return a listener removal function. */
export function onAbort(
  signal: AbortSignal | undefined,
  callback: (error: AbortError) => void,
): () => void {
  if (signal === undefined) {
    return () => undefined;
  }

  let active = true;
  const listener = (): void => {
    if (active) {
      callback(abortErrorFromReason(signal.reason));
    }
  };

  if (signal.aborted) {
    callback(abortErrorFromReason(signal.reason));
    return () => undefined;
  }

  signal.addEventListener('abort', listener, { once: true });

  return () => {
    active = false;
    signal.removeEventListener('abort', listener);
  };
}

/**
 * Reject a promise when a signal aborts without leaving an unhandled rejection
 * when the underlying operation settles later.
 */
export function raceWithAbort<T>(
  operation: PromiseLike<T> | T,
  signal: AbortSignal | undefined,
): Promise<T> {
  const operationPromise: Promise<T> = Promise.resolve(operation);

  if (signal === undefined) {
    return operationPromise;
  }

  if (signal.aborted) {
    void operationPromise.catch(() => undefined);
    return Promise.reject(abortErrorFromReason(signal.reason));
  }
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const removeAbortListener = onAbort(signal, (error) => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    });

    operationPromise.then(
      (value) => {
        if (!settled) {
          settled = true;
          removeAbortListener();
          resolve(value);
        }
      },
      (error: unknown) => {
        if (!settled) {
          settled = true;
          removeAbortListener();
          reject(error);
        }
      },
    );
  });
}

export const abortable = raceWithAbort;

type DeadlineOperation<T> = PromiseLike<T> | T | ((signal: AbortSignal) => PromiseLike<T> | T);

/**
 * Run an operation against one absolute deadline and optional caller signal.
 * The timer is calculated once from the absolute timestamp; it is not reset by
 * progress or by intermediate promise continuations.
 */
export function withDeadline<T>(
  operation: DeadlineOperation<T>,
  deadline: Deadline,
  options: DeadlineOptions = {},
): Promise<T> {
  const nonFunctionOperation: Promise<T> | undefined =
    typeof operation === 'function' ? undefined : Promise.resolve(operation);
  if (nonFunctionOperation !== undefined) {
    void nonFunctionOperation.catch(() => undefined);
  }
  const resolvedDeadline = resolveDeadline(deadline);
  const timeoutMs = remainingMs(resolvedDeadline);
  const controller = new AbortController();
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let cancelTimer = (): void => undefined;
    let removeAbortListener = (): void => undefined;

    const settle = (callback: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      cancelTimer();
      removeAbortListener();
      callback();
    };

    const rejectForAbort = (error: AbortError): void => {
      controller.abort(error);
      settle(() => reject(error));
    };

    const rejectForTimeout = (): void => {
      const error = new PhaseDeadlineExceededError(resolvedDeadline.phase, resolvedDeadline.at);
      controller.abort(error);
      settle(() => reject(error));
      try {
        options.onTimeout?.();
      } catch {
        // Timeout callbacks are diagnostics/cleanup hooks; they must not make
        // the bounded operation hang or replace its deadline error.
      }
    };

    if (options.signal?.aborted) {
      rejectForAbort(abortErrorFromReason(options.signal.reason));
      return;
    }

    if (timeoutMs === 0) {
      rejectForTimeout();
      return;
    }

    removeAbortListener = onAbort(options.signal, rejectForAbort);
    if (settled) {
      return;
    }

    cancelTimer = scheduleDeadlineTimer(resolvedDeadline, rejectForTimeout);
    if (settled) {
      return;
    }
    let operationResult: Promise<T>;
    try {
      operationResult =
        nonFunctionOperation ??
        Promise.resolve(
          (operation as (signal: AbortSignal) => PromiseLike<T> | T)(controller.signal),
        );
    } catch (error: unknown) {
      settle(() => reject(error));
      return;
    }

    operationResult.then(
      (value) => settle(() => resolve(value)),
      (error: unknown) => settle(() => reject(error)),
    );
  });
}

/** Run a phase with a fresh finite absolute deadline. */
export function withPhaseDeadline<T>(
  phase: string,
  timeoutMs: number,
  operation: DeadlineOperation<T>,
  options: DeadlineOptions = {},
): Promise<T> {
  return withDeadline(operation, createPhaseDeadline(phase, timeoutMs), options);
}

export interface ChildExit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly timedOut?: boolean;
}

function childExitState(child: ChildProcess): ChildExit | undefined {
  if (child.exitCode !== null || child.signalCode !== null) {
    return { code: child.exitCode, signal: child.signalCode };
  }
  return undefined;
}

interface ChildCloseObservationState {
  generation: symbol;
  child: ChildProcess;
  pid: number | undefined;
  closed: boolean;
  result: ChildExit | undefined;
  pendingError: Error | undefined;
  completion: Promise<ChildExit>;
  onClose: (code: number | null, signal: NodeJS.Signals | null) => void;
  onError: (error: unknown) => void;
  onSpawn: () => void;
}

const childCloseStates = new WeakMap<ChildProcess, ChildCloseObservationState>();

function createChildCloseObservation(child: ChildProcess): ChildCloseObservationState {
  let resolveCompletion: (result: ChildExit) => void = () => undefined;
  let rejectCompletion: (error: unknown) => void = () => undefined;
  const observation = {} as ChildCloseObservationState;
  const completion = new Promise<ChildExit>((resolve, reject) => {
    resolveCompletion = resolve;
    rejectCompletion = reject;
  });
  void completion.catch(() => undefined);
  observation.generation = Symbol('child-close-generation');
  observation.child = child;
  observation.pid = child.pid;
  observation.closed = false;
  observation.result = undefined;
  observation.pendingError = undefined;
  observation.completion = completion;
  observation.onClose = (code, signal): void => {
    if (observation.closed) {
      return;
    }
    observation.closed = true;
    observation.result = { code, signal };
    child.removeListener('error', observation.onError);
    if (observation.pendingError !== undefined) {
      rejectCompletion(observation.pendingError);
    } else {
      resolveCompletion(observation.result);
    }
  };
  observation.onError = (error): void => {
    if (observation.pendingError === undefined) {
      observation.pendingError = errorFromUnknown(error);
    }
  };
  observation.onSpawn = (): void => {
    if (observation.closed) {
      if (childCloseStates.get(child)?.generation === observation.generation) {
        childCloseStates.delete(child);
      }
      child.removeListener('spawn', observation.onSpawn);
      return;
    }
    observation.pid = child.pid;
  };
  return observation;
}

function disposeChildCloseObservation(observation: ChildCloseObservationState): void {
  if (childCloseStates.get(observation.child)?.generation === observation.generation) {
    childCloseStates.delete(observation.child);
  }
  observation.child.removeListener('error', observation.onError);
  observation.child.removeListener('close', observation.onClose);
  observation.child.removeListener('spawn', observation.onSpawn);
}

function ensureChildCloseObservation(child: ChildProcess): ChildCloseObservationState {
  let observation = childCloseStates.get(child);
  if (observation !== undefined) {
    if (observation.closed && observation.pid !== child.pid) {
      disposeChildCloseObservation(observation);
      observation = undefined;
    } else {
      if (!observation.closed) {
        observation.pid = child.pid;
      }
      return observation;
    }
  }
  observation = createChildCloseObservation(child);
  childCloseStates.set(child, observation);
  child.on('error', observation.onError);
  child.once('close', observation.onClose);
  child.on('spawn', observation.onSpawn);
  return observation;
}

function observedChildCloseState(child: ChildProcess): ChildExit | undefined {
  const observation = childCloseStates.get(child);
  if (observation === undefined || !observation.closed || observation.result === undefined) {
    return undefined;
  }
  // `closed` and the generation token are lifecycle state, not exit metadata.
  // A changed pid identifies a reused child and retires the old observation;
  // post-close updates to exitCode/signalCode do not invalidate a real close.
  if (observation.pid !== child.pid) {
    disposeChildCloseObservation(observation);
    return undefined;
  }
  return observation.result;
}

function recordChildError(observation: ChildCloseObservationState, error: unknown): void {
  if (!observation.closed && observation.pendingError === undefined) {
    observation.pendingError = errorFromUnknown(error);
  }
}

/** Wait for child close using one absolute, bounded deadline. */
export function waitForChildExit(
  child: ChildProcess,
  deadline: Deadline = createPhaseDeadline('child-exit', DEFAULT_PHASE_TIMEOUT_MS),
  signal?: AbortSignal,
): Promise<ChildExit> {
  const observation = ensureChildCloseObservation(child);
  if (observation.closed && observation.result !== undefined) {
    if (observation.pendingError !== undefined) {
      return Promise.reject(observation.pendingError);
    }
    return Promise.resolve(observation.result);
  }

  // `exit` fires before `close`; always wait for close so piped stdio is drained.
  return withDeadline(observation.completion, deadline, { signal });
}

export interface ChildCleanupOptions {
  readonly deadline?: Deadline;
  readonly timeoutMs?: number;
  readonly forceWaitMs?: number;
  readonly signal?: AbortSignal;
  readonly terminateSignal?: NodeJS.Signals;
  readonly forceSignal?: NodeJS.Signals;
}

function killChild(child: ChildProcess, signal: NodeJS.Signals): void {
  const observed = observedChildCloseState(child);
  if (observed !== undefined) {
    return;
  }
  const observation = ensureChildCloseObservation(child);
  if (observation.closed) {
    return;
  }
  const currentExit = childExitState(child);
  if (currentExit?.signal === signal) {
    return;
  }
  try {
    child.kill(signal);
  } catch (error: unknown) {
    // Record synchronous kill failures on the already-installed close observer;
    // close-gated waiters will surface the first error without unhandled events.
    recordChildError(observation, error);
  }
}

/**
 * Terminate a child and escalate once the first absolute deadline expires.
 * The initial, escalation, and post-kill close waits are finite. If the child
 * still has not closed after the final bounded attempt, its best-known state is returned.
 */
export async function cleanupChildProcess(
  child: ChildProcess,
  options: ChildCleanupOptions = {},
): Promise<ChildExit> {
  const initialDeadline =
    options.deadline ??
    createPhaseDeadline('child-cleanup', options.timeoutMs ?? DEFAULT_CHILD_CLEANUP_TIMEOUT_MS);
  const forceWaitMs = options.forceWaitMs ?? DEFAULT_FORCE_KILL_WAIT_MS;
  validateDuration(forceWaitMs);

  // Arm the close/error observer before issuing any teardown signal.
  const initialWait = waitForChildExit(child, initialDeadline, options.signal);
  killChild(child, options.terminateSignal ?? 'SIGTERM');

  try {
    return await initialWait;
  } catch (error: unknown) {
    if (!(error instanceof PhaseDeadlineExceededError) && !(error instanceof AbortError)) {
      throw error;
    }
  }

  const forceDeadline = createPhaseDeadline('child-force-kill', forceWaitMs);
  const forceWait = waitForChildExit(child, forceDeadline);
  killChild(child, options.forceSignal ?? 'SIGKILL');
  try {
    return await forceWait;
  } catch (error: unknown) {
    if (!(error instanceof PhaseDeadlineExceededError)) {
      throw error;
    }
    const closeDeadline = createPhaseDeadline('child-close', forceWaitMs);
    const closeWait = waitForChildExit(child, closeDeadline);
    killChild(child, options.forceSignal ?? 'SIGKILL');
    try {
      const finalExit = await closeWait;
      return { ...finalExit, timedOut: true };
    } catch (closeError: unknown) {
      if (!(closeError instanceof PhaseDeadlineExceededError)) {
        throw closeError;
      }
      // A recorded close tuple is authoritative even when both fields are null;
      // mutable ChildProcess metadata can change after close.
      const observedExit = observedChildCloseState(child);
      if (observedExit !== undefined) {
        return { ...observedExit, timedOut: true };
      }
      const currentExit = childExitState(child);
      return {
        code: currentExit?.code ?? child.exitCode,
        signal: currentExit?.signal ?? child.signalCode,
        timedOut: true,
      };
    }
  }
}

export const terminateChildProcess = cleanupChildProcess;

class BoundedText {
  private readonly chunks: string[] = [];
  private bytes = 0;
  private wasTruncated = false;

  constructor(private readonly maxBytes: number) {}

  append(value: Buffer | string): void {
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
    const remaining = this.maxBytes - this.bytes;
    if (remaining <= 0) {
      if (bytes.byteLength > 0) {
        this.wasTruncated = true;
      }
      return;
    }

    const accepted = bytes.subarray(0, remaining);
    this.chunks.push(accepted.toString('utf8'));
    this.bytes += accepted.byteLength;
    if (accepted.byteLength < bytes.byteLength) {
      this.wasTruncated = true;
    }
  }

  value(): string {
    return this.chunks.join('');
  }

  get truncated(): boolean {
    return this.wasTruncated;
  }
}

export interface DiagnosticCaptureOptions {
  readonly maxOutputBytes?: number;
  readonly maxErrorCount?: number;
}

export interface ChildDiagnostics {
  readonly stdout: string;
  readonly stderr: string;
  readonly errors: readonly Error[];
  readonly outputTruncated: boolean;
  readonly exit?: ChildExit;
}

export interface DiagnosticCapture {
  snapshot(): ChildDiagnostics;
  dispose(): void;
}

function validateCount(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`diagnostic count must be a non-negative integer, got ${String(value)}`);
  }
  return value;
}

/** Capture bounded child stdout/stderr and process errors without waiting. */
export function captureChildDiagnostics(
  child: ChildProcess,
  options: DiagnosticCaptureOptions = {},
): DiagnosticCapture {
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_DIAGNOSTIC_OUTPUT_BYTES;
  const maxErrorCount = options.maxErrorCount ?? DEFAULT_DIAGNOSTIC_ERROR_COUNT;
  validateDuration(maxOutputBytes);
  validateCount(maxErrorCount);
  ensureChildCloseObservation(child);

  const stdout = new BoundedText(maxOutputBytes);
  const stderr = new BoundedText(maxOutputBytes);
  const errors: Error[] = [];
  let disposed = false;

  const onStdout = (chunk: Buffer | string): void => stdout.append(chunk);
  const onStderr = (chunk: Buffer | string): void => stderr.append(chunk);
  const onError = (error: Error): void => {
    if (errors.length < maxErrorCount) {
      errors.push(errorFromUnknown(error));
    }
  };

  child.stdout?.on('data', onStdout);
  child.stderr?.on('data', onStderr);
  child.on('error', onError);

  const dispose = (): void => {
    if (disposed) {
      return;
    }
    disposed = true;
    child.stdout?.off('data', onStdout);
    child.stderr?.off('data', onStderr);
    child.off('error', onError);
  };

  return {
    snapshot: (): ChildDiagnostics => ({
      stdout: stdout.value(),
      stderr: stderr.value(),
      errors: [...errors],
      outputTruncated: stdout.truncated || stderr.truncated,
      exit: observedChildCloseState(child),
    }),
    dispose,
  };
}

export const captureDiagnostics = captureChildDiagnostics;

/** Render bounded child diagnostics into one actionable error. */
export function diagnosticError(failure: unknown, diagnostics: ChildDiagnostics): Error {
  const cause = errorFromUnknown(failure);
  const sections = [`${cause.name}: ${cause.message}`];
  if (diagnostics.exit !== undefined) {
    sections.push(
      `exit:\ncode: ${String(diagnostics.exit.code)}\nsignal: ${String(diagnostics.exit.signal)}`,
    );
  }
  if (diagnostics.stdout.length > 0) {
    sections.push(`stdout:\n${diagnostics.stdout}`);
  }
  if (diagnostics.stderr.length > 0) {
    sections.push(`stderr:\n${diagnostics.stderr}`);
  }
  if (diagnostics.errors.length > 0) {
    sections.push(`errors:\n${diagnostics.errors.map((error) => error.message).join('\n')}`);
  }
  if (diagnostics.outputTruncated) {
    sections.push('diagnostic output truncated');
  }

  const result = new Error(sections.join('\n\n'), { cause });
  result.name = 'ChildDiagnosticError';
  return result;
}

export const createDiagnosticError = diagnosticError;

/** Wait for child close and include bounded diagnostics if the wait fails. */
export async function waitForChildWithDiagnostics(
  child: ChildProcess,
  deadline: Deadline = createPhaseDeadline('child-diagnostics', DEFAULT_PHASE_TIMEOUT_MS),
  options: DiagnosticCaptureOptions = {},
): Promise<ChildDiagnostics> {
  const capture = captureChildDiagnostics(child, options);
  try {
    await waitForChildExit(child, deadline);
    return capture.snapshot();
  } catch (error: unknown) {
    throw diagnosticError(error, capture.snapshot());
  } finally {
    capture.dispose();
  }
}
