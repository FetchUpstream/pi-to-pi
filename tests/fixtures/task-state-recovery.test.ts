import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SessionManager } from '@earendil-works/pi-coding-agent';

import {
  appendTaskMetadata,
  completeTaskMetadata,
  createPersistedPiSessionFixture,
  createPiRuntimeFixture,
  createTaskStateLifecycle,
  defaultFauxResponse,
  expireTaskMetadata,
  failTaskMetadata,
  foldLatestTaskMetadata,
  P2P_TASK_CUSTOM_TYPE,
  recoverTaskMetadata,
  type PiRuntimeFixture,
} from './index.js';

const RECOVERY_AT = new Date('2030-01-02T00:00:00.000Z');
const UPDATED_AT = '2030-01-01T00:00:00.000Z';
const EXPIRED_AT = '2029-12-31T23:59:59.000Z';
const FUTURE_EXPIRY = '2030-01-03T00:00:00.000Z';
const NEXT_AT = '2030-01-02T00:00:01.000Z';

function lifecycle(runtimeId: string) {
  return createTaskStateLifecycle({ runtimeId, now: () => RECOVERY_AT });
}

async function persistedFixtureWithAssistant(taskStateLifecycle = lifecycle('runtime-fixture')) {
  const fixture = await createPersistedPiSessionFixture({ taskStateLifecycle });
  fixture.faux.setResponses([defaultFauxResponse('fixture bootstrap')]);
  await fixture.session.sendCustomMessage(
    {
      customType: 'p2p.fixture-bootstrap',
      content: 'fixture bootstrap body',
      display: false,
    },
    { triggerTurn: true },
  );
  return fixture;
}

function taskEntryId(sessionManager: SessionManager, requestId: string): string {
  const entry = sessionManager
    .getEntries()
    .find(
      (candidate) =>
        candidate.type === 'custom' &&
        candidate.customType === P2P_TASK_CUSTOM_TYPE &&
        candidate.data !== undefined &&
        typeof candidate.data === 'object' &&
        candidate.data !== null &&
        'requestId' in candidate.data &&
        candidate.data.requestId === requestId,
    );
  if (!entry || entry.type !== 'custom') {
    throw new Error(`Missing p2p.task entry for ${requestId}`);
  }
  return entry.id;
}

function currentTaskBinding(fixture: PiRuntimeFixture) {
  const binding = fixture.taskStateBinding;
  if (!binding) {
    throw new Error('Task-state lifecycle is not bound to the current Pi session');
  }
  return binding;
}

