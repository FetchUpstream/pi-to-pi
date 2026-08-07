import { describe, expect, it, vi } from 'vitest';

import {
  createManagedProcess,
  createManagedProcessGroup,
  LIFECYCLE_FIXTURE_PATH,
  ManagedProcessClosedError,
  ManagedProcessCommandTimeoutError,
  ManagedProcessTimeoutError,
} from './process.js';
import { testWorkspaceExists, withTestWorkspace } from './workspace.js';

describe('managed process support', () => {
  it('starts a fixture, exchanges JSON-lines commands, and observes close diagnostics', async () => {
    await withTestWorkspace(async (workspace) => {
      const managed = createManagedProcess({
        label: 'diagnostic fixture',
        workspace,
      });
      try {
        const ready = await managed.waitForReady();
        expect(ready).toMatchObject({ event: 'ready', type: 'ready' });
        expect(managed.pid).toEqual(expect.any(Number));
        expect(managed.fixturePath).toBe(LIFECYCLE_FIXTURE_PATH);

        await managed.sendCommand({
          command: 'diagnostic',
          message: 'stdout diagnostic',
          stream: 'stdout',
        });
        await managed.sendCommand({
          command: 'diagnostic',
          message: 'stderr diagnostic',
          stream: 'stderr',
        });
        await managed.waitForEvent(
          (event) =>
            event.event === 'log' &&
            event.stream === 'stdout' &&
            event.message === 'stdout diagnostic',
        );
        await managed.sendCommand({ command: 'shutdown' });

        const result = await managed.waitForClose();
        expect(result).toMatchObject({ code: 0, exitCode: 0, signal: null });
        expect(result.stdout).toContain('stdout diagnostic');
        expect(result.stderr).toContain('stderr diagnostic');
        expect(managed.formatDiagnostics('clean fixture')).toContain('diagnostic fixture');
        expect(managed.stdout.listenerCount('data')).toBe(0);
        expect(managed.stderr.listenerCount('data')).toBe(0);
        expect(managed.stdin.listenerCount('error')).toBe(0);
      } finally {
        await managed.cleanup();
      }
    });
  });

  it('parses CRLF readiness and terminates a hung fixture on timeout', async () => {
    await withTestWorkspace(async (workspace) => {
      const managed = createManagedProcess({ args: ['--crlf'], workspace });
      try {
        await managed.waitForReady();
        await managed.sendCommand({ command: 'hang' });
        await managed.waitForEvent((event) => event.event === 'hanging');

        const timeoutResult = managed.waitForEvent((event) => event.event === 'never', {
          description: 'a deliberately absent event',
          timeoutMs: 100,
        });
        await expect(timeoutResult).rejects.toBeInstanceOf(ManagedProcessTimeoutError);
        try {
          await timeoutResult;
        } catch (error) {
          expect(error).toBeInstanceOf(ManagedProcessTimeoutError);
          expect((error as ManagedProcessTimeoutError).diagnostics.output?.stdout).toContain(
            'hanging',
          );
          expect((error as ManagedProcessTimeoutError).diagnostics.state).not.toBe('closed');
        }

        const result = await managed.waitForClose();
        expect(result.code !== 0 || result.signal !== null).toBe(true);
      } finally {
        await managed.cleanup();
      }
    });
  });

  it('terminates every child in a workspace-owned group and makes repeated teardown safe', async () => {
    await withTestWorkspace(async (workspace) => {
      const group = createManagedProcessGroup({ workspace });
      const first = group.spawn({ label: 'first fixture' });
      const second = group.spawn({ label: 'second fixture' });
      try {
        await Promise.all([first.waitForReady(), second.waitForReady()]);
        await Promise.all([
          first.sendCommand({ command: 'shutdown' }),
          second.sendCommand({ command: 'shutdown' }),
        ]);
        await Promise.all([first.waitForClose(), second.waitForClose()]);
      } finally {
        await group.teardown();
        await group.teardown();
      }
      expect(await testWorkspaceExists(workspace.rootPath)).toBe(true);
    });
  });

  it('reports startup failures with identity and bounded diagnostics', async () => {
    await withTestWorkspace(async (workspace) => {
      const managed = createManagedProcess({
        fixturePath: `${workspace.rootPath}/missing-fixture.mjs`,
        label: 'missing fixture',
        workspace,
      });
      try {
        await expect(managed.waitForReady({ timeoutMs: 1_000 })).rejects.toBeInstanceOf(
          ManagedProcessClosedError,
        );
      } finally {
        await managed.cleanup();
      }
    });
  });

  it('rejects commands after closure with process diagnostics', async () => {
    await withTestWorkspace(async (workspace) => {
      const managed = createManagedProcess({ workspace });
      try {
        await managed.waitForReady();
        await managed.sendCommand({ command: 'shutdown' });
        await managed.waitForClose();
        await expect(managed.sendCommand({ command: 'shutdown' })).rejects.toBeInstanceOf(
          ManagedProcessClosedError,
        );
      } finally {
        await managed.cleanup();
      }
    });
  });
  it('bounds command size before writing to fixture stdin', async () => {
    await withTestWorkspace(async (workspace) => {
      const managed = createManagedProcess({
        maxCommandBytes: 32,
        workspace,
      });
      try {
        await managed.waitForReady();
        await expect(
          managed.sendCommand({ command: 'diagnostic', message: 'x'.repeat(100) }),
        ).rejects.toThrow(/exceeds 32 UTF-8 bytes/);
      } finally {
        await managed.cleanup();
      }
    });
  });

  it('times out a command write and removes its pending listeners', async () => {
    await withTestWorkspace(async (workspace) => {
      const managed = createManagedProcess({
        commandTimeoutMs: 25,
        workspace,
      });
      const write = vi.spyOn(managed.stdin, 'write').mockImplementation(() => true);
      try {
        await managed.waitForReady();
        await expect(managed.sendCommand({ command: 'hang' })).rejects.toBeInstanceOf(
          ManagedProcessCommandTimeoutError,
        );
      } finally {
        write.mockRestore();
        await managed.cleanup();
      }
    });
  });

  it('rejects process additions after group teardown and cleans the late child', async () => {
    const group = createManagedProcessGroup();
    await group.teardown();
    expect(() => group.spawn()).toThrow(/after group teardown started/);

    const late = createManagedProcess();
    expect(() => group.add(late)).toThrow(/after managed process group teardown started/);
    await late.cleanup();
    expect(late.state).toBe('closed');
  });
});
