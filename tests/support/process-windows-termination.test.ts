import { EventEmitter } from 'node:events';
import type { spawn } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';

import { terminateWindowsProcessTree } from './process.js';

describe('Windows process-tree termination support', () => {
  it('bounds the complete taskkill command lifecycle and detaches its resources on timeout', async () => {
    const taskkill = new EventEmitter() as EventEmitter & {
      exitCode: number | null;
      signalCode: NodeJS.Signals | null;
      kill: ReturnType<typeof vi.fn>;
      unref: ReturnType<typeof vi.fn>;
    };
    taskkill.exitCode = null;
    taskkill.signalCode = null;
    taskkill.kill = vi.fn(() => true);
    taskkill.unref = vi.fn(() => taskkill);
    const spawnCommand = vi.fn(() => taskkill) as unknown as typeof spawn;

    const startedAt = Date.now();
    await expect(terminateWindowsProcessTree(42, 20, spawnCommand)).rejects.toThrow(
      /taskkill did not finish within 20ms/,
    );

    expect(Date.now() - startedAt).toBeLessThan(200);
    expect(taskkill.kill).toHaveBeenCalledOnce();
    expect(taskkill.unref).toHaveBeenCalledOnce();
    expect(taskkill.listenerCount('error')).toBe(0);
    expect(taskkill.listenerCount('close')).toBe(0);
  });
});
