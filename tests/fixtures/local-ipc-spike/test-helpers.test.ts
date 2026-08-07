import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  AbortError,
  MAX_TIMER_DELAY_MS,
  PhaseDeadlineExceededError,
  captureChildDiagnostics,
  cleanupChildProcess,
  createPhaseDeadline,
  diagnosticError,
  raceWithAbort,
  remainingMs,
  waitForChildExit,
  waitForChildWithDiagnostics,
  withDeadline,
  withPhaseDeadline,
} from './test-helpers.js';

afterEach(() => {
  vi.useRealTimers();
});
class HangingChild extends EventEmitter {
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  stdin = { destroyed: false };
  stdout = { destroyed: false };
  stderr = { destroyed: false };
  readonly signals: NodeJS.Signals[] = [];

  kill(signal: NodeJS.Signals): boolean {
    this.signals.push(signal);
    if (signal === 'SIGKILL') {
      this.signalCode = signal;
    }
    return true;
  }
}

class NullStdioExitedChild extends EventEmitter {
  exitCode: number | null = 3;
  signalCode: NodeJS.Signals | null = null;
  stdin = null;
  stdout = null;
  stderr = null;
}

class NullCloseStateChild extends EventEmitter {
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  stdin = null;
  stdout = null;
  stderr = null;
  readonly signals: NodeJS.Signals[] = [];

  kill(signal: NodeJS.Signals): boolean {
    this.signals.push(signal);
    return true;
  }
}