describe('p2p.task metadata schema and transitions', () => {
  it('appends an exact body-free schema and folds latest records linearly', () => {
    const sessionManager = SessionManager.inMemory('/tmp/pi-p2p-task-state');
    const accepted = appendTaskMetadata(sessionManager, {
      requestId: 'request-a',
      runtimeId: 'runtime-a',
      peerId: 'peer-a',
      state: 'accepted',
      updatedAt: UPDATED_AT,
      expiresAt: FUTURE_EXPIRY,
      now: RECOVERY_AT,
    });
    const completed = completeTaskMetadata(sessionManager, 'request-a', {
      runtimeId: 'runtime-a',
      updatedAt: NEXT_AT,
      now: RECOVERY_AT,
    });

    expect(completed.entryId).not.toBe(accepted.entryId);
    expect(completed.sessionId).toBe(accepted.sessionId);
    expect(completed.ownerSessionId).toBe(sessionManager.getSessionId());
    const taskEntries = sessionManager
      .getEntries()
      .filter((entry) => entry.type === 'custom' && entry.customType === P2P_TASK_CUSTOM_TYPE);
    expect(taskEntries).toHaveLength(2);
    expect(taskEntries[0]?.type).toBe('custom');
    if (taskEntries[0]?.type === 'custom') {
      expect(Object.keys(taskEntries[0].data as object).sort()).toEqual([
        'expiresAt',
        'ownerSessionId',
        'peerId',
        'reason',
        'requestId',
        'runtimeId',
        'sessionId',
        'state',
        'updatedAt',
        'version',
      ]);
      expect(taskEntries[0].data).not.toHaveProperty('body');
      expect(taskEntries[0].data).not.toHaveProperty('content');
    }

    const latest = foldLatestTaskMetadata(sessionManager).get('request-a');
    expect(latest?.entryId).toBe(completed.entryId);
    expect(latest?.state).toBe('completed');
    expect(latest?.sessionId).toBe(accepted.sessionId);
    expect(latest?.ownerSessionId).toBe(sessionManager.getSessionId());
    expect(latest?.runtimeId).toBe('runtime-a');
    expect(latest?.peerId).toBe('peer-a');
    expect(latest?.reason).toBeNull();
  });

  it('rejects body fields, session overrides, non-plain options, and bad timestamps', () => {
    const sessionManager = SessionManager.inMemory('/tmp/pi-p2p-task-schema');

    expect(() =>
      appendTaskMetadata(sessionManager, {
        requestId: 'request-body',
        runtimeId: 'runtime-a',
        state: 'accepted',
        updatedAt: UPDATED_AT,
        body: 'must not be persisted',
      } as never),
    ).toThrow(/must not contain message bodies/u);
    expect(() =>
      appendTaskMetadata(sessionManager, {
        requestId: 'request-session-override',
        runtimeId: 'runtime-a',
        state: 'accepted',
        sessionId: 'forged-session',
      } as never),
    ).toThrow(/ownership overrides are not allowed/u);
    expect(() =>
      appendTaskMetadata(
        sessionManager,
        Object.assign(Object.create({ inherited: true }), {
          requestId: 'request-prototype',
          runtimeId: 'runtime-a',
          state: 'accepted',
        }),
      ),
    ).toThrow(/plain object/u);
    expect(() =>
      appendTaskMetadata(sessionManager, {
        requestId: 'request-timestamp',
        runtimeId: 'runtime-a',
        state: 'accepted',
        updatedAt: 'not-a-timestamp',
      }),
    ).toThrow(/updatedAt must be an ISO timestamp/u);

    const malformed = sessionManager.appendCustomEntry(P2P_TASK_CUSTOM_TYPE, {
      version: 1,
      requestId: 'request-malformed',
      sessionId: sessionManager.getSessionId(),
      ownerSessionId: sessionManager.getSessionId(),
      runtimeId: 'runtime-a',
      peerId: null,
      state: 'accepted',
      updatedAt: UPDATED_AT,
      expiresAt: null,
      reason: null,
      unexpected: true,
    });
    expect(foldLatestTaskMetadata(sessionManager).has('request-malformed')).toBe(false);
    expect(malformed).toBeTypeOf('string');
  });

  it('rejects unknown, expired, and ownerless terminal transitions', () => {
    const sessionManager = SessionManager.inMemory('/tmp/pi-p2p-task-transitions');

    expect(() =>
      completeTaskMetadata(sessionManager, 'request-unknown', {
        runtimeId: 'runtime-a',
        now: RECOVERY_AT,
      }),
    ).toThrow(/unknown task/u);
    expect(() =>
      failTaskMetadata(sessionManager, 'request-unknown-failed', {
        runtimeId: 'runtime-a',
        now: RECOVERY_AT,
      }),
    ).toThrow(/unknown task/u);

    appendTaskMetadata(sessionManager, {
      requestId: 'request-expired',
      runtimeId: 'runtime-a',
      state: 'accepted',
      updatedAt: UPDATED_AT,
      expiresAt: EXPIRED_AT,
      now: RECOVERY_AT,
    });
    expect(() =>
      completeTaskMetadata(sessionManager, 'request-expired', {
        runtimeId: 'runtime-a',
        updatedAt: NEXT_AT,
        now: RECOVERY_AT,
      }),
    ).toThrow(/has expired/u);
    expect(() =>
      failTaskMetadata(sessionManager, 'request-expired', {
        runtimeId: 'runtime-a',
        updatedAt: NEXT_AT,
        now: RECOVERY_AT,
      }),
    ).toThrow(/has expired/u);
    const expired = expireTaskMetadata(sessionManager, 'request-expired', {
      runtimeId: 'runtime-a',
      updatedAt: NEXT_AT,
      now: RECOVERY_AT,
    });
    expect(expired.state).toBe('expired');
  });
});

