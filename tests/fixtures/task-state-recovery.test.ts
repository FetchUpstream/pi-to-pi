import { describe, expect, it } from 'vitest';
import { SessionManager } from '@earendil-works/pi-coding-agent';

import {
  appendTaskMetadata,
  createPersistedPiSessionFixture,
  defaultFauxResponse,
  foldLatestTaskMetadata,
  P2P_TASK_CUSTOM_TYPE,
  recoverTaskMetadata,
  supersedeInheritedTaskMetadata,
} from './index.js';

const RECOVERY_AT = new Date('2030-01-02T00:00:00.000Z');
const UPDATED_AT = '2030-01-01T00:00:00.000Z';
const EXPIRED_AT = '2029-12-31T23:59:59.000Z';
const FUTURE_EXPIRY = '2030-01-03T00:00:00.000Z';

async function persistedFixtureWithAssistant() {
  const fixture = await createPersistedPiSessionFixture();
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

describe('p2p.task metadata helpers', () => {
  it('appends compact metadata and folds the latest record by request ID', () => {
    const sessionManager = SessionManager.inMemory('/tmp/pi-p2p-task-state');
    const accepted = appendTaskMetadata(sessionManager, {
      requestId: 'request-a',
      runtimeId: 'runtime-a',
      peerId: 'peer-a',
      state: 'accepted',
      updatedAt: UPDATED_AT,
      expiresAt: FUTURE_EXPIRY,
    });
    const completed = appendTaskMetadata(sessionManager, {
      requestId: 'request-a',
      runtimeId: 'runtime-a',
      peerId: 'peer-a',
      state: 'completed',
      updatedAt: '2030-01-01T00:00:01.000Z',
    });

    expect(completed.entryId).not.toBe(accepted.entryId);
    const taskEntries = sessionManager
      .getEntries()
      .filter((entry) => entry.type === 'custom' && entry.customType === P2P_TASK_CUSTOM_TYPE);
    expect(taskEntries).toHaveLength(2);
    expect(taskEntries[0]?.type).toBe('custom');
    if (taskEntries[0]?.type === 'custom') {
      expect(Object.keys(taskEntries[0].data as object).sort()).toEqual([
        'expiresAt',
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
    expect(latest?.sessionId).toBe(sessionManager.getSessionId());
    expect(latest?.runtimeId).toBe('runtime-a');
    expect(latest?.peerId).toBe('peer-a');
    expect(latest?.reason).toBeNull();

    expect(() =>
      appendTaskMetadata(sessionManager, {
        requestId: 'request-body',
        runtimeId: 'runtime-a',
        state: 'accepted',
        expiresAt: FUTURE_EXPIRY,
        updatedAt: UPDATED_AT,
        body: 'must not be persisted',
      } as never),
    ).toThrow(/must not contain message bodies/u);
  });
});

describe('p2p.task reload recovery', () => {
  it('recovers only unexpired non-terminal latest records after reload', async () => {
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
      });
      appendTaskMetadata(sessionManager, {
        requestId: 'request-completed',
        runtimeId: 'runtime-a',
        state: 'accepted',
        updatedAt: UPDATED_AT,
        expiresAt: FUTURE_EXPIRY,
      });
      appendTaskMetadata(sessionManager, {
        requestId: 'request-completed',
        runtimeId: 'runtime-a',
        state: 'completed',
        updatedAt: '2030-01-01T00:00:01.000Z',
      });
      appendTaskMetadata(sessionManager, {
        requestId: 'request-failed',
        runtimeId: 'runtime-a',
        state: 'accepted',
        updatedAt: UPDATED_AT,
        expiresAt: FUTURE_EXPIRY,
      });
      appendTaskMetadata(sessionManager, {
        requestId: 'request-failed',
        runtimeId: 'runtime-a',
        state: 'failed',
        updatedAt: '2030-01-01T00:00:02.000Z',
      });
      appendTaskMetadata(sessionManager, {
        requestId: 'request-expired-state',
        runtimeId: 'runtime-a',
        state: 'expired',
        updatedAt: UPDATED_AT,
        expiresAt: EXPIRED_AT,
      });
      appendTaskMetadata(sessionManager, {
        requestId: 'request-superseded',
        runtimeId: 'runtime-a',
        state: 'accepted',
        updatedAt: UPDATED_AT,
        expiresAt: FUTURE_EXPIRY,
      });
      appendTaskMetadata(sessionManager, {
        requestId: 'request-superseded',
        runtimeId: 'runtime-a',
        state: 'superseded',
        updatedAt: '2030-01-01T00:00:03.000Z',
        expiresAt: FUTURE_EXPIRY,
        reason: 'session replacement',
      });
      appendTaskMetadata(sessionManager, {
        requestId: 'request-expired-accepted',
        runtimeId: 'runtime-a',
        state: 'accepted',
        updatedAt: UPDATED_AT,
        expiresAt: EXPIRED_AT,
      });

      await fixture.reloadSession();

      expect(fixture.probe.latest('session_start')?.reason).toBe('reload');
      expect(
        recoverTaskMetadata(fixture.sessionManager, RECOVERY_AT).map((task) => task.requestId),
      ).toEqual(['request-live']);
      const latest = foldLatestTaskMetadata(fixture.sessionManager);
      expect(latest.get('request-completed')?.state).toBe('completed');
      expect(latest.get('request-failed')?.state).toBe('failed');
      expect(latest.get('request-expired-state')?.state).toBe('expired');
      expect(latest.get('request-superseded')?.state).toBe('superseded');
      expect(latest.get('request-expired-accepted')?.state).toBe('accepted');
    } finally {
      await fixture.dispose();
    }
  });
});

describe('p2p.task session ownership', () => {
  it('keeps /new clean and resumes only the selected persisted session', async () => {
    const fixture = await persistedFixtureWithAssistant();
    try {
      appendTaskMetadata(fixture.sessionManager, {
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

      await fixture.newSession();
      expect(fixture.sessionId).not.toBe(originalSessionId);
      expect(recoverTaskMetadata(fixture.sessionManager, RECOVERY_AT)).toEqual([]);

      appendTaskMetadata(fixture.sessionManager, {
        requestId: 'request-new',
        runtimeId: 'runtime-new',
        state: 'accepted',
        updatedAt: UPDATED_AT,
        expiresAt: FUTURE_EXPIRY,
      });
      expect(
        recoverTaskMetadata(fixture.sessionManager, RECOVERY_AT).map((task) => task.requestId),
      ).toEqual(['request-new']);

      await fixture.resumeSession(originalSessionFile!);
      expect(fixture.sessionId).toBe(originalSessionId);
      expect(
        recoverTaskMetadata(fixture.sessionManager, RECOVERY_AT).map((task) => task.requestId),
      ).toEqual(['request-original']);
      expect(foldLatestTaskMetadata(fixture.sessionManager).has('request-new')).toBe(false);
    } finally {
      await fixture.dispose();
    }
  });
});

describe('p2p.task fork and clone ownership', () => {
  it('supersedes inherited clone records with a reason and blocks completion', async () => {
    const fixture = await persistedFixtureWithAssistant();
    let clone: Awaited<ReturnType<typeof fixture.cloneSession>> | undefined;
    try {
      appendTaskMetadata(fixture.sessionManager, {
        requestId: 'request-clone',
        runtimeId: 'runtime-source',
        peerId: 'peer-a',
        state: 'accepted',
        updatedAt: UPDATED_AT,
        expiresAt: FUTURE_EXPIRY,
      });
      const sourceSessionId = fixture.sessionId;
      clone = await fixture.cloneSession();

      const inherited = foldLatestTaskMetadata(clone.sessionManager).get('request-clone');
      expect(inherited?.sessionId).toBe(sourceSessionId);
      expect(inherited?.state).toBe('accepted');

      const cloneRuntime = await clone.createRuntime();
      try {
        const superseded = supersedeInheritedTaskMetadata(cloneRuntime.sessionManager, {
          runtimeId: 'runtime-clone',
          reason: 'clone replacement inherited history',
          updatedAt: '2030-01-01T00:00:04.000Z',
        });
        expect(superseded).toHaveLength(1);
        expect(superseded[0]?.sessionId).toBe(cloneRuntime.sessionId);
        expect(superseded[0]?.reason).toBe('clone replacement inherited history');
        expect(
          foldLatestTaskMetadata(cloneRuntime.sessionManager).get('request-clone')?.state,
        ).toBe('superseded');
        expect(recoverTaskMetadata(cloneRuntime.sessionManager, RECOVERY_AT)).toEqual([]);
        expect(() =>
          appendTaskMetadata(cloneRuntime.sessionManager, {
            requestId: 'request-clone',
            runtimeId: 'runtime-clone',
            state: 'completed',
            updatedAt: '2030-01-01T00:00:05.000Z',
          }),
        ).toThrow(/already terminal \(superseded\)/u);
      } finally {
        await cloneRuntime.dispose();
      }

      expect(
        recoverTaskMetadata(fixture.sessionManager, RECOVERY_AT).map((task) => task.requestId),
      ).toEqual(['request-clone']);
    } finally {
      await clone?.cleanup();
      await fixture.dispose();
    }
  });

  it('supersedes inherited fork records while preserving the source session scope', async () => {
    const fixture = await persistedFixtureWithAssistant();
    try {
      appendTaskMetadata(fixture.sessionManager, {
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
      expect(foldLatestTaskMetadata(fixture.sessionManager).get('request-fork')?.sessionId).toBe(
        sourceSessionId,
      );

      const superseded = supersedeInheritedTaskMetadata(fixture.sessionManager, {
        runtimeId: 'runtime-fork',
        reason: 'fork replacement inherited history',
        updatedAt: '2030-01-01T00:00:06.000Z',
      });
      expect(superseded).toHaveLength(1);
      expect(superseded[0]?.reason).toBe('fork replacement inherited history');
      expect(recoverTaskMetadata(fixture.sessionManager, RECOVERY_AT)).toEqual([]);
      expect(() =>
        appendTaskMetadata(fixture.sessionManager, {
          requestId: 'request-fork',
          runtimeId: 'runtime-fork',
          state: 'completed',
          updatedAt: '2030-01-01T00:00:07.000Z',
        }),
      ).toThrow(/already terminal \(superseded\)/u);

      const source = fixture.openSession(sourceSessionFile!);
      expect(recoverTaskMetadata(source, RECOVERY_AT).map((task) => task.requestId)).toEqual([
        'request-fork',
      ]);
    } finally {
      await fixture.dispose();
    }
  });

  it('does not recover a task whose metadata is after the fork branch point', async () => {
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
