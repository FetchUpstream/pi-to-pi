import { describe, expect, it } from 'vitest';

import { createManagedProcess } from './process.js';
import { testWorkspaceExists, withTestWorkspace } from './workspace.js';

describe('managed process workspace ownership', () => {
  it('terminates directly owned children before removing the workspace', async () => {
    let first!: ReturnType<typeof createManagedProcess>;
    let second!: ReturnType<typeof createManagedProcess>;
    let rootPath = '';

    await withTestWorkspace(async (workspace) => {
      rootPath = workspace.rootPath;
      first = createManagedProcess({ label: 'direct first', workspace });
      second = createManagedProcess({ label: 'direct second', workspace });
      await Promise.all([first.waitForReady(), second.waitForReady()]);
    });

    expect(first.state).toBe('closed');
    expect(second.state).toBe('closed');
    expect(await testWorkspaceExists(rootPath)).toBe(false);
  });
});
