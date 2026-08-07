import { stat } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

import { createTestWorkspace, testWorkspaceExists, withTestWorkspace } from './workspace.js';

describe('test workspace support', () => {
  it('creates unique runtime and room paths without changing process state', async () => {
    const previousRuntimePath = process.env.TEST_RUNTIME_PATH;
    const first = await createTestWorkspace();
    const second = await createTestWorkspace();

    try {
      expect(first.rootPath).not.toBe(second.rootPath);
      expect(first.runtimePath).not.toBe(second.runtimePath);
      expect(first.roomPath).not.toBe(second.roomPath);
      expect((await stat(first.runtimePath)).isDirectory()).toBe(true);
      expect((await stat(first.roomPath)).isDirectory()).toBe(true);
      expect(first.env.TEST_RUNTIME_PATH).toBe(first.runtimePath);
      expect(process.env.TEST_RUNTIME_PATH).toBe(previousRuntimePath);
    } finally {
      await Promise.all([first.cleanup(), second.cleanup()]);
    }

    expect(await testWorkspaceExists(first.rootPath)).toBe(false);
    expect(await testWorkspaceExists(second.rootPath)).toBe(false);
  });

  it('keeps callback failures when cleanup also runs', async () => {
    const failure = new Error('callback failed');

    await expect(
      withTestWorkspace(async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
  });
  it('awaits owner cleanup hooks before removing the workspace', async () => {
    let workspaceExistedDuringCleanup = false;

    await withTestWorkspace(async (workspace) => {
      workspace.registerBeforeCleanup(async () => {
        workspaceExistedDuringCleanup = await testWorkspaceExists(workspace.rootPath);
      });
    });

    expect(workspaceExistedDuringCleanup).toBe(true);
  });

  it('preserves callback and cleanup failures together', async () => {
    const callbackFailure = new Error('callback failed');
    const cleanupFailure = new Error('child termination failed');

    const result = withTestWorkspace(async (workspace) => {
      workspace.registerBeforeCleanup(() => {
        throw cleanupFailure;
      });
      throw callbackFailure;
    });

    await expect(result).rejects.toSatisfy((error: unknown) => {
      return (
        error instanceof AggregateError &&
        error.errors[0] === callbackFailure &&
        error.errors[1] === cleanupFailure
      );
    });
  });
});
