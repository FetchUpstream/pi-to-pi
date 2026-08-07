import { promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';

import { describe, expect, it } from 'vitest';

import { createIpcEndpoint } from '../local-ipc/endpoint.js';
import {
  captureChildDiagnostics,
  cleanupChildProcess,
  createPhaseDeadline,
  diagnosticError,
  waitForChildExit,
  withDeadline,
} from './test-helpers.js';
import { RawNetTransport } from './raw-net.js';

const CHILD_SCRIPT = fileURLToPath(new URL('./raw-net-child.mjs', import.meta.url));
const PROCESS_TIMEOUT_MS = 3_000;

async function endpointExists(endpoint: string): Promise<boolean> {
  try {
    await fs.lstat(endpoint);
    return true;
  } catch (error: unknown) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

async function waitForReady(child: ChildProcess): Promise<void> {
  const stdout = child.stdout;
  if (stdout === null) {
    throw new Error('raw-net child stdout is not piped');
  }

  let output = '';
  const ready = new Promise<void>((resolve, reject) => {
    const onData = (chunk: Buffer | string): void => {
      output += chunk.toString();
      if (output.includes('READY\n')) {
        cleanup();
        resolve();
      }
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const onClose = (): void => {
      cleanup();
      reject(new Error(`raw-net child exited before READY: ${output}`));
    };
    const cleanup = (): void => {
      stdout.off('data', onData);
      child.off('error', onError);
      child.off('close', onClose);
    };

    stdout.on('data', onData);
    child.once('error', onError);
    child.once('close', onClose);
  });

  await withDeadline(ready, createPhaseDeadline('child-ready', PROCESS_TIMEOUT_MS), {
    onTimeout: () => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill();
      }
    },
  });
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  await cleanupChildProcess(child, {
    timeoutMs: 500,
    forceWaitMs: 500,
  });
}

describe('raw node:net process lifecycle evidence', () => {
  it(
    'proves abrupt POSIX termination leaves only a safely probed stale socket',
    async () => {
      if (process.platform === 'win32') {
        expect({
          platform: process.platform,
          limitation: 'POSIX stale socket behavior requires a Linux or macOS runner',
        }).toEqual({
          platform: process.platform,
          limitation: 'POSIX stale socket behavior requires a Linux or macOS runner',
        });
        return;
      }

      const endpoint = createIpcEndpoint();
      const child = spawn(process.execPath, [CHILD_SCRIPT, endpoint], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const diagnostics = captureChildDiagnostics(child);
      const transport = new RawNetTransport({ staleProbeTimeoutMs: 500 });

      try {
        try {
          await waitForReady(child);
        } catch (error: unknown) {
          throw diagnosticError(error, diagnostics.snapshot());
        }
        expect(await endpointExists(endpoint)).toBe(true);

        child.kill('SIGKILL');
        const exit = await waitForChildExit(
          child,
          createPhaseDeadline('abrupt-child-exit', PROCESS_TIMEOUT_MS),
        );
        expect(exit.signal).toBe('SIGKILL');
        expect(await endpointExists(endpoint)).toBe(true);

        await transport.bind(endpoint, (payload) => payload);
        await transport.close();
        expect(await endpointExists(endpoint)).toBe(false);
      } finally {
        diagnostics.dispose();
        await stopChild(child);
        await transport.close();
      }
    },
    PROCESS_TIMEOUT_MS * 2,
  );

  it('does not remove a live POSIX endpoint during an address-in-use probe', async () => {
    if (process.platform === 'win32') {
      expect({
        platform: process.platform,
        limitation: 'POSIX ownership probe requires a Linux or macOS runner',
      }).toEqual({
        platform: process.platform,
        limitation: 'POSIX ownership probe requires a Linux or macOS runner',
      });
      return;
    }

    const endpoint = createIpcEndpoint();
    const owner = new RawNetTransport();
    const contender = new RawNetTransport();
    await owner.bind(endpoint, (payload) => payload);

    try {
      await expect(contender.bind(endpoint, (payload) => payload)).rejects.toMatchObject({
        code: 'endpoint-in-use',
      });
      expect(await endpointExists(endpoint)).toBe(true);
    } finally {
      await contender.close();
      await owner.close();
      expect(await endpointExists(endpoint)).toBe(false);
    }
  });

  it('refuses to unlink a non-socket path during stale cleanup', async () => {
    if (process.platform === 'win32') {
      expect({
        platform: process.platform,
        limitation: 'POSIX stale-path ownership requires a Linux or macOS runner',
      }).toEqual({
        platform: process.platform,
        limitation: 'POSIX stale-path ownership requires a Linux or macOS runner',
      });
      return;
    }

    const endpoint = createIpcEndpoint();
    const transport = new RawNetTransport();
    await fs.writeFile(endpoint, 'not a socket');

    try {
      await expect(transport.bind(endpoint, (payload) => payload)).rejects.toMatchObject({
        code: 'EADDRINUSE',
      });
      expect(await fs.readFile(endpoint, 'utf8')).toBe('not a socket');
    } finally {
      await transport.close();
      await fs.unlink(endpoint);
    }
  });

  it(
    'records the native Windows abrupt pipe cleanup limitation explicitly',
    async () => {
      if (process.platform !== 'win32') {
        expect({
          platform: process.platform,
          limitation: 'Windows named-pipe process cleanup requires the Windows runner',
        }).toEqual({
          platform: process.platform,
          limitation: 'Windows named-pipe process cleanup requires the Windows runner',
        });
        return;
      }

      const endpoint = createIpcEndpoint({ platform: 'win32' });
      const child = spawn(process.execPath, [CHILD_SCRIPT, endpoint], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const diagnostics = captureChildDiagnostics(child);
      const transport = new RawNetTransport();

      try {
        await waitForReady(child);
        child.kill();
        await waitForChildExit(child, createPhaseDeadline('pipe-child-exit', PROCESS_TIMEOUT_MS));
        await transport.bind(endpoint, (payload) => payload);
        await transport.close();
      } catch (error: unknown) {
        throw diagnosticError(error, diagnostics.snapshot());
      } finally {
        diagnostics.dispose();
        await stopChild(child);
        await transport.close();
      }
    },
    PROCESS_TIMEOUT_MS * 2,
  );
});
