import { describe, expect, it, vi } from 'vitest';

import { waitForPredicate, WaitAbortedError } from './wait.js';

describe('bounded predicate waits', () => {
  it('resolves an eventual value without a fixed sleep', async () => {
    let attempts = 0;

    await expect(
      waitForPredicate(
        async () => {
          attempts += 1;
          return attempts >= 3 ? { ready: true } : undefined;
        },
        { pollIntervalMs: 1, timeoutMs: 100, description: 'fixture readiness' },
      ),
    ).resolves.toEqual({ ready: true });
    expect(attempts).toBe(3);
  });

  it('rejects with a descriptive timeout and cleans up timers', async () => {
    vi.useFakeTimers();
    try {
      const wait = waitForPredicate(() => false, {
        description: 'lease availability',
        pollIntervalMs: 10,
        timeoutMs: 50,
      });

      const assertion = expect(wait).rejects.toMatchObject({
        attempts: 5,
        code: 'ERR_WAIT_TIMEOUT',
        description: 'lease availability',
        timeoutMs: 50,
      });
      await vi.advanceTimersByTimeAsync(50);
      await assertion;
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('can be aborted while a predicate is still pending', async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      const wait = waitForPredicate(() => new Promise<undefined>(() => undefined), {
        signal: controller.signal,
        timeoutMs: 10_000,
      });

      controller.abort('test cancellation');
      await expect(wait).rejects.toBeInstanceOf(WaitAbortedError);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
