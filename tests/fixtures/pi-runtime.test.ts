import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai';
import { ModelRuntime, SessionManager } from '@earendil-works/pi-coding-agent';

import {
  createPersistedPiSessionFixture,
  createPiRuntimeFixture,
  defaultFauxResponse,
} from './index.js';

async function temporaryRuntime() {
  const fixture = await createPersistedPiSessionFixture();
  return fixture;
}

describe('shared Pi runtime fixture', () => {
  it('binds the inline probe and runs a registered faux provider in process', async () => {
    const fixture = await temporaryRuntime();
    try {
      fixture.faux.setResponses([fauxAssistantMessage('fixture reply')]);
      const sessionId = fixture.sessionId;

      await fixture.session.sendCustomMessage(
        {
          customType: 'p2p.inbound',
          content: 'request body',
          display: false,
          details: { requestId: 'request-a' },
        },
        { triggerTurn: true },
      );

      expect(fixture.faux.state.callCount).toBe(1);
      expect(fixture.sessionId).toBe(sessionId);
      expect(fixture.probe.byType('session_start')).toHaveLength(1);
      expect(fixture.probe.byType('custom_message_start')[0]?.details).toEqual({
        requestId: 'request-a',
      });
      expect(fixture.probe.byType('custom_message_end')[0]?.details).toEqual({
        requestId: 'request-a',
      });
      expect(fixture.probe.latest('agent_end')?.idle).toBe(false);
      expect(fixture.probe.latest('agent_settled')?.idle).toBe(true);

      const customEntry = fixture.entries.find(
        (entry) => entry.type === 'custom_message' && entry.customType === 'p2p.inbound',
      );
      expect(
        customEntry && customEntry.type === 'custom_message' ? customEntry.details : undefined,
      ).toEqual({
        requestId: 'request-a',
      });
    } finally {
      await fixture.dispose();
    }
  });

  it('keeps persisted sessions isolated and supports reload and clone helpers', async () => {
    const fixture = await temporaryRuntime();
    let clone: Awaited<ReturnType<typeof fixture.cloneSession>> | undefined;
    try {
      fixture.faux.setResponses([defaultFauxResponse()]);
      fixture.session.setSessionName('named fixture');
      await fixture.session.sendCustomMessage(
        {
          customType: 'p2p.inbound',
          content: 'persisted body',
          display: false,
          details: { requestId: 'request-persisted' },
        },
        { triggerTurn: true },
      );

      const originalId = fixture.sessionId;
      const originalFile = fixture.sessionFile;
      expect(originalFile).toBeDefined();
      expect(originalFile && existsSync(originalFile)).toBe(true);

      await fixture.reloadSession();
      expect(fixture.sessionId).toBe(originalId);
      expect(fixture.sessionFile).toBe(originalFile);
      expect(fixture.probe.latest('session_start')?.sessionName).toBe('named fixture');
      expect(fixture.probe.latest('session_start')?.reason).toBe('reload');

      clone = await fixture.cloneSession();
      expect(clone.sessionFile).not.toBe(originalFile);
      expect(clone.sessionManager.getSessionId()).not.toBe(originalId);
      expect(clone.sessionManager.getEntries()).toHaveLength(fixture.entries.length);
    } finally {
      await clone?.cleanup();
      await fixture.dispose();
    }
  });

  it('supports an in-memory runtime without allocating a persisted session file', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'pi-p2p-memory-'));
    const cwd = join(rootDir, 'workspace');
    const agentDir = join(rootDir, 'agent');
    await mkdir(cwd, { recursive: true });
    await mkdir(agentDir, { recursive: true });
    const fixture = await createPiRuntimeFixture({
      cwd,
      agentDir,
      responses: [defaultFauxResponse('memory reply')],
      sessionManager: SessionManager.inMemory(cwd),
    });
    try {
      expect(fixture.sessionFile).toBeUndefined();
      await fixture.session.sendCustomMessage(
        {
          customType: 'p2p.inbound',
          content: 'memory body',
          display: false,
          details: { requestId: 'request-memory' },
        },
        { triggerTurn: true },
      );
      expect(fixture.faux.state.callCount).toBe(1);
    } finally {
      await fixture.dispose();
      await rm(rootDir, { recursive: true, force: true });
    }
  });
});

