import { describe, expect, it } from 'vitest';
import { SessionManager } from '@earendil-works/pi-coding-agent';

import {
  appendTaskMetadata,
  completeTaskMetadata,
  createPersistedPiSessionFixture,
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
});

describe('p2p.task session ownership and lifecycle recovery', () => {
  it('keeps /new clean, recovers only the selected resume target, and resets on shutdown', async () => {
    const taskStateLifecycle = lifecycle('runtime-session');
    const fixture = await persistedFixtureWithAssistant(taskStateLifecycle);
    try {
      taskStateLifecycle.append(fixture.sessionManager, {
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

      taskStateLifecycle.append(fixture.sessionManager, {
        requestId: 'request-new',
        runtimeId: 'runtime-new',
        state: 'accepted',
        updatedAt: UPDATED_AT,
        expiresAt: FUTURE_EXPIRY,
      });
      expect(taskStateLifecycle.recovered.map((task) => task.requestId)).toEqual(['request-new']);
      taskStateLifecycle.complete(fixture.sessionManager, 'request-new', {
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
});

describe('p2p.task fork and clone lifecycle supersession', () => {
  it('supersedes inherited clone records before destination delivery and preserves origin', async () => {
    const sourceLifecycle = lifecycle('runtime-source');
    const fixture = await persistedFixtureWithAssistant(sourceLifecycle);
    let clone: Awaited<ReturnType<typeof fixture.cloneSession>> | undefined;
    let cloneRuntime: PiRuntimeFixture | undefined;
    try {
      sourceLifecycle.append(fixture.sessionManager, {
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
      expect(cloneLifecycle.recovered).toEqual([]);
      expect(foldLatestTaskMetadata(cloneRuntime.sessionManager).get('request-clone')?.state).toBe(
        'superseded',
      );
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

  it('supersedes inherited fork records before destination delivery', async () => {
    const taskStateLifecycle = lifecycle('runtime-fork');
    const fixture = await persistedFixtureWithAssistant(taskStateLifecycle);
    try {
      taskStateLifecycle.append(fixture.sessionManager, {
        requestId: 'request-fork',
        runtimeId: 'runtime-source',
        peerId: 'peer-a',
        state: 'accepted',
        updatedAt: UPDATED_AT,
        expiresAt: FUTURE_EXPIRY,
      });
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
      expect(recoverTaskMetadata(fixture.sessionManager, RECOVERY_AT)).toEqual([]);

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
