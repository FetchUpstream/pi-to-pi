import { describe, expect, it } from 'vitest';

import {
  createManagedProcess,
  createManagedProcessGroup,
  LIFECYCLE_FIXTURE_PATH,
  ManagedProcessClosedError,
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

        await expect(
          managed.waitForEvent((event) => event.event === 'never', {
            description: 'a deliberately absent event',
            timeoutMs: 100,
          }),
        ).rejects.toBeInstanceOf(ManagedProcessTimeoutError);

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
});