describe('persisted replacement helpers', () => {
  it('rebinds runtime sessions for new, resume, and fork', async () => {
    const fixture = await createPersistedPiSessionFixture();
    try {
      fixture.faux.setResponses([defaultFauxResponse('original reply')]);
      await fixture.session.sendCustomMessage(
        {
          customType: 'p2p.inbound',
          content: 'original body',
          display: false,
          details: { requestId: 'request-original' },
        },
        { triggerTurn: true },
      );
      const originalFile = fixture.sessionFile;
      const originalId = fixture.sessionId;
      const forkEntry = fixture.entries.find((entry) => entry.type === 'message');
      expect(originalFile).toBeDefined();
      expect(forkEntry).toBeDefined();

      await fixture.newSession();
      expect(fixture.sessionId).not.toBe(originalId);
      expect(fixture.probe.latest('session_start')?.reason).toBe('new');
      expect(fixture.probe.latest('session_start')?.previousSessionFile).toBe(originalFile);

      await fixture.resumeSession(originalFile!);
      expect(fixture.sessionId).toBe(originalId);
      expect(fixture.probe.latest('session_start')?.reason).toBe('resume');

      await fixture.forkSession(forkEntry!.id, { position: 'at' });
      expect(fixture.sessionId).not.toBe(originalId);
      expect(fixture.probe.latest('session_start')?.reason).toBe('fork');
      expect(fixture.probe.latest('session_start')?.previousSessionFile).toBe(originalFile);
    } finally {
      await fixture.dispose();
    }
  });
});

describe('fixture ownership and cleanup', () => {
  it('rejects an injected runtime that owns an unrelated faux provider', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'pi-p2p-runtime-conflict-'));
    const agentDir = join(rootDir, 'agent');
    await mkdir(agentDir, { recursive: true });
    const providerId = 'pi-p2p-review-conflict-provider';
    const modelId = 'pi-p2p-review-conflict-model';
    const modelRuntime = await ModelRuntime.create({
      authPath: join(agentDir, 'auth.json'),
      modelsPath: null,
      allowModelNetwork: false,
      refreshOnCreate: false,
    });
    const unrelated = fauxProvider({
      provider: providerId,
      models: [{ id: modelId }],
    });
    modelRuntime.registerNativeProvider(unrelated.provider);

    try {
      await expect(
        createPiRuntimeFixture({
          cwd: join(rootDir, 'workspace'),
          agentDir,
          providerId,
          modelId,
          modelRuntime,
        }),
      ).rejects.toThrow(/another provider|existing model runtime provider/u);
      expect(modelRuntime.getRegisteredNativeProvider(providerId)).toBe(unrelated.provider);
    } finally {
      modelRuntime.unregisterProvider(providerId);
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it('preserves a caller-owned clone root during cleanup', async () => {
    const fixture = await temporaryRuntime();
    fixture.faux.setResponses([defaultFauxResponse('clone source')]);
    await fixture.session.sendCustomMessage(
      {
        customType: 'p2p.clone-source',
        content: 'clone source',
        display: false,
      },
      { triggerTurn: true },
    );
    const callerRoot = await mkdtemp(join(tmpdir(), 'pi-p2p-caller-root-'));
    let clone: Awaited<ReturnType<typeof fixture.cloneSession>> | undefined;
    try {
      clone = await fixture.cloneSession({ rootDir: callerRoot });
      await clone.cleanup();
      expect(existsSync(callerRoot)).toBe(true);
    } finally {
      await clone?.cleanup();
      await fixture.dispose();
      await rm(callerRoot, { recursive: true, force: true });
    }
  });

  it('removes owned roots before retrying a failed runtime dispose', async () => {
    const fixture = await temporaryRuntime();
    const rootDir = fixture.rootDir;
    const originalDispose = fixture.runtime.dispose.bind(fixture.runtime);
    let attempts = 0;
    fixture.runtime.dispose = async () => {
      attempts += 1;
      if (attempts === 1) {
        throw new Error('simulated runtime dispose failure');
      }
      await originalDispose();
    };

    try {
      await expect(fixture.dispose()).rejects.toThrow('simulated runtime dispose failure');
      expect(existsSync(rootDir)).toBe(false);
      await fixture.dispose();
      expect(attempts).toBe(2);
    } finally {
      await fixture.dispose().catch(() => undefined);
    }
  });

  it('derives injected session paths and rejects conflicting overrides', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'pi-p2p-session-paths-'));
    const managerCwd = join(rootDir, 'manager-workspace');
    const managerSessionDir = join(rootDir, 'manager-sessions');
    const sessionManager = SessionManager.create(managerCwd, managerSessionDir);
    const fixtureRoot = join(rootDir, 'fixture-root');
    let fixture: Awaited<ReturnType<typeof createPersistedPiSessionFixture>> | undefined;

    try {
      fixture = await createPersistedPiSessionFixture({
        rootDir: fixtureRoot,
        sessionManager,
      });
      expect(fixture.cwd).toBe(sessionManager.getCwd());
      expect(fixture.sessionDir).toBe(sessionManager.getSessionDir());

      const conflictingRoot = join(rootDir, 'conflicting-root');
      await expect(
        createPersistedPiSessionFixture({
          rootDir: conflictingRoot,
          cwd: join(rootDir, 'other-workspace'),
          sessionManager,
        }),
      ).rejects.toThrow(/conflicts with fixture cwd/u);
      expect(existsSync(conflictingRoot)).toBe(false);
    } finally {
      await fixture?.dispose();
      await rm(rootDir, { recursive: true, force: true });
    }
  });
});