describe('p2p.task persistence and reload recovery', () => {
  it('models the pre-assistant flush boundary and proves disk reload with openSession', async () => {
    const fixture = await createPersistedPiSessionFixture();
    try {
      const sessionFile = fixture.sessionFile;
      expect(sessionFile).toBeDefined();
      appendTaskMetadata(fixture.sessionManager, {
        requestId: 'request-before-assistant',
        runtimeId: 'runtime-a',
        state: 'accepted',
        updatedAt: UPDATED_AT,
        expiresAt: FUTURE_EXPIRY,
        now: RECOVERY_AT,
      });

      // Pi intentionally defers the first write until an assistant entry exists.
      const beforeAssistant = fixture.openSession(sessionFile!);
      expect(foldLatestTaskMetadata(beforeAssistant).has('request-before-assistant')).toBe(false);

      fixture.faux.setResponses([defaultFauxResponse('flush boundary')]);
      await fixture.session.sendCustomMessage(
        {
          customType: 'p2p.flush-boundary',
          content: 'flush boundary body',
          display: false,
        },
        { triggerTurn: true },
      );
      const reopened = fixture.openSession(sessionFile!);
      expect(recoverTaskMetadata(reopened, RECOVERY_AT).map((task) => task.requestId)).toEqual([
        'request-before-assistant',
      ]);
    } finally {
      await fixture.dispose();
    }
  });

  it('recovers only unexpired non-terminal latest records after reload and reopen', async () => {
    const fixture = await persistedFixtureWithAssistant();
    try {
      const sessionManager = fixture.sessionManager;
      appendTaskMetadata(sessionManager, {
        requestId: 'request-live',
        runtimeId: 'runtime-a',
        peerId: 'peer-a',
        state: 'accepted',
        updatedAt: UPDATED_AT,
        expiresAt: FUTURE_EXPIRY,
        now: RECOVERY_AT,
      });
      appendTaskMetadata(sessionManager, {
        requestId: 'request-completed',
        runtimeId: 'runtime-a',
        state: 'accepted',
        updatedAt: UPDATED_AT,
        expiresAt: FUTURE_EXPIRY,
        now: RECOVERY_AT,
      });
      completeTaskMetadata(sessionManager, 'request-completed', {
        runtimeId: 'runtime-a',
        updatedAt: NEXT_AT,
        now: RECOVERY_AT,
      });
      appendTaskMetadata(sessionManager, {
        requestId: 'request-failed',
        runtimeId: 'runtime-a',
        state: 'accepted',
        updatedAt: UPDATED_AT,
        expiresAt: FUTURE_EXPIRY,
        now: RECOVERY_AT,
      });
      failTaskMetadata(sessionManager, 'request-failed', {
        runtimeId: 'runtime-a',
        updatedAt: '2030-01-02T00:00:02.000Z',
        now: RECOVERY_AT,
      });
      appendTaskMetadata(sessionManager, {
        requestId: 'request-expired',
        runtimeId: 'runtime-a',
        state: 'accepted',
        updatedAt: UPDATED_AT,
        expiresAt: EXPIRED_AT,
        now: RECOVERY_AT,
      });
      expireTaskMetadata(sessionManager, 'request-expired', {
        runtimeId: 'runtime-a',
        updatedAt: '2030-01-02T00:00:03.000Z',
        now: RECOVERY_AT,
      });
      appendTaskMetadata(sessionManager, {
        requestId: 'request-expired-accepted',
        runtimeId: 'runtime-a',
        state: 'accepted',
        updatedAt: UPDATED_AT,
        expiresAt: EXPIRED_AT,
        now: RECOVERY_AT,
      });

      const reopenedBeforeReload = fixture.openSession(fixture.sessionFile!);
      expect(
        recoverTaskMetadata(reopenedBeforeReload, RECOVERY_AT).map((task) => task.requestId),
      ).toEqual(['request-live']);

      await fixture.reloadSession();
      expect(fixture.probe.latest('session_start')?.reason).toBe('reload');
      const reopened = fixture.openSession(fixture.sessionFile!);
      expect(recoverTaskMetadata(reopened, RECOVERY_AT).map((task) => task.requestId)).toEqual([
        'request-live',
      ]);
      const latest = foldLatestTaskMetadata(reopened);
      expect(latest.get('request-completed')?.state).toBe('completed');
      expect(latest.get('request-failed')?.state).toBe('failed');
      expect(latest.get('request-expired')?.state).toBe('expired');
      expect(latest.get('request-expired-accepted')?.state).toBe('accepted');
    } finally {
      await fixture.dispose();
    }
  });
  it('rebuilds active task state through automatic reload and replaces it on boundaries', async () => {
    const taskStateLifecycle = lifecycle('runtime-auto-reload');
    const fixture = await persistedFixtureWithAssistant(taskStateLifecycle);
    const originalBinding = currentTaskBinding(fixture);
    const originalSessionFile = fixture.sessionFile;
    expect(originalSessionFile).toBeDefined();
    try {
      taskStateLifecycle.append(originalBinding, {
        requestId: 'request-reload',
        runtimeId: 'runtime-original',
        state: 'accepted',
        updatedAt: UPDATED_AT,
        expiresAt: FUTURE_EXPIRY,
      });
      expect(taskStateLifecycle.recovered.map((task) => task.requestId)).toEqual([
        'request-reload',
      ]);
      const persisted = fixture.openSession(originalSessionFile!);
      expect(recoverTaskMetadata(persisted, RECOVERY_AT).map((task) => task.requestId)).toEqual([
        'request-reload',
      ]);
      await fixture.reloadSession();
      expect(fixture.probe.latest('session_start')?.reason).toBe('reload');
      expect(taskStateLifecycle.starts.at(-1)?.reason).toBe('reload');
      expect(taskStateLifecycle.binding).toBe(originalBinding);
      expect(taskStateLifecycle.recovered.map((task) => task.requestId)).toEqual([
        'request-reload',
      ]);
      expect(currentTaskBinding(fixture)).toBe(originalBinding);

      await fixture.newSession();
      expect(taskStateLifecycle.recovered).toEqual([]);
      expect(() =>
        taskStateLifecycle.complete(originalBinding, 'request-reload', {
          runtimeId: 'runtime-original',
          updatedAt: NEXT_AT,
        }),
      ).toThrow(/binding is no longer active/u);

      const replacementBinding = currentTaskBinding(fixture);
      taskStateLifecycle.append(replacementBinding, {
        requestId: 'request-replacement',
        runtimeId: 'runtime-replacement',
        state: 'accepted',
        updatedAt: UPDATED_AT,
        expiresAt: FUTURE_EXPIRY,
      });
      expect(taskStateLifecycle.recovered.map((task) => task.requestId)).toEqual([
        'request-replacement',
      ]);

      await fixture.resumeSession(originalSessionFile!);
      expect(taskStateLifecycle.recovered.map((task) => task.requestId)).toEqual([
        'request-reload',
      ]);
      expect(foldLatestTaskMetadata(fixture.sessionManager).has('request-replacement')).toBe(false);
    } finally {
      await fixture.dispose();
    }
  });
});

