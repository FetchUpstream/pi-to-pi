import { describe, expect, it } from 'vitest';

import { createProtocolError } from '../../src/protocol/errors.js';
import type { TaskSnapshot, TaskState } from '../../src/protocol/task-state.js';
import {
  TaskStore,
  type TaskStoreCreateInput,
  type TaskStoreOptions,
  type TaskTransitionUpdate,
} from '../../src/router/task-store.js';

const START_TIME = Date.parse('2026-08-07T10:00:00.000Z');
const OWNER_RUNTIME = 'runtime-owner';
const OWNER_SESSION = 'session-owner';
const OTHER_RUNTIME = 'runtime-other';
const LOCAL_RUNTIME = 'runtime-local';

class ManualClock {
  private currentTime = START_TIME;
  private nextTimerId = 0;
  private readonly timers = new Map<
    number,
    { readonly at: number; readonly callback: () => void }
  >();

  readonly now = (): number => this.currentTime;

  readonly setTimeout = (callback: () => void, delayMs: number): ReturnType<typeof setTimeout> => {
    const id = ++this.nextTimerId;
    this.timers.set(id, {
      at: this.currentTime + Math.max(0, delayMs),
      callback,
    });
    return id as unknown as ReturnType<typeof setTimeout>;
  };

  readonly clearTimeout = (timer: ReturnType<typeof setTimeout>): void => {
    this.timers.delete(timer as unknown as number);
  };

  advanceBy(milliseconds: number): void {
    if (milliseconds < 0) {
      throw new RangeError('manual clock cannot move backwards');
    }

    const target = this.currentTime + milliseconds;
    while (true) {
      let nextId: number | undefined;
      let nextAt = Number.POSITIVE_INFINITY;
      for (const [id, timer] of this.timers) {
        if (timer.at <= target && timer.at < nextAt) {
          nextId = id;
          nextAt = timer.at;
        }
      }

      if (nextId === undefined) {
        break;
      }

      const timer = this.timers.get(nextId);
      this.timers.delete(nextId);
      if (timer === undefined) {
        continue;
      }
      this.currentTime = timer.at;
      timer.callback();
    }
    this.currentTime = target;
  }
}

type StoreOptions = Omit<TaskStoreOptions, 'now' | 'clock' | 'setTimeout' | 'clearTimeout'>;

function createStore(clock: ManualClock, options: StoreOptions = {}): TaskStore {
  return new TaskStore({
    ...options,
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
  });
}

function createTask(
  store: TaskStore,
  requestId: string,
  overrides: Partial<TaskStoreCreateInput> = {},
): TaskSnapshot {
  return store.createTask({
    requestId,
    owner: { runtimeId: OWNER_RUNTIME, sessionId: OWNER_SESSION },
    createdAt: START_TIME,
    expiresAt: START_TIME + 60_000,
    ...overrides,
  });
}

function updateForTerminalState(state: TaskState): TaskTransitionUpdate {
  if (state === 'completed') {
    return { content: { type: 'text', text: `finished as ${state}` } };
  }
  if (state === 'failed') {
    return { error: createProtocolError('internal', 'executor failed') };
  }
  if (state === 'rejected') {
    return { error: createProtocolError('malformed', 'request rejected') };
  }
  return {};
}

const legalTransitions: readonly (readonly [TaskState, TaskState])[] = [
  ['created', 'accepted'],
  ['created', 'rejected'],
  ['created', 'expired'],
  ['accepted', 'queued'],
  ['accepted', 'working'],
  ['accepted', 'rejected'],
  ['accepted', 'cancelling'],
  ['accepted', 'cancelled'],
  ['accepted', 'expired'],
  ['queued', 'working'],
  ['queued', 'rejected'],
  ['queued', 'cancelling'],
  ['queued', 'cancelled'],
  ['queued', 'expired'],
  ['working', 'completed'],
  ['working', 'failed'],
  ['working', 'rejected'],
  ['working', 'cancelling'],
  ['working', 'expired'],
  ['cancelling', 'cancelled'],
  ['cancelling', 'completed'],
  ['cancelling', 'failed'],
  ['cancelling', 'expired'],
];

