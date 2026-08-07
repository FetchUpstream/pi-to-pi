import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { fauxAssistantMessage, type FauxResponseFactory } from '@earendil-works/pi-ai';
import { SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';
import { describe, expect, it } from 'vitest';

import {
  createPersistedPiSessionFixture,
  createPiProbe,
  defaultFauxResponse,
} from '../fixtures/index.js';
import type { PiProbe, PiProbeSessionManager } from '../fixtures/pi-probe.js';

interface ResourceObservation {
  kind: 'factory' | 'start' | 'shutdown';
  sessionId?: string;
  activeSessionIds: string[];
}

interface ResourceTracker {
  readonly observations: ResourceObservation[];
  activeSessionIds(): string[];
  activeSessionManagers(): PiProbeSessionManager[];
  clear(): void;
  forceCleanup(): void;
}

function installResourceTracker(probe: PiProbe): ResourceTracker {
  const extension = probe.extension;
  if (typeof extension === 'function') {
    throw new Error('The shared probe must expose an inline extension object');
  }

  const active = new Map<PiProbeSessionManager, ReturnType<typeof setInterval>>();
  const observations: ResourceObservation[] = [];
  const snapshot = (): string[] =>
    [...active.keys()].map((sessionManager) => sessionManager.getSessionId());
  const activeSessionManagers = (): PiProbeSessionManager[] => [...active.keys()];
  const record = (observation: Omit<ResourceObservation, 'activeSessionIds'>): void => {
    observations.push({ ...observation, activeSessionIds: snapshot() });
  };
  const baseFactory = extension.factory;
  const installHandlers = (pi: Parameters<typeof baseFactory>[0]): void => {
    pi.on('session_start', (_event, ctx) => {
      const sessionManager = ctx.sessionManager;
      const sessionId = sessionManager.getSessionId();
      const resource = setInterval(() => undefined, 1_000_000);
      resource.unref();
      active.set(sessionManager, resource);
      record({ kind: 'start', sessionId });
    });

    pi.on('session_shutdown', (_event, ctx) => {
      const sessionManager = ctx.sessionManager;
      const sessionId = sessionManager.getSessionId();
      const resource = active.get(sessionManager);
      if (resource) {
        clearInterval(resource);
        active.delete(sessionManager);
      }
      record({ kind: 'shutdown', sessionId });
    });
  };

  extension.factory = (pi) => {
    record({ kind: 'factory' });
    const result = baseFactory(pi);
    if (result instanceof Promise) {
      return result.then(() => installHandlers(pi));
    }
    installHandlers(pi);
  };

  return {
    observations,
    activeSessionIds: snapshot,
    activeSessionManagers,
    clear() {
      observations.length = 0;
    },
    forceCleanup() {
      for (const resource of active.values()) {
        clearInterval(resource);
      }
      active.clear();
    },
  };
}

function observationTypes(probe: PiProbe): string[] {
  return probe.observations.map((observation) => observation.type);
}

function expectReplacement(
  probe: PiProbe,
  options: {
    reason: 'new' | 'resume' | 'fork';
    previousSessionId: string;
    previousSessionFile: string;
    previousSessionName: string | undefined;
    targetSessionFile: string;
    targetSessionId: string;
    targetSessionName: string | undefined;
  },
): void {
  expect(observationTypes(probe)).toEqual([
    'session_shutdown',
    'extension_factory',
    'session_start',
  ]);

  const shutdown = probe.observations[0];
  const start = probe.observations[2];
  expect(shutdown?.type).toBe('session_shutdown');
  expect(shutdown?.reason).toBe(options.reason);
  expect(shutdown?.sessionId).toBe(options.previousSessionId);
  expect(shutdown?.sessionFile).toBe(options.previousSessionFile);
  expect(shutdown?.sessionName).toBe(options.previousSessionName);
  expect(shutdown?.targetSessionFile).toBe(options.targetSessionFile);

  expect(start?.type).toBe('session_start');
  expect(start?.reason).toBe(options.reason);
  expect(start?.sessionId).toBe(options.targetSessionId);
  expect(start?.sessionFile).toBe(options.targetSessionFile);
  expect(start?.sessionName).toBe(options.targetSessionName);
  expect(start?.previousSessionFile).toBe(options.previousSessionFile);
  expect(start?.hasPendingMessages).toBe(false);
  expect(start?.idle).toBe(true);
}

function expectResourceReplacement(
  resources: ResourceTracker,
  previousSessionManager: PiProbeSessionManager,
  targetSessionManager: PiProbeSessionManager,
): void {
  expect(targetSessionManager).not.toBe(previousSessionManager);
  expect(resources.observations).toEqual([
    {
      kind: 'shutdown',
      sessionId: previousSessionManager.getSessionId(),
      activeSessionIds: [],
    },
    { kind: 'factory', activeSessionIds: [] },
    {
      kind: 'start',
      sessionId: targetSessionManager.getSessionId(),
      activeSessionIds: [targetSessionManager.getSessionId()],
    },
  ]);
  expect(resources.activeSessionManagers()).toEqual([targetSessionManager]);
  expect(resources.activeSessionIds()).toEqual([targetSessionManager.getSessionId()]);
}

describe('Pi session lifecycle contract (tasks 2.1-2.4)', () => {
  it('loads side-effect free and owns resources from session start through shutdown', async () => {
    const probe = createPiProbe();
    const resources = installResourceTracker(probe);
    const fixture = await createPersistedPiSessionFixture({ probe });
    const sessionId = fixture.sessionId;
    const sessionFile = fixture.sessionFile;

    try {
      expect(sessionFile).toBeDefined();
      expect(probe.boundSessionManager).toBe(fixture.sessionManager);
      expect(observationTypes(probe)).toEqual(['extension_factory', 'session_start']);
      expect(resources.observations).toEqual([
        { kind: 'factory', activeSessionIds: [] },
        { kind: 'start', sessionId, activeSessionIds: [sessionId] },
      ]);
      expect(resources.activeSessionIds()).toEqual([sessionId]);
      expect(resources.activeSessionManagers()).toEqual([fixture.sessionManager]);

      probe.clear();
      resources.clear();
      await fixture.reloadSession();

      expect(observationTypes(probe)).toEqual([
        'session_shutdown',
        'extension_factory',
        'session_start',
      ]);
      expect(probe.observations[0]?.reason).toBe('reload');
      expect(probe.observations[0]?.sessionId).toBe(sessionId);
      expect(probe.observations[0]?.sessionFile).toBe(sessionFile);
      expect(probe.observations[0]?.targetSessionFile).toBeUndefined();
      expect(probe.observations[2]?.reason).toBe('reload');
      expect(probe.observations[2]?.sessionId).toBe(sessionId);
      expect(probe.observations[2]?.sessionFile).toBe(sessionFile);
      expect(probe.observations[2]?.previousSessionFile).toBeUndefined();
      expect(resources.observations).toEqual([
        { kind: 'shutdown', sessionId, activeSessionIds: [] },
        { kind: 'factory', activeSessionIds: [] },
        { kind: 'start', sessionId, activeSessionIds: [sessionId] },
      ]);
      expect(resources.activeSessionIds()).toEqual([sessionId]);
      expect(resources.activeSessionManagers()).toEqual([fixture.sessionManager]);

      probe.clear();
      await fixture.dispose();
      expect(observationTypes(probe)).toEqual(['session_shutdown']);
      expect(probe.latest('session_shutdown')?.reason).toBe('quit');
      expect(probe.latest('session_shutdown')?.sessionId).toBe(sessionId);
      expect(probe.latest('session_shutdown')?.sessionFile).toBe(sessionFile);
      expect(resources.activeSessionIds()).toEqual([]);
      expect(resources.activeSessionManagers()).toEqual([]);
      expect(resources.observations.at(-1)).toEqual({
        kind: 'shutdown',
        sessionId,
        activeSessionIds: [],
      });
    } finally {
      await fixture.dispose().catch(() => undefined);
      resources.forceCleanup();
    }
  });

  it('keeps a request unresolved at agent_end until a retry settles', async () => {
    const settingsManager = SettingsManager.inMemory({
      compaction: { enabled: false },
      retry: { enabled: true, maxRetries: 1, baseDelayMs: 0 },
      defaultThinkingLevel: 'off',
    });
    const fixture = await createPersistedPiSessionFixture({ settingsManager });
    const requestId = 'retry-request';
    const requestStates = new Map<string, 'accepted' | 'completed'>([[requestId, 'accepted']]);
    try {
      fixture.probe.clear();
      fixture.faux.setResponses([
        fauxAssistantMessage('transient failure', {
          stopReason: 'error',
          errorMessage: 'overloaded',
        }),
        fauxAssistantMessage('retry success'),
      ]);

      await fixture.session.sendCustomMessage(
        {
          customType: 'p2p.retry-probe',
          content: 'request body',
          display: false,
          details: { requestId },
        },
        { triggerTurn: true },
      );

      expect(observationTypes(fixture.probe)).toEqual([
        'agent_start',
        'custom_message_start',
        'custom_message_end',
        'agent_end',
        'agent_start',
        'agent_end',
        'agent_settled',
      ]);
      const lifecycle = fixture.probe.observations.filter(
        ({ type }) => type === 'agent_start' || type === 'agent_end' || type === 'agent_settled',
      );
      expect(lifecycle.map(({ type }) => type)).toEqual([
        'agent_start',
        'agent_end',
        'agent_start',
        'agent_end',
        'agent_settled',
      ]);

      const firstEnd = lifecycle[1];
      const secondEnd = lifecycle[3];
      const settled = lifecycle[4];
      expect(firstEnd?.idle).toBe(false);
      expect(secondEnd?.idle).toBe(false);
      expect(settled?.idle).toBe(true);
      expect(firstEnd?.sequence).toBeLessThan(settled?.sequence ?? -1);
      expect(secondEnd?.sequence).toBeLessThan(settled?.sequence ?? -1);

      for (const observation of lifecycle) {
        if (observation.type === 'agent_end') {
          expect(requestStates.get(requestId)).toBe('accepted');
        }
        if (observation.type === 'agent_settled') {
          expect(requestStates.get(requestId)).toBe('accepted');
          requestStates.set(requestId, 'completed');
        }
      }
      expect(requestStates.get(requestId)).toBe('completed');
    } finally {
      await fixture.dispose();
    }
  });

  it('does not migrate actual queued messages into a replacement session', async () => {
    const abortResponse: FauxResponseFactory = (_context, options) =>
      new Promise((resolve) => {
        const finish = () => resolve(fauxAssistantMessage('aborted', { stopReason: 'aborted' }));
        if (options?.signal?.aborted) {
          finish();
        } else {
          options?.signal?.addEventListener('abort', finish, { once: true });
        }
      });
    const fixture = await createPersistedPiSessionFixture({ responses: [abortResponse] });
    let prompt: Promise<void> | undefined;

    try {
      prompt = fixture.session.prompt('active prompt');
      for (let attempt = 0; attempt < 100 && !fixture.session.isStreaming; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
      expect(fixture.session.isStreaming).toBe(true);
      await fixture.session.sendCustomMessage(
        {
          customType: 'p2p.queued-probe',
          content: 'queued steering request',
          display: false,
          details: { requestId: 'queued-steer' },
        },
        { deliverAs: 'steer' },
      );
      await fixture.session.sendCustomMessage(
        {
          customType: 'p2p.queued-probe',
          content: 'queued follow-up request',
          display: false,
          details: { requestId: 'queued-follow-up' },
        },
        { deliverAs: 'followUp' },
      );
      expect(fixture.session.agent.hasQueuedMessages()).toBe(true);
      expect(fixture.probe.byType('custom_message_start')).toHaveLength(0);

      const previousSessionManager = fixture.sessionManager;
      const previousSessionFile = fixture.sessionFile;
      await fixture.newSession();
      const shutdown = fixture.probe.latest('session_shutdown');
      const start = fixture.probe.latest('session_start');
      expect(shutdown?.reason).toBe('new');
      expect(start?.reason).toBe('new');
      expect(start?.previousSessionFile).toBe(previousSessionFile);
      expect(fixture.sessionManager).not.toBe(previousSessionManager);
      expect(fixture.session.agent.hasQueuedMessages()).toBe(false);
      const outgoingCustomEntries = previousSessionManager
        .getEntries()
        .filter((entry) => entry.type === 'custom_message');
      expect(outgoingCustomEntries).toHaveLength(2);
      expect(outgoingCustomEntries.map((entry) => entry.details)).toEqual([
        { requestId: 'queued-steer' },
        { requestId: 'queued-follow-up' },
      ]);
      expect(
        fixture.session.state.messages.filter((message) => message.role === 'custom'),
      ).toHaveLength(0);
      expect(fixture.entries.filter((entry) => entry.type === 'custom_message')).toHaveLength(0);

      const replacementSequence = start?.sequence ?? Number.MAX_SAFE_INTEGER;
      expect(
        fixture.probe
          .byType('custom_message_start')
          .filter((observation) => observation.sequence > replacementSequence),
      ).toHaveLength(0);
    } finally {
      await prompt?.catch(() => undefined);
      await fixture.dispose();
    }
  });

  it('orders reload and new/resume/fork/clone replacement with exact session fields', async () => {
    const probe = createPiProbe();
    const resources = installResourceTracker(probe);
    const fixture = await createPersistedPiSessionFixture({ probe });

    try {
      fixture.session.setSessionName('source session');
      fixture.faux.setResponses([defaultFauxResponse('seed response')]);
      await fixture.session.prompt('seed prompt');
      const sourceSessionId = fixture.sessionId;
      const sourceSessionFile = fixture.sessionFile;
      const sourceSessionManager = fixture.sessionManager;
      expect(probe.boundSessionManager).toBe(sourceSessionManager);
      expect(resources.activeSessionManagers()).toEqual([sourceSessionManager]);
      const userEntry = fixture.entries.find(
        (entry) => entry.type === 'message' && entry.message.role === 'user',
      );
      expect(sourceSessionFile).toBeDefined();
      expect(userEntry).toBeDefined();

      fixture.probe.clear();
      resources.clear();
      await fixture.reloadSession();
      expect(observationTypes(fixture.probe)).toEqual([
        'session_shutdown',
        'extension_factory',
        'session_start',
      ]);
      expect(fixture.probe.observations[0]?.reason).toBe('reload');
      expect(fixture.probe.observations[0]?.sessionId).toBe(sourceSessionId);
      expect(fixture.probe.observations[0]?.sessionFile).toBe(sourceSessionFile);
      expect(fixture.probe.observations[0]?.sessionName).toBe('source session');
      expect(fixture.probe.observations[0]?.targetSessionFile).toBeUndefined();
      expect(fixture.probe.observations[2]?.reason).toBe('reload');
      expect(fixture.probe.observations[2]?.sessionId).toBe(sourceSessionId);
      expect(fixture.probe.observations[2]?.sessionFile).toBe(sourceSessionFile);
      expect(fixture.probe.observations[2]?.sessionName).toBe('source session');
      expect(fixture.probe.observations[2]?.previousSessionFile).toBeUndefined();
      expect(fixture.sessionId).toBe(sourceSessionId);
      expect(fixture.sessionFile).toBe(sourceSessionFile);
      expect(probe.boundSessionManager).toBe(sourceSessionManager);
      expect(resources.activeSessionManagers()).toEqual([sourceSessionManager]);
      expect(resources.observations).toEqual([
        { kind: 'shutdown', sessionId: sourceSessionId, activeSessionIds: [] },
        { kind: 'factory', activeSessionIds: [] },
        { kind: 'start', sessionId: sourceSessionId, activeSessionIds: [sourceSessionId] },
      ]);

      fixture.probe.clear();
      resources.clear();
      await fixture.newSession();
      const newSessionId = fixture.sessionId;
      const newSessionFile = fixture.sessionFile;
      const newSessionManager = fixture.sessionManager;
      expect(newSessionFile).toBeDefined();
      expect(newSessionFile).not.toBe(sourceSessionFile);
      expect(newSessionId).not.toBe(sourceSessionId);
      expectReplacement(fixture.probe, {
        reason: 'new',
        previousSessionId: sourceSessionId,
        previousSessionFile: sourceSessionFile!,
        previousSessionName: 'source session',
        targetSessionId: newSessionId,
        targetSessionFile: newSessionFile!,
        targetSessionName: undefined,
      });
      expect(probe.boundSessionManager).toBe(newSessionManager);
      expectResourceReplacement(resources, sourceSessionManager, newSessionManager);

      fixture.probe.clear();
      resources.clear();
      await fixture.resumeSession(sourceSessionFile!);
      const resumedSessionManager = fixture.sessionManager;
      expectReplacement(fixture.probe, {
        reason: 'resume',
        previousSessionId: newSessionId,
        previousSessionFile: newSessionFile!,
        previousSessionName: undefined,
        targetSessionId: sourceSessionId,
        targetSessionFile: sourceSessionFile!,
        targetSessionName: 'source session',
      });
      expect(probe.boundSessionManager).toBe(resumedSessionManager);
      expectResourceReplacement(resources, newSessionManager, resumedSessionManager);

      fixture.probe.clear();
      resources.clear();
      await fixture.forkSession(userEntry!.id, { position: 'before' });
      const forkSessionId = fixture.sessionId;
      const forkSessionFile = fixture.sessionFile;
      const forkSessionManager = fixture.sessionManager;
      expect(forkSessionFile).toBeDefined();
      expect(forkSessionFile).not.toBe(sourceSessionFile);
      expect(forkSessionId).not.toBe(sourceSessionId);
      expectReplacement(fixture.probe, {
        reason: 'fork',
        previousSessionId: sourceSessionId,
        previousSessionFile: sourceSessionFile!,
        previousSessionName: 'source session',
        targetSessionId: forkSessionId,
        targetSessionFile: forkSessionFile!,
        targetSessionName: 'source session',
      });
      expect(probe.boundSessionManager).toBe(forkSessionManager);
      expectResourceReplacement(resources, resumedSessionManager, forkSessionManager);
      fixture.probe.clear();
      resources.clear();
      await fixture.resumeSession(sourceSessionFile!);
      const sourceAgainSessionManager = fixture.sessionManager;
      expectReplacement(fixture.probe, {
        reason: 'resume',
        previousSessionId: forkSessionId,
        previousSessionFile: forkSessionFile!,
        previousSessionName: 'source session',
        targetSessionId: sourceSessionId,
        targetSessionFile: sourceSessionFile!,
        targetSessionName: 'source session',
      });
      expect(probe.boundSessionManager).toBe(sourceAgainSessionManager);
      expectResourceReplacement(resources, forkSessionManager, sourceAgainSessionManager);
      const cloneEntry = fixture.entries.find((entry) => entry.type === 'message');
      expect(cloneEntry).toBeDefined();
      fixture.probe.clear();
      resources.clear();
      await fixture.forkSession(cloneEntry!.id, { position: 'at' });
      const cloneSessionId = fixture.sessionId;
      const cloneSessionFile = fixture.sessionFile;
      const cloneSessionManager = fixture.sessionManager;
      expect(cloneSessionFile).toBeDefined();
      expect(cloneSessionFile).not.toBe(sourceSessionFile);
      expect(cloneSessionId).not.toBe(sourceSessionId);
      // The SDK models /clone as fork(entryId, { position: "at" }); both use reason "fork".
      expectReplacement(fixture.probe, {
        reason: 'fork',
        previousSessionId: sourceSessionId,
        previousSessionFile: sourceSessionFile!,
        previousSessionName: 'source session',
        targetSessionId: cloneSessionId,
        targetSessionFile: cloneSessionFile!,
        targetSessionName: 'source session',
      });
      expect(probe.boundSessionManager).toBe(cloneSessionManager);
      expectResourceReplacement(resources, sourceAgainSessionManager, cloneSessionManager);
    } finally {
      await fixture.dispose();
      resources.forceCleanup();
    }
  });

  it('bootstraps a persisted name and propagates a running-session rename', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'pi-p2p-name-lifecycle-'));
    const cwd = join(rootDir, 'workspace');
    const sessionDir = join(rootDir, 'sessions');
    await mkdir(cwd, { recursive: true });
    await mkdir(sessionDir, { recursive: true });
    const sessionManager = SessionManager.create(cwd, sessionDir);
    sessionManager.appendSessionInfo('bootstrapped name');
    const probe = createPiProbe();
    const fixture = await createPersistedPiSessionFixture({
      rootDir,
      cwd,
      sessionDir,
      sessionManager,
      probe,
      removeOnDispose: false,
    });

    try {
      expect(observationTypes(probe)).toEqual(['extension_factory', 'session_start']);
      const startup = probe.latest('session_start');
      expect(startup?.sessionId).toBe(sessionManager.getSessionId());
      expect(startup?.sessionFile).toBe(sessionManager.getSessionFile());
      expect(probe.boundSessionManager).toBe(sessionManager);
      expect(startup?.sessionName).toBe('bootstrapped name');
      expect(probe.byType('session_info_changed')).toHaveLength(0);

      probe.clear();
      fixture.session.setSessionName('renamed name');
      expect(observationTypes(probe)).toEqual(['session_info_changed']);
      const renamed = probe.latest('session_info_changed');
      expect(renamed?.sessionId).toBe(sessionManager.getSessionId());
      expect(renamed?.sessionFile).toBe(sessionManager.getSessionFile());
      expect(renamed?.sessionName).toBe('renamed name');
      expect(fixture.sessionManager.getSessionName()).toBe('renamed name');

      probe.clear();
      fixture.session.setSessionName('');
      expect(observationTypes(probe)).toEqual(['session_info_changed']);
      const cleared = probe.latest('session_info_changed');
      expect(cleared?.sessionId).toBe(sessionManager.getSessionId());
      expect(cleared?.sessionFile).toBe(sessionManager.getSessionFile());
      expect(cleared?.sessionName).toBeUndefined();
      expect(fixture.sessionManager.getSessionName()).toBeUndefined();

      probe.clear();
      await fixture.reloadSession();
      expect(observationTypes(probe)).toEqual([
        'session_shutdown',
        'extension_factory',
        'session_start',
      ]);
      expect(probe.latest('session_start')?.sessionId).toBe(sessionManager.getSessionId());
      expect(probe.latest('session_start')?.sessionFile).toBe(sessionManager.getSessionFile());
      expect(probe.latest('session_start')?.sessionName).toBeUndefined();
      expect(probe.latest('session_start')?.reason).toBe('reload');
    } finally {
      await fixture.dispose().catch(() => undefined);
      await rm(rootDir, { recursive: true, force: true });
    }
  });
});