describe('p2p.task session ownership and lifecycle recovery', () => {
  it('keeps /new clean, recovers only the selected resume target, and resets on shutdown', async () => {
    const taskStateLifecycle = lifecycle('runtime-session');
    const fixture = await persistedFixtureWithAssistant(taskStateLifecycle);
    try {
      taskStateLifecycle.append(currentTaskBinding(fixture), {
        requestId: 'request-original',
        runtimeId: 'runtime-original',
        peerId: 'peer-a',
        state: 'accepted',
        updatedAt: UPDATED_AT,
        expiresAt: FUTURE_EXPIRY,
      });
      const originalSessionId = fixture.sessionId;
      const originalSessionFile = fixture.sessionFile;
      expect(originalSessionFile).toBeDefined();
      expect(taskStateLifecycle.recovered.map((task) => task.requestId)).toEqual([
        'request-original',
      ]);

      await fixture.newSession();
      expect(taskStateLifecycle.sessionId).toBe(fixture.sessionId);
      expect(fixture.sessionId).not.toBe(originalSessionId);
      expect(recoverTaskMetadata(fixture.sessionManager, RECOVERY_AT)).toEqual([]);
      expect(taskStateLifecycle.recovered).toEqual([]);

      taskStateLifecycle.append(currentTaskBinding(fixture), {
        requestId: 'request-new',
        runtimeId: 'runtime-new',
        state: 'accepted',
        updatedAt: UPDATED_AT,
        expiresAt: FUTURE_EXPIRY,
      });
      expect(taskStateLifecycle.recovered.map((task) => task.requestId)).toEqual(['request-new']);
      taskStateLifecycle.complete(currentTaskBinding(fixture), 'request-new', {
        runtimeId: 'runtime-new',
        updatedAt: NEXT_AT,
      });
      expect(taskStateLifecycle.recovered).toEqual([]);

      await fixture.resumeSession(originalSessionFile!);
      expect(fixture.sessionId).toBe(originalSessionId);
      expect(taskStateLifecycle.recovered.map((task) => task.requestId)).toEqual([
        'request-original',
      ]);
      expect(foldLatestTaskMetadata(fixture.sessionManager).has('request-new')).toBe(false);
      expect(taskStateLifecycle.shutdowns.at(-1)?.targetSessionFile).toBe(originalSessionFile);
    } finally {
      await fixture.dispose();
    }
  });

  it('rejects completion from a different current session before supersession', async () => {
    const fixture = await persistedFixtureWithAssistant();
    let clone: Awaited<ReturnType<typeof fixture.cloneSession>> | undefined;
    try {
      appendTaskMetadata(fixture.sessionManager, {
        requestId: 'request-owned',
        runtimeId: 'runtime-source',
        state: 'accepted',
        updatedAt: UPDATED_AT,
        expiresAt: FUTURE_EXPIRY,
        now: RECOVERY_AT,
      });
      clone = await fixture.cloneSession();
      expect(() =>
        completeTaskMetadata(clone!.sessionManager, 'request-owned', {
          runtimeId: 'runtime-clone',
          updatedAt: NEXT_AT,
          now: RECOVERY_AT,
        }),
      ).toThrow(/not owned by the current session/u);
      expect(foldLatestTaskMetadata(clone!.sessionManager).get('request-owned')?.state).toBe(
        'accepted',
      );
    } finally {
      await clone?.cleanup();
      await fixture.dispose();
    }
  });
  it('rejects a stale lifecycle binding when an in-memory fork reuses its SessionManager', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'pi-p2p-task-memory-fork-'));
    const cwd = join(rootDir, 'workspace');
    const agentDir = join(rootDir, 'agent');
    await mkdir(cwd, { recursive: true });
    await mkdir(agentDir, { recursive: true });
    const sessionManager = SessionManager.inMemory(cwd);
    const taskStateLifecycle = lifecycle('runtime-memory-fork');
    const fixture = await createPiRuntimeFixture({
      cwd,
      agentDir,
      sessionManager,
      taskStateLifecycle,
    });
    try {
      fixture.faux.setResponses([defaultFauxResponse('memory bootstrap')]);
      await fixture.session.sendCustomMessage(
        {
          customType: 'p2p.memory-bootstrap',
          content: 'memory bootstrap body',
          display: false,
        },
        { triggerTurn: true },
      );
      const originalBinding = currentTaskBinding(fixture);
      const originalSession = fixture.session;
      taskStateLifecycle.append(originalBinding, {
        requestId: 'request-memory-fork',
        runtimeId: 'runtime-memory-source',
        state: 'accepted',
        updatedAt: UPDATED_AT,
        expiresAt: FUTURE_EXPIRY,
      });
      const acceptedEntryId = taskEntryId(sessionManager, 'request-memory-fork');
      await fixture.fork(acceptedEntryId, { position: 'at' });
      expect(fixture.sessionManager).toBe(sessionManager);
      expect(fixture.session).not.toBe(originalSession);
      expect(taskStateLifecycle.recovered).toEqual([]);
      expect(() =>
        taskStateLifecycle.append(originalBinding, {
          requestId: 'request-stale-append',
          runtimeId: 'runtime-memory-source',
          state: 'accepted',
          updatedAt: UPDATED_AT,
          expiresAt: FUTURE_EXPIRY,
        }),
      ).toThrow(/binding is no longer active/u);
      expect(() =>
        taskStateLifecycle.complete(originalBinding, 'request-memory-fork', {
          runtimeId: 'runtime-memory-source',
          updatedAt: NEXT_AT,
        }),
      ).toThrow(/binding is no longer active/u);
    } finally {
      await fixture.dispose();
      await rm(rootDir, { recursive: true, force: true });
    }
  });
  it('re-scopes recovered tasks when the active session tree branch changes', async () => {
    const taskStateLifecycle = lifecycle('runtime-tree');
    const fixture = await persistedFixtureWithAssistant(taskStateLifecycle);
    try {
      const binding = currentTaskBinding(fixture);
      const branchPointId = fixture.sessionManager.getLeafId();
      if (!branchPointId) {
        throw new Error('Fixture session did not expose a branch point');
      }
      const accepted = taskStateLifecycle.append(binding, {
        requestId: 'request-tree-branch',
        runtimeId: 'runtime-tree',
        state: 'accepted',
        updatedAt: UPDATED_AT,
        expiresAt: FUTURE_EXPIRY,
      });
      expect(taskStateLifecycle.recovered.map((task) => task.requestId)).toEqual([
        'request-tree-branch',
      ]);

      await fixture.session.navigateTree(branchPointId);
      expect(taskStateLifecycle.binding).toBe(binding);
      expect(taskStateLifecycle.recovered).toEqual([]);

      await fixture.session.navigateTree(accepted.entryId);
      expect(taskStateLifecycle.binding).toBe(binding);
      expect(taskStateLifecycle.recovered.map((task) => task.requestId)).toEqual([
        'request-tree-branch',
      ]);
    } finally {
      await fixture.dispose();
    }
  });
});

