import { spawn } from 'node:child_process';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  AbortError,
  PhaseDeadlineExceededError,
  captureChildDiagnostics,
  cleanupChildProcess,
  createPhaseDeadline,
  diagnosticError,
  raceWithAbort,
  remainingMs,
  waitForChildExit,
  withPhaseDeadline,
} from './test-helpers.js';

afterEach(() => {
  vi.useRealTimers();
});

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
  });
});
