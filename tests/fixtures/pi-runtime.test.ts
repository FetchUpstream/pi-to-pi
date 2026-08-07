import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { fauxAssistantMessage } from '@earendil-works/pi-ai';
import { SessionManager } from '@earendil-works/pi-coding-agent';

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

      await fixture.resume(originalFile!);
      expect(fixture.sessionId).toBe(originalId);
      expect(fixture.probe.latest('session_start')?.reason).toBe('resume');

      await fixture.fork(forkEntry!.id, { position: 'at' });
      expect(fixture.sessionId).not.toBe(originalId);
      expect(fixture.probe.latest('session_start')?.reason).toBe('fork');
      expect(fixture.probe.latest('session_start')?.previousSessionFile).toBe(originalFile);
    } finally {
      await fixture.dispose();
    }
  });
});