describe('p2p.task fork and clone lifecycle supersession', () => {
  it('supersedes inherited clone records before destination delivery and preserves origin', async () => {
    const sourceLifecycle = lifecycle('runtime-source');
    const fixture = await persistedFixtureWithAssistant(sourceLifecycle);
    let clone: Awaited<ReturnType<typeof fixture.cloneSession>> | undefined;
    let cloneRuntime: PiRuntimeFixture | undefined;
    try {
      sourceLifecycle.append(currentTaskBinding(fixture), {
        requestId: 'request-clone',
        runtimeId: 'runtime-source',
        peerId: 'peer-a',
        state: 'accepted',
        updatedAt: UPDATED_AT,
        expiresAt: FUTURE_EXPIRY,
      });
      const sourceSessionId = fixture.sessionId;
      clone = await fixture.cloneSession();
      const inheritedBefore = foldLatestTaskMetadata(clone.sessionManager).get('request-clone');
      expect(inheritedBefore?.sessionId).toBe(sourceSessionId);
      expect(inheritedBefore?.ownerSessionId).toBe(sourceSessionId);
      expect(inheritedBefore?.runtimeId).toBe('runtime-source');
      const cloneLifecycle = lifecycle('runtime-clone');
      cloneRuntime = await clone.createRuntime({ taskStateLifecycle: cloneLifecycle });
      const inheritedAfter = foldLatestTaskMetadata(cloneRuntime.sessionManager).get(
        'request-clone',
      );
      expect(inheritedAfter?.sessionId).toBe(sourceSessionId);
      expect(inheritedAfter?.ownerSessionId).toBe(cloneRuntime.sessionId);
      expect(cloneLifecycle.starts.at(-1)?.superseded).toHaveLength(1);
      const superseded = cloneLifecycle.starts.at(-1)?.superseded[0];
      expect(superseded?.sessionId).toBe(sourceSessionId);
      expect(superseded?.ownerSessionId).toBe(cloneRuntime.sessionId);
      expect(superseded?.reason).toMatch(/startup replacement/u);
      expect(superseded?.runtimeId).toBe('runtime-clone');
      expect(superseded?.peerId).toBe(inheritedBefore?.peerId);
      expect(superseded?.expiresAt).toBe(inheritedBefore?.expiresAt);
      expect(cloneLifecycle.recovered).toEqual([]);
      expect(foldLatestTaskMetadata(cloneRuntime.sessionManager).get('request-clone')?.state).toBe(
        'superseded',
      );
      cloneRuntime.faux.setResponses([defaultFauxResponse('clone destination delivery')]);
      await cloneRuntime.session.sendCustomMessage(
        {
          customType: 'p2p.clone-destination',
          content: 'destination delivery body',
          display: false,
          details: { requestId: 'clone-destination' },
        },
        { triggerTurn: true },
      );
      const destinationStart = cloneRuntime.probe.latest('session_start');
      const destinationDelivery = cloneRuntime.probe
        .byType('custom_message_start')
        .find(({ customType }) => customType === 'p2p.clone-destination');
      expect(destinationDelivery?.sequence).toBeGreaterThan(destinationStart?.sequence ?? -1);
      const deliveredTask = destinationDelivery?.entries?.find((entry) => {
        if (entry.type !== 'custom' || entry.customType !== P2P_TASK_CUSTOM_TYPE) {
          return false;
        }
        return (
          typeof entry.data === 'object' &&
          entry.data !== null &&
          'requestId' in entry.data &&
          entry.data.requestId === 'request-clone' &&
          'state' in entry.data &&
          entry.data.state === 'superseded'
        );
      });
      expect(deliveredTask?.type).toBe('custom');
      if (deliveredTask?.type === 'custom') {
        expect((deliveredTask.data as { requestId?: string; state?: string }).requestId).toBe(
          'request-clone',
        );
        expect((deliveredTask.data as { state?: string }).state).toBe('superseded');
      }
      expect(() =>
        completeTaskMetadata(cloneRuntime!.sessionManager, 'request-clone', {
          runtimeId: 'runtime-clone',
          updatedAt: NEXT_AT,
          now: RECOVERY_AT,
        }),
      ).toThrow(/already terminal \(superseded\)/u);

      const source = fixture.openSession(fixture.sessionFile!);
      expect(recoverTaskMetadata(source, RECOVERY_AT).map((task) => task.requestId)).toEqual([
        'request-clone',
      ]);
    } finally {
      await cloneRuntime?.dispose();
      await clone?.cleanup();
      await fixture.dispose();
    }
  });
  it('clones only the persisted active branch instead of the full session file', async () => {
    const fixture = await persistedFixtureWithAssistant();
    let clone: Awaited<ReturnType<typeof fixture.cloneSession>> | undefined;
    try {
      const branchPointId = fixture.sessionManager.getLeafId();
      if (!branchPointId) {
        throw new Error('Fixture session did not expose a branch point');
      }
      appendTaskMetadata(fixture.sessionManager, {
        requestId: 'request-inactive-branch',
        runtimeId: 'runtime-source',
        peerId: 'peer-inactive',
        state: 'accepted',
        updatedAt: UPDATED_AT,
        expiresAt: FUTURE_EXPIRY,
        now: RECOVERY_AT,
      });
      fixture.sessionManager.branch(branchPointId);
      appendTaskMetadata(fixture.sessionManager, {
        requestId: 'request-active-branch',
        runtimeId: 'runtime-source',
        peerId: 'peer-active',
        state: 'accepted',
        updatedAt: UPDATED_AT,
        expiresAt: FUTURE_EXPIRY,
        now: RECOVERY_AT,
      });
      expect(
        fixture.entries.some(
          (entry) =>
            entry.type === 'custom' &&
            entry.customType === P2P_TASK_CUSTOM_TYPE &&
            typeof entry.data === 'object' &&
            entry.data !== null &&
            'requestId' in entry.data &&
            entry.data.requestId === 'request-inactive-branch',
        ),
      ).toBe(true);
      clone = await fixture.cloneSession();
      const clonedLatest = foldLatestTaskMetadata(clone.sessionManager);
      expect(clonedLatest.get('request-active-branch')?.state).toBe('accepted');
      expect(clonedLatest.has('request-inactive-branch')).toBe(false);
      expect(
        clone.sessionManager
          .getEntries()
          .some(
            (entry) =>
              entry.type === 'custom' &&
              entry.customType === P2P_TASK_CUSTOM_TYPE &&
              typeof entry.data === 'object' &&
              entry.data !== null &&
              'requestId' in entry.data &&
              entry.data.requestId === 'request-inactive-branch',
          ),
      ).toBe(false);
    } finally {
      await clone?.cleanup();
      await fixture.dispose();
    }
  });

  it('supersedes inherited fork records before destination delivery', async () => {
    const taskStateLifecycle = lifecycle('runtime-fork');
    const fixture = await persistedFixtureWithAssistant(taskStateLifecycle);
    try {
      const accepted = taskStateLifecycle.append(currentTaskBinding(fixture), {
        requestId: 'request-fork',
        runtimeId: 'runtime-source',
        peerId: 'peer-a',
        state: 'accepted',
        updatedAt: UPDATED_AT,
        expiresAt: FUTURE_EXPIRY,
      });
      expect(accepted.runtimeId).toBe('runtime-source');
      const sourceSessionId = fixture.sessionId;
      const sourceSessionFile = fixture.sessionFile;
      const acceptedEntryId = taskEntryId(fixture.sessionManager, 'request-fork');
      expect(sourceSessionFile).toBeDefined();

      await fixture.forkSession(acceptedEntryId, { position: 'at' });
      expect(fixture.sessionId).not.toBe(sourceSessionId);
      expect(taskStateLifecycle.starts.at(-1)?.reason).toBe('fork');
      expect(taskStateLifecycle.starts.at(-1)?.superseded).toHaveLength(1);
      const superseded = foldLatestTaskMetadata(fixture.sessionManager).get('request-fork');
      expect(superseded?.state).toBe('superseded');
      expect(superseded?.sessionId).toBe(sourceSessionId);
      expect(superseded?.ownerSessionId).toBe(fixture.sessionId);
      expect(superseded?.runtimeId).toBe('runtime-fork');
      expect(superseded?.peerId).toBe(accepted.peerId);
      expect(superseded?.expiresAt).toBe(accepted.expiresAt);
      expect(recoverTaskMetadata(fixture.sessionManager, RECOVERY_AT)).toEqual([]);

      fixture.faux.setResponses([defaultFauxResponse('fork destination delivery')]);
      await fixture.session.sendCustomMessage(
        {
          customType: 'p2p.fork-destination',
          content: 'destination delivery body',
          display: false,
          details: { requestId: 'fork-destination' },
        },
        { triggerTurn: true },
      );
      const destinationStart = fixture.probe.latest('session_start');
      const destinationDelivery = fixture.probe
        .byType('custom_message_start')
        .find(({ customType }) => customType === 'p2p.fork-destination');
      expect(destinationDelivery?.sequence).toBeGreaterThan(destinationStart?.sequence ?? -1);
      const deliveredTask = destinationDelivery?.entries?.find((entry) => {
        if (entry.type !== 'custom' || entry.customType !== P2P_TASK_CUSTOM_TYPE) {
          return false;
        }
        return (
          typeof entry.data === 'object' &&
          entry.data !== null &&
          'requestId' in entry.data &&
          entry.data.requestId === 'request-fork' &&
          'state' in entry.data &&
          entry.data.state === 'superseded'
        );
      });
      expect(deliveredTask?.type).toBe('custom');
      const source = fixture.openSession(sourceSessionFile!);
      expect(recoverTaskMetadata(source, RECOVERY_AT).map((task) => task.requestId)).toEqual([
        'request-fork',
      ]);
    } finally {
      await fixture.dispose();
    }
  });

  it('does not recover metadata after a fork branch point', async () => {
    const fixture = await persistedFixtureWithAssistant();
    try {
      const branchPointId = fixture.sessionManager.appendCustomEntry('p2p.fixture-branch-point', {
        marker: 'before task metadata',
      });
      appendTaskMetadata(fixture.sessionManager, {
        requestId: 'request-after-branch',
        runtimeId: 'runtime-source',
        state: 'accepted',
        updatedAt: UPDATED_AT,
        expiresAt: FUTURE_EXPIRY,
        now: RECOVERY_AT,
      });
      const taskId = taskEntryId(fixture.sessionManager, 'request-after-branch');
      await fixture.forkSession(branchPointId, { position: 'at' });

      expect(fixture.entries.some((entry) => entry.id === taskId)).toBe(false);
      expect(foldLatestTaskMetadata(fixture.sessionManager).has('request-after-branch')).toBe(
        false,
      );
      expect(recoverTaskMetadata(fixture.sessionManager, RECOVERY_AT)).toEqual([]);
    } finally {
      await fixture.dispose();
    }
  });
});