describe('TaskStore lifecycle', () => {
  for (const [from, to] of legalTransitions) {
    it(`allows the legal ${from} -> ${to} transition`, () => {
      const clock = new ManualClock();
      const store = createStore(clock);
      const requestId = `legal-${from}-${to}`;

      createTask(store, requestId, {
        initialState: from === 'cancelling' ? 'working' : from,
      });
      if (from === 'cancelling') {
        expect(
          store.tryTransition(requestId, 'cancelling', {
            requestedAt: START_TIME + 1,
          }),
        ).toMatchObject({ ok: true, snapshot: { state: 'cancelling' } });
      }

      const result = store.tryTransition(requestId, to, updateForTerminalState(to));

      expect(result).toMatchObject({
        ok: true,
        changed: true,
        previousState: from,
        snapshot: { requestId, state: to },
      });
      if (result.ok && ['completed', 'failed', 'rejected', 'cancelled', 'expired'].includes(to)) {
        expect(result.snapshot.terminalOutcome).toBe(to);
      }
      store.dispose();
    });
  }

  it('rejects an illegal transition without changing the active snapshot', () => {
    const clock = new ManualClock();
    const store = createStore(clock);
    const before = createTask(store, 'illegal-transition', { initialState: 'accepted' });

    const result = store.tryTransition('illegal-transition', 'created');

    expect(result).toMatchObject({
      ok: false,
      changed: false,
      code: 'invalid_transition',
      snapshot: before,
    });
    expect(store.getTask('illegal-transition')).toEqual(before);
    store.dispose();
  });

  it('keeps terminal state and retained response immutable after later operations', () => {
    const clock = new ManualClock();
    const store = createStore(clock, { terminalRetentionMs: 100 });
    createTask(store, 'terminal-immutable', { initialState: 'working' });

    const completed = store.completeTask('terminal-immutable', {
      content: { type: 'text', text: 'the committed result' },
    });
    expect(completed).toMatchObject({
      state: 'completed',
      terminalOutcome: 'completed',
      content: { type: 'text', text: 'the committed result' },
    });
    const committed = JSON.parse(JSON.stringify(completed)) as TaskSnapshot;

    expect(
      store.failTask('terminal-immutable', createProtocolError('internal', 'late failure')),
    ).toBe(undefined);
    expect(
      store.rejectTask('terminal-immutable', createProtocolError('malformed', 'late rejection')),
    ).toBe(undefined);
    expect(store.tryTransition('terminal-immutable', 'working')).toMatchObject({
      ok: false,
      changed: false,
      code: 'terminal',
      snapshot: committed,
    });
    expect(store.expireTask('terminal-immutable')).toEqual(committed);
    expect(store.cancelTask('terminal-immutable', OWNER_RUNTIME)).toMatchObject({
      ok: false,
      changed: false,
      code: 'not_cancelable',
      snapshot: committed,
    });
    expect(store.getTask('terminal-immutable', { includeTerminalResponse: true })).toEqual(
      committed,
    );
    store.dispose();
  });

  it('authorizes status and cancellation by owner, local owner, or explicit policy', () => {
    const clock = new ManualClock();
    const authorizationCalls: Array<{ readonly action: string; readonly callerRuntimeId: string }> =
      [];
    const store = createStore(clock, {
      localOwnerRuntimeId: LOCAL_RUNTIME,
      authorize: ({ action, callerRuntimeId }) => {
        authorizationCalls.push({ action, callerRuntimeId });
        return callerRuntimeId === 'runtime-authorized';
      },
    });
    createTask(store, 'owned-task');

    expect(store.ownsTask('owned-task', OWNER_RUNTIME)).toBe(true);
    expect(store.ownsTask('owned-task', LOCAL_RUNTIME)).toBe(true);
    expect(store.ownsTask('owned-task', OTHER_RUNTIME)).toBe(false);
    expect(store.getStatusResult('owned-task', OWNER_RUNTIME)).toMatchObject({ ok: true });
    expect(store.getStatusResult('owned-task', LOCAL_RUNTIME)).toMatchObject({ ok: true });
    expect(store.getStatusResult('owned-task', OTHER_RUNTIME)).toEqual({
      ok: false,
      code: 'unauthorized',
    });
    expect(store.getStatusResult('owned-task', 'runtime-authorized')).toMatchObject({ ok: true });
    expect(store.cancelTask('owned-task', OTHER_RUNTIME)).toEqual({
      ok: false,
      changed: false,
      code: 'unauthorized',
    });
    expect(store.cancelTask('owned-task', 'runtime-authorized')).toMatchObject({
      ok: true,
      changed: true,
      state: 'cancelled',
    });
    expect(authorizationCalls).toEqual([
      { action: 'status', callerRuntimeId: OTHER_RUNTIME },
      { action: 'status', callerRuntimeId: OTHER_RUNTIME },
      { action: 'status', callerRuntimeId: 'runtime-authorized' },
      { action: 'cancel', callerRuntimeId: OTHER_RUNTIME },
      { action: 'cancel', callerRuntimeId: 'runtime-authorized' },
    ]);
    store.dispose();
  });

  it('expires queued work at its absolute deadline and never starts it', () => {
    const clock = new ManualClock();
    const expiredSnapshots: TaskSnapshot[] = [];
    const store = createStore(clock, {
      onExpired: (snapshot) => expiredSnapshots.push(snapshot),
    });
    createTask(store, 'queued-expiry', {
      initialState: 'queued',
      expiresAt: START_TIME + 100,
    });

    clock.advanceBy(99);
    expect(store.getTask('queued-expiry')).toMatchObject({ state: 'queued' });
    expect(store.queuedSize).toBe(1);

    clock.advanceBy(1);
    expect(store.getTask('queued-expiry')).toMatchObject({
      state: 'expired',
      terminalOutcome: 'expired',
      error: { code: 'expired' },
    });
    expect(store.queuedSize).toBe(0);
    expect(store.startTask('queued-expiry')).toBe(undefined);
    expect(store.getCancellationSignal('queued-expiry')?.aborted).toBe(true);
    expect(expiredSnapshots).toHaveLength(1);
    expect(expiredSnapshots[0]).toMatchObject({ state: 'expired', requestId: 'queued-expiry' });
    store.dispose();
  });

  it('records a request as expired when its deadline has already elapsed at admission', () => {
    const clock = new ManualClock();
    const expiredSnapshots: TaskSnapshot[] = [];
    const store = createStore(clock, {
      onExpired: (snapshot) => expiredSnapshots.push(snapshot),
    });
    clock.advanceBy(500);

    const snapshot = createTask(store, 'expired-before-admission', {
      initialState: 'accepted',
      createdAt: START_TIME,
      expiresAt: START_TIME + 500,
    });

    expect(snapshot).toMatchObject({
      state: 'expired',
      terminalOutcome: 'expired',
      error: { code: 'expired' },
    });
    expect(store.queuedSize).toBe(0);
    expect(expiredSnapshots).toEqual([snapshot]);
    store.dispose();
  });

  it('cancels queued work immediately and makes repeated cancellation idempotent', () => {
    const clock = new ManualClock();
    const transitions: Array<{ readonly from: TaskState; readonly to: TaskState }> = [];
    const store = createStore(clock, {
      onStateChange: ({ from, to }) => transitions.push({ from, to }),
    });
    createTask(store, 'queued-cancellation', { initialState: 'queued' });
    const signal = store.getCancellationSignal('queued-cancellation');

    const first = store.cancelTask('queued-cancellation', {
      caller: OWNER_RUNTIME,
      reason: 'no longer needed',
      requestedAt: START_TIME + 10,
    });

    expect(first).toMatchObject({
      ok: true,
      changed: true,
      state: 'cancelled',
      snapshot: {
        state: 'cancelled',
        terminalOutcome: 'cancelled',
        cancellationRequested: true,
        cancellation: { state: 'requested', requestedAt: '2026-08-07T10:00:00.010Z' },
        error: { code: 'cancelled', message: 'no longer needed' },
      },
    });
    expect(store.queuedSize).toBe(0);
    expect(signal?.aborted).toBe(true);
    expect(store.startTask('queued-cancellation')).toBe(undefined);
    expect(store.cancelTask('queued-cancellation', OWNER_RUNTIME)).toMatchObject({
      ok: true,
      changed: false,
      state: 'cancelled',
    });
    expect(transitions).toContainEqual({ from: 'queued', to: 'cancelled' });
    store.dispose();
  });

  it('signals only the cancelled working task and preserves each executor scope', () => {
    const clock = new ManualClock();
    const cancellationEvents: Array<{
      readonly requestId: string;
      readonly state: TaskState;
      readonly signal: AbortSignal;
      readonly reason?: string;
    }> = [];
    const abortReasons: unknown[] = [];
    const store = createStore(clock, {
      onCancellationRequested: ({ requestId, snapshot, signal, reason }) =>
        cancellationEvents.push({ requestId, state: snapshot.state, signal, reason }),
    });
    createTask(store, 'working-cancellation-a', { initialState: 'working' });
    createTask(store, 'working-cancellation-b', { initialState: 'working' });
    const first = store.beginExecution('working-cancellation-a');
    const second = store.beginExecution('working-cancellation-b');
    expect(first?.signal).not.toBe(second?.signal);
    const unsubscribe = store.onCancellation('working-cancellation-a', (reason) =>
      abortReasons.push(reason),
    );

    const cancellation = store.cancelTask('working-cancellation-a', {
      caller: OWNER_RUNTIME,
      reason: 'stop this one task',
    });

    expect(cancellation).toMatchObject({
      ok: true,
      changed: true,
      state: 'cancelling',
      snapshot: { state: 'cancelling', cancellationRequested: true },
    });
    expect(first?.signal.aborted).toBe(true);
    expect(second?.signal.aborted).toBe(false);
    expect(store.getTask('working-cancellation-b')).toMatchObject({ state: 'working' });
    expect(cancellationEvents).toHaveLength(1);
    expect(cancellationEvents[0]).toMatchObject({
      requestId: 'working-cancellation-a',
      state: 'cancelling',
      signal: first?.signal,
      reason: 'stop this one task',
    });
    expect(abortReasons).toEqual(['stop this one task']);

    expect(
      store.completeTask('working-cancellation-b', {
        content: { type: 'text', text: 'unrelated work completed' },
      }),
    ).toMatchObject({ state: 'completed' });
    expect(
      store.completeTask('working-cancellation-a', {
        content: { type: 'text', text: 'executor finished after cancellation request' },
      }),
    ).toMatchObject({ state: 'completed' });
    unsubscribe();
    store.dispose();
  });

  it('commits whichever terminal outcome wins completion, cancellation, and expiry races first', () => {
    const completionClock = new ManualClock();
    const completionStore = createStore(completionClock);
    createTask(completionStore, 'completion-wins', {
      initialState: 'working',
      expiresAt: START_TIME + 100,
    });
    const completed = completionStore.completeTask('completion-wins', {
      content: { type: 'text', text: 'completion committed first' },
    });
    const lateCancellation = completionStore.cancelTask('completion-wins', OWNER_RUNTIME);
    expect(completed).toMatchObject({ state: 'completed', terminalOutcome: 'completed' });
    expect(lateCancellation).toMatchObject({
      ok: false,
      changed: false,
      code: 'not_cancelable',
      snapshot: completed,
    });
    completionClock.advanceBy(100);
    expect(completionStore.getTask('completion-wins')).toEqual(completed);
    completionStore.dispose();

    const cancellationClock = new ManualClock();
    const cancellationStore = createStore(cancellationClock);
    createTask(cancellationStore, 'cancellation-wins', {
      initialState: 'working',
      expiresAt: START_TIME + 100,
    });
    expect(cancellationStore.cancelTask('cancellation-wins', OWNER_RUNTIME)).toMatchObject({
      ok: true,
      state: 'cancelling',
    });
    const cancelled = cancellationStore.transition('cancellation-wins', 'cancelled');
    expect(cancelled).toMatchObject({ state: 'cancelled', terminalOutcome: 'cancelled' });
    expect(
      cancellationStore.completeTask('cancellation-wins', {
        content: { type: 'text', text: 'late completion' },
      }),
    ).toBe(undefined);
    expect(cancellationStore.getTask('cancellation-wins')).toEqual(cancelled);
    cancellationStore.dispose();

    const expiryClock = new ManualClock();
    const expiryStore = createStore(expiryClock);
    createTask(expiryStore, 'expiry-wins', {
      initialState: 'working',
      expiresAt: START_TIME + 100,
    });
    expiryClock.advanceBy(100);
    const expired = expiryStore.getTask('expiry-wins');
    expect(expired).toMatchObject({ state: 'expired', terminalOutcome: 'expired' });
    expect(
      expiryStore.completeTask('expiry-wins', {
        content: { type: 'text', text: 'late completion' },
      }),
    ).toBe(undefined);
    expect(expiryStore.cancelTask('expiry-wins', OWNER_RUNTIME)).toMatchObject({
      ok: false,
      changed: false,
      code: 'not_cancelable',
      snapshot: expired,
    });
    expiryStore.dispose();
  });

  it('returns not_found for unknown or purged tasks without leaking ownership', () => {
    const clock = new ManualClock();
    const store = createStore(clock, { terminalRetentionMs: 25 });

    expect(store.getTask('unknown-task')).toBe(undefined);
    expect(store.getStatusResult('unknown-task')).toEqual({ ok: false, code: 'not_found' });
    expect(store.getStatusResult('unknown-task', OWNER_RUNTIME)).toEqual({
      ok: false,
      code: 'unauthorized',
    });

    createTask(store, 'purged-task', { initialState: 'working' });
    expect(
      store.completeTask('purged-task', {
        content: { type: 'text', text: 'retain briefly' },
      }),
    ).toMatchObject({ state: 'completed' });
    expect(store.getTask('purged-task')).toMatchObject({ state: 'completed' });
    clock.advanceBy(24);
    expect(store.getTask('purged-task')).toMatchObject({ state: 'completed' });
    clock.advanceBy(1);
    expect(store.getTask('purged-task')).toBe(undefined);
    expect(store.getStatusResult('purged-task')).toEqual({ ok: false, code: 'not_found' });
    expect(store.getStatusResult('purged-task', OWNER_RUNTIME)).toEqual({
      ok: false,
      code: 'unauthorized',
    });

    createTask(store, 'explicit-purge', { initialState: 'working' });
    store.completeTask('explicit-purge');
    expect(store.purgeTask('explicit-purge')).toBe(true);
    expect(store.getTask('explicit-purge')).toBe(undefined);
    expect(store.purgeTask('unknown-task')).toBe(false);
    store.dispose();
  });

  it('can omit retained terminal response content from a status projection', () => {
    const clock = new ManualClock();
    const store = createStore(clock);
    createTask(store, 'response-projection', { initialState: 'working' });
    store.completeTask('response-projection', {
      content: { type: 'json', value: { answer: 42 } },
    });

    expect(store.getTask('response-projection', { includeTerminalResponse: false })).toEqual({
      requestId: 'response-projection',
      state: 'completed',
      terminalOutcome: 'completed',
      createdAt: '2026-08-07T10:00:00.000Z',
      updatedAt: '2026-08-07T10:00:00.000Z',
      expiresAt: '2026-08-07T10:01:00.000Z',
      cancellationRequested: false,
    });
    expect(store.getTask('response-projection', { includeTerminalResponse: true })).toMatchObject({
      content: { type: 'json', value: { answer: 42 } },
    });
    store.dispose();
  });
});
