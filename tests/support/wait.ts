export const DEFAULT_WAIT_TIMEOUT_MS = 5_000;
export const DEFAULT_WAIT_POLL_INTERVAL_MS = 25;

export interface WaitForPredicateOptions {
  /** Maximum time to wait, including time spent inside an in-flight predicate. */
  readonly timeoutMs?: number;
  /** Delay between unsuccessful predicate attempts. The first attempt is immediate. */
  readonly pollIntervalMs?: number;
  /** Text included in timeout and abort messages. */
  readonly description?: string;
  /** Cancels the wait before its deadline. */
  readonly signal?: AbortSignal;
}

export type WaitPredicateResult<T> = T | false | null | undefined;
export type AsyncWaitPredicate<T> = (
  signal: AbortSignal,
) => WaitPredicateResult<T> | Promise<WaitPredicateResult<T>>;

export class WaitTimeoutError extends Error {
  readonly code = 'ERR_WAIT_TIMEOUT';
  readonly timeoutMs: number;
  readonly attempts: number;
  readonly description: string;
  readonly elapsedMs: number;

  constructor(options: {
    readonly timeoutMs: number;
    readonly attempts: number;
    readonly description: string;
    readonly elapsedMs: number;
  }) {
    super(
      `Timed out waiting for ${options.description} after ${options.timeoutMs}ms ` +
        `(${options.attempts} predicate attempt${options.attempts === 1 ? '' : 's'})`,
    );
    this.name = 'WaitTimeoutError';
    this.timeoutMs = options.timeoutMs;
    this.attempts = options.attempts;
    this.description = options.description;
    this.elapsedMs = options.elapsedMs;
  }
}

export class WaitAbortedError extends Error {
  readonly code = 'ABORT_ERR';
  readonly description: string;
  readonly reason: unknown;

  constructor(description: string, reason: unknown = undefined) {
    super(`Aborted while waiting for ${description}`);
    this.name = 'AbortError';
    this.description = description;
    this.reason = reason;
  }
}

/**
 * Waits for an injected asynchronous predicate without fixed sleeps.
 *
 * The predicate is called immediately and then after each polling interval
 * until it returns a non-sentinel value. The signal is aborted when the
 * caller aborts or the deadline expires, and every timer/listener owned by
 * this helper is removed before it settles.
 */
export async function waitForPredicate<T>(
  predicate: AsyncWaitPredicate<T>,
  options: WaitForPredicateOptions = {},
): Promise<T> {
  const timeoutMs = validateDuration(options.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS, 'timeout');
  const pollIntervalMs = validateDuration(
    options.pollIntervalMs ?? DEFAULT_WAIT_POLL_INTERVAL_MS,
    'poll interval',
  );
  const description = options.description ?? 'the expected condition';
  const callerSignal = options.signal;
  const controller = new AbortController();
  const startedAt = Date.now();
  let attempts = 0;
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  let timeoutError: WaitTimeoutError | undefined;
  let callerAbortHandler: (() => void) | undefined;

  const createTimeoutError = (): WaitTimeoutError =>
    new WaitTimeoutError({
      attempts,
      description,
      elapsedMs: Date.now() - startedAt,
      timeoutMs,
    });

  type CancellationOutcome =
    | { readonly kind: 'timeout'; readonly error: WaitTimeoutError }
    | { readonly kind: 'abort'; readonly error: WaitAbortedError };

  const timeoutPromise = new Promise<CancellationOutcome>((resolve) => {
    timeoutHandle = setTimeout(() => {
      timeoutError = createTimeoutError();
      controller.abort(timeoutError);
      resolve({ error: timeoutError, kind: 'timeout' });
    }, timeoutMs);
  });

  const callerAbortPromise = callerSignal
    ? new Promise<CancellationOutcome>((resolve) => {
        callerAbortHandler = (): void => {
          const error = new WaitAbortedError(description, callerSignal.reason);
          controller.abort(error);
          resolve({ error, kind: 'abort' });
        };
        if (callerSignal.aborted) {
          callerAbortHandler();
        } else {
          callerSignal.addEventListener('abort', callerAbortHandler, { once: true });
        }
      })
    : undefined;

  try {
    if (callerSignal?.aborted) {
      throw new WaitAbortedError(description, callerSignal.reason);
    }

    for (;;) {
      attempts += 1;
      const predicatePromise = Promise.resolve()
        .then(() => predicate(controller.signal))
        .then((value) => ({ kind: 'predicate' as const, value }));
      const outcome = await Promise.race([
        predicatePromise,
        timeoutPromise,
        ...(callerAbortPromise ? [callerAbortPromise] : []),
      ]);

      if (outcome.kind === 'timeout' || outcome.kind === 'abort') {
        throw outcome.error;
      }
      if (isSatisfied(outcome.value)) {
        return outcome.value;
      }

      const remainingMs = timeoutMs - (Date.now() - startedAt);
      if (remainingMs <= 0) {
        timeoutError ??= createTimeoutError();
        throw timeoutError;
      }

      const delayMs = Math.min(pollIntervalMs, remainingMs);
      await delayWithAbort(delayMs, controller.signal);
    }
  } finally {
    if (timeoutHandle !== undefined) {
      clearTimeout(timeoutHandle);
    }
    if (callerSignal && callerAbortHandler) {
      callerSignal.removeEventListener('abort', callerAbortHandler);
    }
    controller.abort(timeoutError);
  }
}

/** Short alias for callers that prefer a concise wait name. */
export const waitFor = waitForPredicate;

function validateDuration(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${label} must be a finite non-negative number; received ${value}`);
  }
  return value;
}

function isSatisfied<T>(value: WaitPredicateResult<T>): value is T {
  return value !== false && value !== null && value !== undefined;
}

async function delayWithAbort(durationMs: number, signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, durationMs);
    const cleanup = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
    };
    const onAbort = (): void => {
      cleanup();
      reject(signal.reason ?? new WaitAbortedError('the expected condition'));
    };

    if (signal.aborted) {
      onAbort();
      return;
    }

    signal.addEventListener('abort', onAbort, { once: true });
  });
}