describe('local IPC spike test helpers', () => {
  it('represents phase deadlines as finite absolute timestamps', () => {
    const deadline = createPhaseDeadline('read', 100, 1_000);

    expect(deadline).toEqual({ phase: 'read', at: 1_100 });
    expect(remainingMs(deadline, 1_000)).toBe(100);
    expect(remainingMs(deadline, 1_050)).toBe(50);
    expect(remainingMs(deadline, 1_100)).toBe(0);
    expect(remainingMs(deadline, 2_000)).toBe(0);
    expect(() => createPhaseDeadline('read', Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });

  it('rejects at an absolute deadline and aborts the operation signal', async () => {
    vi.useFakeTimers();
    let operationSignal: AbortSignal | undefined;
    const pending = withPhaseDeadline('read', 25, (signal) => {
      operationSignal = signal;
      return new Promise<never>(() => undefined);
    });
    const assertion = expect(pending).rejects.toBeInstanceOf(PhaseDeadlineExceededError);

    await vi.advanceTimersByTimeAsync(25);

    await assertion;
    expect(operationSignal?.aborted).toBe(true);
    expect(operationSignal?.reason).toBeInstanceOf(PhaseDeadlineExceededError);
  });

  it('chains timer delays for absolute deadlines beyond Node timer limits', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const deadline = 10_000 + MAX_TIMER_DELAY_MS + 100;
    const pending = withDeadline(new Promise<never>(() => undefined), deadline);
    let settled = false;
    pending.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );

    await vi.advanceTimersByTimeAsync(MAX_TIMER_DELAY_MS);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(99);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).rejects.toMatchObject({
      name: 'PhaseDeadlineExceededError',
      deadline,
    });
  });
  it('rejects promptly when the caller aborts an operation', async () => {
    const controller = new AbortController();
    const pending = withPhaseDeadline('connect', 1_000, () => new Promise<never>(() => undefined), {
      signal: controller.signal,
    });

    controller.abort('caller cancelled');

    await expect(pending).rejects.toMatchObject({
      name: 'AbortError',
      code: 'ABORT_ERR',
    });
  });

  it('races a promise against an abort signal without waiting for its settlement', async () => {
    const controller = new AbortController();
    const pending = raceWithAbort(new Promise<never>(() => undefined), controller.signal);

    controller.abort();

    await expect(pending).rejects.toBeInstanceOf(AbortError);
  });

  it('returns a rejected promise for an already-aborted signal', async () => {
    const controller = new AbortController();
    controller.abort('already cancelled');

    const pending = raceWithAbort(new Promise<never>(() => undefined), controller.signal);

    expect(pending).toBeInstanceOf(Promise);
    await expect(pending).rejects.toMatchObject({
      name: 'AbortError',
      code: 'ABORT_ERR',
    });
  });
  it('drains an already-rejected operation when abort is already observed', async () => {
    const controller = new AbortController();
    controller.abort('already cancelled');
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      const operation = Promise.reject(new Error('operation failed after abort'));
      await expect(raceWithAbort(operation, controller.signal)).rejects.toMatchObject({
        name: 'AbortError',
        code: 'ABORT_ERR',
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });
  it('drains rejected non-function operations on early abort and deadline', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      const abortController = new AbortController();
      abortController.abort('already cancelled');
      const abortedOperation = Promise.reject(new Error('operation failed on abort'));
      await expect(
        withDeadline(abortedOperation, createPhaseDeadline('connect', 100), {
          signal: abortController.signal,
        }),
      ).rejects.toMatchObject({
        name: 'AbortError',
        code: 'ABORT_ERR',
      });
      const deadlineOperation = Promise.reject(new Error('operation failed on deadline'));
      await expect(
        withDeadline(deadlineOperation, createPhaseDeadline('read', 0)),
      ).rejects.toBeInstanceOf(PhaseDeadlineExceededError);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('cleans up a child process with a bounded escalation wait', async () => {
    const child = spawn(
      process.execPath,
      ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"],
      { stdio: 'ignore' },
    );

    const exit = await cleanupChildProcess(child, {
      timeoutMs: 50,
      forceWaitMs: 1_000,
    });

    expect(exit.timedOut).not.toBe(true);
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
  }, 5_000);

  it('waits for close with null stdio after exit metadata is available', async () => {
    const child = new NullStdioExitedChild();
    const pending = waitForChildExit(
      child as unknown as ChildProcess,
      createPhaseDeadline('child-exit', 100),
    );
    let settled = false;
    pending.then(() => {
      settled = true;
    });

    await Promise.resolve();
    expect(settled).toBe(false);

    child.emit('close', 3, null);
    await expect(pending).resolves.toEqual({ code: 3, signal: null });
  });

  it('does not report null-stdio exit metadata until close is observed', () => {
    const child = new NullStdioExitedChild();
    const capture = captureChildDiagnostics(child as unknown as ChildProcess);

    expect(capture.snapshot().exit).toBeUndefined();

    child.emit('close', 3, null);
    expect(capture.snapshot().exit).toEqual({ code: 3, signal: null });
    capture.dispose();
  });
  it('retains null/null close state and gates diagnostics until close', async () => {
    const child = new NullCloseStateChild();
    const capture = captureChildDiagnostics(child as unknown as ChildProcess);
    const pending = waitForChildWithDiagnostics(
      child as unknown as ChildProcess,
      createPhaseDeadline('child-diagnostics', 100),
    );

    expect(capture.snapshot().exit).toBeUndefined();
    child.emit('error', new Error('child failed before close'));
    await Promise.resolve();
    expect(capture.snapshot().exit).toBeUndefined();

    child.emit('close', null, null);
    await expect(pending).rejects.toMatchObject({
      name: 'ChildDiagnosticError',
      message: expect.stringContaining('code: null'),
    });
    expect(capture.snapshot().exit).toEqual({ code: null, signal: null });
    capture.dispose();
  });
  it('returns null/null close state and skips cleanup after close is observed', async () => {
    const child = new NullCloseStateChild();
    const observed = waitForChildExit(
      child as unknown as ChildProcess,
      createPhaseDeadline('child-exit', 100),
    );
    child.emit('close', null, null);
    await expect(observed).resolves.toEqual({ code: null, signal: null });

    await expect(
      cleanupChildProcess(child as unknown as ChildProcess, {
        timeoutMs: 100,
        forceWaitMs: 10,
      }),
    ).resolves.toEqual({ code: null, signal: null });
    expect(child.signals).toEqual([]);
  });
  it('defers child errors until close so diagnostics include close state', async () => {
    const child = new NullStdioExitedChild();
    const pending = waitForChildWithDiagnostics(
      child as unknown as ChildProcess,
      createPhaseDeadline('child-diagnostics', 100),
    );
    let settled = false;
    pending.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );

    child.emit('error', new Error('child failed before close'));
    await Promise.resolve();
    expect(settled).toBe(false);

    child.emit('close', 3, null);
    await expect(pending).rejects.toMatchObject({
      name: 'ChildDiagnosticError',
      message: expect.stringContaining('code: 3'),
    });
  });
  it('waits for close after exit before cleanup returns', async () => {
    const child = new HangingChild();
    child.exitCode = 3;
    const pending = cleanupChildProcess(child as unknown as ChildProcess, {
      timeoutMs: 100,
      forceWaitMs: 10,
    });

    let settled = false;
    pending.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    child.emit('close', 3, null);
    await expect(pending).resolves.toEqual({ code: 3, signal: null });
    expect(child.signals).toEqual(['SIGTERM']);
  });

  it('does not signal a child after a matching close is observed', async () => {
    const child = new HangingChild();
    child.exitCode = 3;
    const observed = waitForChildExit(
      child as unknown as ChildProcess,
      createPhaseDeadline('child-exit', 100),
    );

    child.emit('close', 3, null);
    await expect(observed).resolves.toEqual({ code: 3, signal: null });
    await expect(
      cleanupChildProcess(child as unknown as ChildProcess, {
        timeoutMs: 100,
        forceWaitMs: 10,
      }),
    ).resolves.toEqual({ code: 3, signal: null });
    expect(child.signals).toEqual([]);
  });

  it('does not let stale close state skip cleanup for a reused child', async () => {
    const child = new HangingChild();
    child.exitCode = 3;
    const observed = waitForChildExit(
      child as unknown as ChildProcess,
      createPhaseDeadline('child-exit', 100),
    );

    child.emit('close', 3, null);
    await expect(observed).resolves.toEqual({ code: 3, signal: null });

    child.exitCode = null;
    const pending = cleanupChildProcess(child as unknown as ChildProcess, {
      timeoutMs: 100,
      forceWaitMs: 10,
    });
    expect(child.signals).toEqual(['SIGTERM']);

    child.exitCode = 0;
    child.emit('close', 0, null);
    await expect(pending).resolves.toEqual({ code: 0, signal: null });
  });

  it('bounds post-kill cleanup when close never arrives', async () => {
    vi.useFakeTimers();
    const child = new HangingChild();
    const pending = cleanupChildProcess(child as unknown as ChildProcess, {
      timeoutMs: 5,
      forceWaitMs: 10,
    });

    await vi.advanceTimersByTimeAsync(5);
    await vi.advanceTimersByTimeAsync(10);
    await vi.advanceTimersByTimeAsync(10);

    await expect(pending).resolves.toMatchObject({
      code: null,
      signal: 'SIGKILL',
      timedOut: true,
    });
    expect(child.signals).toEqual(['SIGTERM', 'SIGKILL']);
  });
  it('captures bounded child diagnostics and renders a diagnostic error', async () => {
    const child = spawn(
      process.execPath,
      ['-e', "console.log('stdout-data'); console.error('stderr-data'); process.exit(3);"],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    const capture = captureChildDiagnostics(child, { maxOutputBytes: 5 });

    const exit = await waitForChildExit(child, createPhaseDeadline('diagnostics', 1_000));
    const diagnostics = capture.snapshot();
    capture.dispose();

    expect(exit.code).toBe(3);
    expect(diagnostics.stdout.length).toBeLessThanOrEqual(5);
    expect(diagnostics.stderr.length).toBeLessThanOrEqual(5);
    expect(diagnostics.outputTruncated).toBe(true);

    const error = diagnosticError(new Error('child failed'), diagnostics);
    expect(error.name).toBe('ChildDiagnosticError');
    expect(error.message).toContain('child failed');
    expect(error.message).toContain('stdout:');
    expect(error.message).toContain('stderr:');
    expect(error.message).toContain('code: 3');
    expect(error.message).toContain('signal: null');
  });
});
