import { describe, expect, it } from 'vitest';

import {
  createManagedProcess,
  LIFECYCLE_FIXTURE_PATH,
  ManagedProcessTimeoutError,
} from '../support/process.js';
import { waitForPredicate } from '../support/wait.js';
import { testWorkspaceExists, withTestWorkspace } from '../support/workspace.js';

type LifecycleEvent = {
  readonly event?: string;
  readonly [key: string]: unknown;
};

const waitForOutput = async (
  process: ReturnType<typeof createManagedProcess<LifecycleEvent>>,
  stream: 'stdout' | 'stderr',
  text: string,
): Promise<void> => {
  await waitForPredicate(() => (process.output[stream].includes(text) ? true : undefined), {
    description: `${stream} output`,
    pollIntervalMs: 5,
    timeoutMs: 1_000,
  });
};

describe('process harness acceptance', () => {
  it('4.1 starts two fixtures concurrently and observes clean exits', async () => {
    let rootPath = '';

    await withTestWorkspace(async (workspace) => {
      rootPath = workspace.rootPath;
      const first = createManagedProcess<LifecycleEvent>({
        label: 'smoke-first',
        workspace,
      });
      const second = createManagedProcess<LifecycleEvent>({
        label: 'smoke-second',
        workspace,
      });

      try {
        const [firstReady, secondReady] = await Promise.all([
          first.waitForReady({ description: 'the first fixture ready event' }),
          second.waitForReady({ description: 'the second fixture ready event' }),
        ]);

        expect(firstReady).toMatchObject({ event: 'ready', type: 'ready' });
        expect(secondReady).toMatchObject({ event: 'ready', type: 'ready' });
        expect(firstReady.pid).toEqual(first.pid);
        expect(secondReady.pid).toEqual(second.pid);
        expect(first.pid).not.toBe(second.pid);

        await Promise.all([
          first.sendCommand({ command: 'shutdown' }),
          second.sendCommand({ command: 'shutdown' }),
        ]);
        const [firstExit, secondExit] = await Promise.all([
          first.waitForClose({ description: 'the first fixture close' }),
          second.waitForClose({ description: 'the second fixture close' }),
        ]);

        expect(firstExit).toMatchObject({ code: 0, exitCode: 0, signal: null });
        expect(secondExit).toMatchObject({ code: 0, exitCode: 0, signal: null });
        expect(first.state).toBe('closed');
        expect(second.state).toBe('closed');
      } finally {
        await Promise.all([first.cleanup(), second.cleanup()]);
      }
    });

    expect(await testWorkspaceExists(rootPath)).toBe(false);
  });

  it('4.2 bounds a hung fixture timeout with diagnostics and cleanup', async () => {
    let rootPath = '';

    await withTestWorkspace(async (workspace) => {
      rootPath = workspace.rootPath;
      const managed = createManagedProcess<LifecycleEvent>({
        args: ['--crlf'],
        label: 'hung fixture',
        workspace,
      });

      try {
        await managed.waitForReady();
        await managed.sendCommand({
          command: 'diagnostic',
          message: 'hung fixture stderr diagnostic',
          stream: 'stderr',
        });
        await waitForOutput(managed, 'stderr', 'hung fixture stderr diagnostic');
        await managed.sendCommand({ command: 'hang' });
        await managed.waitForEvent((event) => event.event === 'hanging');

        const startedAt = Date.now();
        const timeoutWait = managed.waitForEvent((event) => event.event === 'never', {
          description: 'the deliberately absent hung-fixture event',
          timeoutMs: 200,
        });
        await expect(timeoutWait).rejects.toBeInstanceOf(ManagedProcessTimeoutError);
        const timeoutError = await timeoutWait.catch((error: unknown) => error);
        const elapsedMs = Date.now() - startedAt;

        expect(timeoutError).toBeInstanceOf(ManagedProcessTimeoutError);
        const error = timeoutError as ManagedProcessTimeoutError;
        expect(error.code).toBe('ERR_MANAGED_PROCESS_TIMEOUT');
        expect(error.timeoutMs).toBe(200);
        expect(error.identity).toMatchObject({ label: 'hung fixture' });
        expect(error.diagnostics.state).not.toBe('closed');
        expect(error.diagnostics.output?.stdout).toContain('hanging');
        expect(error.diagnostics.output?.stderr).toContain('hung fixture stderr diagnostic');
        expect(error.message).toContain('the deliberately absent hung-fixture event');
        expect(error.message).toContain('hung fixture');
        expect(elapsedMs).toBeLessThan(5_000);

        const terminated = await managed.waitForClose({ timeoutMs: 1_000 });
        expect(managed.state).toBe('closed');
        expect(terminated.code !== 0 || terminated.signal !== null).toBe(true);
      } finally {
        await managed.cleanup();
      }
    });

    expect(await testWorkspaceExists(rootPath)).toBe(false);
  });

  it('4.3 forcefully terminates a running fixture portably and tolerates repeated teardown', async () => {
    let rootPath = '';

    await withTestWorkspace(async (workspace) => {
      rootPath = workspace.rootPath;
      const managed = createManagedProcess<LifecycleEvent>({
        label: 'abrupt fixture',
        workspace,
      });

      try {
        await managed.waitForReady();
        await managed.sendCommand({ command: 'hang' });
        await managed.waitForEvent((event) => event.event === 'hanging');

        const firstTermination = await managed.killAbruptly({ timeoutMs: 2_000 });
        expect(managed.state).toBe('closed');
        expect(firstTermination.identity).toMatchObject({ label: 'abrupt fixture' });
        expect(firstTermination.code !== 0 || firstTermination.signal !== null).toBe(true);

        if (process.platform === 'win32') {
          expect(firstTermination.signal).toBeNull();
        } else {
          expect(firstTermination.signal).toBe('SIGKILL');
          expect(firstTermination.code).toBeNull();
        }

        const repeatedTermination = await managed.killAbruptly({ timeoutMs: 2_000 });
        expect(repeatedTermination).toMatchObject({
          code: firstTermination.code,
          signal: firstTermination.signal,
          state: 'closed',
        });
        await managed.cleanup();
        await managed.cleanup();
      } finally {
        await managed.cleanup();
      }
    });

    expect(await testWorkspaceExists(rootPath)).toBe(false);
  });

  it('4.4 proves isolated workspaces, CRLF parsing, stream separation, and direct fixture launch', async () => {
    const previousWorkspacePath = process.env.TEST_WORKSPACE_PATH;
    let firstRootPath = '';
    let secondRootPath = '';

    await withTestWorkspace(async (firstWorkspace) => {
      firstRootPath = firstWorkspace.rootPath;

      await withTestWorkspace(async (secondWorkspace) => {
        secondRootPath = secondWorkspace.rootPath;
        expect(firstWorkspace.rootPath).not.toBe(secondWorkspace.rootPath);
        expect(firstWorkspace.runtimePath).not.toBe(secondWorkspace.runtimePath);
        expect(firstWorkspace.roomPath).not.toBe(secondWorkspace.roomPath);
        expect(firstWorkspace.runtimeId).not.toBe(secondWorkspace.runtimeId);
        expect(firstWorkspace.roomId).not.toBe(secondWorkspace.roomId);
        expect(process.env.TEST_WORKSPACE_PATH).toBe(previousWorkspacePath);

        const first = createManagedProcess<LifecycleEvent>({
          args: ['--crlf'],
          label: 'isolated-first',
          workspace: firstWorkspace,
        });
        const second = createManagedProcess<LifecycleEvent>({
          args: ['--crlf'],
          label: 'isolated-second',
          workspace: secondWorkspace,
        });

        try {
          expect(first.fixturePath).toBe(LIFECYCLE_FIXTURE_PATH);
          expect(second.fixturePath).toBe(LIFECYCLE_FIXTURE_PATH);
          expect(first.child.spawnfile).toBe(process.execPath);
          expect(second.child.spawnfile).toBe(process.execPath);
          expect(first.child.spawnargs.slice(0, 2)).toEqual([
            process.execPath,
            LIFECYCLE_FIXTURE_PATH,
          ]);
          expect(second.child.spawnargs.slice(0, 2)).toEqual([
            process.execPath,
            LIFECYCLE_FIXTURE_PATH,
          ]);

          const [firstReady, secondReady] = await Promise.all([
            first.waitForReady({ description: 'the first CRLF fixture ready event' }),
            second.waitForReady({ description: 'the second CRLF fixture ready event' }),
          ]);
          expect(firstReady).toMatchObject({ event: 'ready', type: 'ready' });
          expect(secondReady).toMatchObject({ event: 'ready', type: 'ready' });
          expect(firstReady.pid).not.toBe(secondReady.pid);
          expect(first.output.stdout).toContain('\r\n');
          expect(second.output.stdout).toContain('\r\n');

          await first.sendCommand({
            command: 'diagnostic',
            message: 'isolated first stdout',
            stream: 'stdout',
          });
          await first.sendCommand({
            command: 'diagnostic',
            message: 'isolated first stderr',
            stream: 'stderr',
          });
          await second.sendCommand({
            command: 'diagnostic',
            message: 'isolated second stdout',
            stream: 'stdout',
          });
          await second.sendCommand({
            command: 'diagnostic',
            message: 'isolated second stderr',
            stream: 'stderr',
          });

          await Promise.all([
            first.waitForEvent(
              (event) =>
                event.event === 'log' &&
                event.stream === 'stdout' &&
                event.message === 'isolated first stdout',
            ),
            second.waitForEvent(
              (event) =>
                event.event === 'log' &&
                event.stream === 'stdout' &&
                event.message === 'isolated second stdout',
            ),
            waitForOutput(first, 'stderr', 'isolated first stderr'),
            waitForOutput(second, 'stderr', 'isolated second stderr'),
          ]);

          expect(first.output.stdout).toContain('isolated first stdout');
          expect(first.output.stderr).toContain('isolated first stderr');
          expect(first.output.stdout).not.toContain('isolated first stderr');
          expect(first.output.stderr).not.toContain('isolated first stdout');
          expect(second.output.stdout).toContain('isolated second stdout');
          expect(second.output.stderr).toContain('isolated second stderr');
          expect(second.output.stdout).not.toContain('isolated second stderr');
          expect(second.output.stderr).not.toContain('isolated second stdout');

          const diagnostics = first.formatDiagnostics('concurrent CRLF fixture');
          expect(diagnostics).toContain('isolated-first');
          expect(diagnostics).toContain('isolated first stdout');
          expect(diagnostics).toContain('isolated first stderr');

          await Promise.all([
            first.sendCommand({ command: 'shutdown' }),
            second.sendCommand({ command: 'shutdown' }),
          ]);
          await Promise.all([first.waitForClose(), second.waitForClose()]);
        } finally {
          await Promise.all([first.cleanup(), second.cleanup()]);
        }
      });
    });

    expect(await testWorkspaceExists(firstRootPath)).toBe(false);
    expect(await testWorkspaceExists(secondRootPath)).toBe(false);
  });
});
