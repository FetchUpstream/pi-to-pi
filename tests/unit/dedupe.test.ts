import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_REQUEST_TTL_MS, DEDUPE_RETENTION_GRACE_MS } from '../../src/config.js';
import { createProtocolError } from '../../src/protocol/errors.js';
import {
  asRoomId,
  asRuntimeId,
  asSessionId,
  asTraceId,
  asUtcTimestamp,
  asUuidV4,
  type JsonObject,
  type ProtocolEnvelope,
} from '../../src/protocol/messages.js';
import {
  canonicalizeOperation,
  fingerprintOperation,
  makeDedupeKey,
  RuntimeScopedDedupeStore,
} from '../../src/router/dedupe.js';

const BASE_NOW_MS = Date.parse('2026-08-07T10:00:00.000Z');
const ROOM_ID = `r1-${'a'.repeat(32)}`;
const OTHER_ROOM_ID = `r1-${'b'.repeat(32)}`;
const REQUEST_OPERATION_ID = '11111111-1111-4111-8111-111111111111';
const REPLY_OPERATION_ID = '22222222-2222-4222-8222-222222222222';
const REPLY_REQUEST_ID = '33333333-3333-4333-8333-333333333333';
const PARENT_OPERATION_ID = '44444444-4444-4444-8444-444444444444';

type RequestOverrides = {
  readonly operationId?: string;
  readonly senderRuntimeId?: string;
  readonly sessionId?: string;
  readonly recipientRuntimeId?: string;
  readonly roomId?: string;
  readonly createdAtMs?: number;
  readonly expiresAtMs?: number;
  readonly traceId?: string;
  readonly parentOperationId?: string;
  readonly contentText?: string;
  readonly metadata?: JsonObject;
};

function makeRequest(overrides: RequestOverrides = {}): ProtocolEnvelope {
  const operationId = asUuidV4(overrides.operationId ?? REQUEST_OPERATION_ID);
  const createdAtMs = overrides.createdAtMs ?? BASE_NOW_MS;
  const expiresAtMs = overrides.expiresAtMs ?? createdAtMs + DEFAULT_REQUEST_TTL_MS;

  return {
    protocolVersion: '1.0',
    operation: 'message.request',
    operationId,
    requestId: operationId,
    sender: {
      sessionId: asSessionId(overrides.sessionId ?? 'session-a'),
      runtimeId: asRuntimeId(overrides.senderRuntimeId ?? 'runtime-a'),
    },
    recipientRuntimeId: asRuntimeId(overrides.recipientRuntimeId ?? 'runtime-b'),
    roomId: asRoomId(overrides.roomId ?? ROOM_ID),
    createdAt: asUtcTimestamp(new Date(createdAtMs).toISOString()),
    expiresAt: asUtcTimestamp(new Date(expiresAtMs).toISOString()),
    traceId: asTraceId(overrides.traceId ?? 'a'.repeat(32)),
    ...(overrides.parentOperationId === undefined
      ? {}
      : { parentOperationId: asUuidV4(overrides.parentOperationId) }),
    payload: {
      content: {
        type: 'text',
        text: overrides.contentText ?? 'retry this request',
      },
      ...(overrides.metadata === undefined ? {} : { metadata: overrides.metadata }),
    },
  } as ProtocolEnvelope;
}

type ReplyOverrides = {
  readonly operationId?: string;
  readonly requestId?: string;
  readonly senderRuntimeId?: string;
  readonly recipientRuntimeId?: string;
  readonly contentText?: string;
};

function makeReply(overrides: ReplyOverrides = {}): ProtocolEnvelope {
  return {
    protocolVersion: '1.0',
    operation: 'message.reply',
    operationId: asUuidV4(overrides.operationId ?? REPLY_OPERATION_ID),
    requestId: asUuidV4(overrides.requestId ?? REPLY_REQUEST_ID),
    sender: {
      sessionId: asSessionId('session-b'),
      runtimeId: asRuntimeId(overrides.senderRuntimeId ?? 'runtime-b'),
    },
    recipientRuntimeId: asRuntimeId(overrides.recipientRuntimeId ?? 'runtime-a'),
    roomId: asRoomId(ROOM_ID),
    createdAt: asUtcTimestamp(new Date(BASE_NOW_MS).toISOString()),
    expiresAt: asUtcTimestamp(new Date(BASE_NOW_MS + DEFAULT_REQUEST_TTL_MS).toISOString()),
    traceId: asTraceId('c'.repeat(32)),
    payload: {
      outcome: 'completed',
      content: {
        type: 'text',
        text: overrides.contentText ?? 'completed',
      },
    },
  } as ProtocolEnvelope;
}

class ManualClock {
  private currentMs: number;
  private nextTimerId = 0;

  public constructor(startMs: number) {
    this.currentMs = startMs;
  }

  public now = (): number => this.currentMs;

  public advance(milliseconds: number): void {
    this.currentMs += milliseconds;
  }

  public setTimeout = (callback: () => void, delayMs: number): number => {
    void callback;
    void delayMs;
    this.nextTimerId += 1;
    return this.nextTimerId;
  };

  public clearTimeout = (handle: unknown): void => {
    void handle;
  };
}

describe('runtime-scoped deduplication', () => {
  beforeEach(() => vi.useFakeTimers({ now: BASE_NOW_MS }));
  afterEach(() => vi.useRealTimers());
  it('uses sender runtime plus operation ID as the composite key', () => {
    const clock = new ManualClock(BASE_NOW_MS);
    const store = new RuntimeScopedDedupeStore<
      { readonly state: 'accepted' },
      { readonly taskId: string }
    >({
      now: clock.now,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
    });
    const mutations: string[] = [];
    const runtimeARequest = makeRequest({ senderRuntimeId: 'runtime-a' });
    const runtimeBRequest = makeRequest({ senderRuntimeId: 'runtime-c' });

    const first = store.execute(
      runtimeARequest,
      () => {
        mutations.push('runtime-a');
        return { state: 'accepted' };
      },
      { taskId: 'task-a' },
    );
    const identicalRetry = store.execute(
      runtimeARequest,
      () => {
        mutations.push('duplicate-runtime-a');
        return { state: 'accepted' };
      },
      { taskId: 'duplicate-task-a' },
    );
    const differentRuntime = store.execute(
      runtimeBRequest,
      () => {
        mutations.push('runtime-c');
        return { state: 'accepted' };
      },
      { taskId: 'task-c' },
    );

    expect(first.kind).toBe('stored');
    expect(identicalRetry.kind).toBe('replay');
    expect(differentRuntime.kind).toBe('stored');
    expect(mutations).toEqual(['runtime-a', 'runtime-c']);
    expect(store.size).toBe(2);
    expect(first.key).toBe(makeDedupeKey('runtime-a', REQUEST_OPERATION_ID));
    expect(differentRuntime.key).toBe(makeDedupeKey('runtime-c', REQUEST_OPERATION_ID));
    expect(store.getRecord(runtimeARequest)?.taskReference).toEqual({ taskId: 'task-a' });
    expect(store.getRecord(runtimeBRequest)?.taskReference).toEqual({ taskId: 'task-c' });
  });

  it('fingerprints immutable operation data canonically while excluding binding credentials', () => {
    const original = makeRequest();
    const originalFingerprint = fingerprintOperation(original, { token: 'credential-a' });
    const rotatedCredentialFingerprint = fingerprintOperation(original, {
      token: 'credential-b',
      capability: 'rotated',
    });
    const credentialFieldA = {
      ...original,
      bindingCredentials: { token: 'credential-a' },
    } as unknown as ProtocolEnvelope;
    const credentialFieldB = {
      ...original,
      bindingCredentials: { token: 'credential-b' },
    } as unknown as ProtocolEnvelope;
    const metadataWithOneOrder = makeRequest({ metadata: { first: '1', second: '2' } });
    const metadataWithAnotherOrder = makeRequest({ metadata: { second: '2', first: '1' } });

    expect(rotatedCredentialFingerprint).toBe(originalFingerprint);
    expect(fingerprintOperation(credentialFieldA)).toBe(fingerprintOperation(credentialFieldB));
    expect(canonicalizeOperation(metadataWithOneOrder)).toBe(
      canonicalizeOperation(metadataWithAnotherOrder),
    );

    const immutableChanges = [
      makeRequest({ contentText: 'different content' }),
      makeRequest({ senderRuntimeId: 'runtime-c' }),
      makeRequest({ sessionId: 'session-c' }),
      makeRequest({ recipientRuntimeId: 'runtime-c' }),
      makeRequest({ roomId: OTHER_ROOM_ID }),
      makeRequest({
        createdAtMs: BASE_NOW_MS + 1_000,
        expiresAtMs: BASE_NOW_MS + 1_000 + DEFAULT_REQUEST_TTL_MS,
      }),
      makeRequest({ expiresAtMs: BASE_NOW_MS + DEFAULT_REQUEST_TTL_MS + 1_000 }),
      makeRequest({ traceId: 'd'.repeat(32) }),
      makeRequest({ parentOperationId: PARENT_OPERATION_ID }),
      makeRequest({ metadata: { changed: true } }),
    ];

    for (const changedOperation of immutableChanges) {
      expect(fingerprintOperation(changedOperation)).not.toBe(originalFingerprint);
    }
  });

  it('replays cached admission outcomes without repeating execution or state mutation', () => {
    type CachedOutcome = { state: 'accepted'; attempt: number };
    const clock = new ManualClock(BASE_NOW_MS);
    const store = new RuntimeScopedDedupeStore<CachedOutcome, { readonly requestId: string }>({
      now: clock.now,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
    });
    const operation = makeRequest();
    let taskState: 'created' | 'accepted' = 'created';
    let transitions = 0;
    const firstOutcome: CachedOutcome = { state: 'accepted', attempt: 1 };

    const first = store.execute(
      operation,
      () => {
        transitions += 1;
        taskState = 'accepted';
        return firstOutcome;
      },
      { requestId: 'request-a' },
    );
    firstOutcome.attempt = 99;
    const retry = store.execute(
      operation,
      () => {
        transitions += 1;
        taskState = 'accepted';
        return { state: 'accepted', attempt: 2 };
      },
      { requestId: 'request-b' },
    );

    expect(first.kind).toBe('stored');
    expect(retry.kind).toBe('replay');
    expect(retry.result).toEqual({ state: 'accepted', attempt: 1 });
    expect(retry.taskReference).toEqual({ requestId: 'request-a' });
    expect(transitions).toBe(1);
    expect(taskState).toBe('accepted');
  });

  it('rejects a conflicting fingerprint without changing the original record or executing it', () => {
    const clock = new ManualClock(BASE_NOW_MS);
    const store = new RuntimeScopedDedupeStore<{ readonly state: 'accepted' }>({
      now: clock.now,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
    });
    const original = makeRequest();
    const conflicting = makeRequest({ contentText: 'conflicting content' });
    let transitions = 0;
    let taskState: 'created' | 'accepted' = 'created';

    const first = store.execute(original, () => {
      transitions += 1;
      taskState = 'accepted';
      return { state: 'accepted' };
    });
    const duplicate = store.execute(conflicting, () => {
      transitions += 1;
      taskState = 'accepted';
      return { state: 'accepted' };
    });

    expect(first.kind).toBe('stored');
    expect(duplicate.kind).toBe('duplicate');
    expect(duplicate.error?.code).toBe('duplicate');
    expect(transitions).toBe(1);
    expect(taskState).toBe('accepted');
    expect(store.getRecord(original)?.result).toEqual({ state: 'accepted' });
    expect(store.getRecord(original)?.fingerprint).toBe(fingerprintOperation(original));
  });

  it('replays duplicate replies without applying a second terminal transition', () => {
    const clock = new ManualClock(BASE_NOW_MS);
    const store = new RuntimeScopedDedupeStore<{
      readonly delivered: true;
      readonly outcome: 'completed';
    }>({
      now: clock.now,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
    });
    const reply = makeReply();
    let taskState: 'working' | 'completed' = 'working';
    let terminalTransitions = 0;
    const deliver = (): { readonly delivered: true; readonly outcome: 'completed' } => {
      terminalTransitions += 1;
      taskState = 'completed';
      return { delivered: true, outcome: 'completed' };
    };

    const first = store.execute(reply, deliver);
    const retry = store.execute(reply, deliver);

    expect(first.kind).toBe('stored');
    expect(retry.kind).toBe('replay');
    expect(retry.result).toEqual({ delivered: true, outcome: 'completed' });
    expect(terminalTransitions).toBe(1);
    expect(taskState).toBe('completed');
  });

  it('does not reserve an operation for a transient busy response', () => {
    const clock = new ManualClock(BASE_NOW_MS);
    const store = new RuntimeScopedDedupeStore<unknown>({
      now: clock.now,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
    });
    const operation = makeRequest();
    let executions = 0;

    const busy = store.admit(
      operation,
      createProtocolError('busy', 'queue is full', { retryAfterMs: 25 }),
    );

    expect(busy.kind).toBe('busy');
    expect(busy.action).toBe('retry');
    expect(busy.error).toMatchObject({ code: 'busy', retryable: true });
    expect(store.size).toBe(0);
    expect(store.inspect(operation).kind).toBe('new');

    const retry = store.execute(operation, () => {
      executions += 1;
      return { state: 'accepted' };
    });

    expect(retry.kind).toBe('stored');
    expect(executions).toBe(1);
    expect(store.size).toBe(1);
  });

  it('retains records through expiry plus ten-minute grace, then removes them during cleanup', () => {
    const clock = new ManualClock(BASE_NOW_MS);
    const store = new RuntimeScopedDedupeStore<{ readonly delivered: true }>({
      now: clock.now,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
    });
    const operation = makeRequest({ expiresAtMs: BASE_NOW_MS + DEFAULT_REQUEST_TTL_MS });

    store.execute(operation, () => ({ delivered: true }));
    const record = store.getRecord(operation);
    const expiryMs = BASE_NOW_MS + DEFAULT_REQUEST_TTL_MS;
    const retentionDeadlineMs = expiryMs + DEDUPE_RETENTION_GRACE_MS;

    expect(record?.retainedUntil).toBe(retentionDeadlineMs);

    clock.advance(DEFAULT_REQUEST_TTL_MS);
    expect(store.size).toBe(1);
    clock.advance(DEDUPE_RETENTION_GRACE_MS - 1);
    expect(store.size).toBe(1);
    expect(store.inspect(operation).kind).toBe('replay');
    clock.advance(1);
    expect(store.cleanup()).toBe(1);
    expect(store.size).toBe(0);
    expect(store.cleanup()).toBe(0);
  });

  it('starts a fresh empty dedupe scope for a replacement runtime', () => {
    const clock = new ManualClock(BASE_NOW_MS);
    const operation = makeRequest();
    const oldRuntime = new RuntimeScopedDedupeStore<{ readonly state: 'accepted' }>({
      runtimeId: 'runtime-old',
      now: clock.now,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
    });
    let oldExecutions = 0;
    oldRuntime.execute(operation, () => {
      oldExecutions += 1;
      return { state: 'accepted' };
    });

    const replacementRuntime = new RuntimeScopedDedupeStore<{ readonly state: 'accepted' }>({
      runtimeId: 'runtime-new',
      now: clock.now,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
    });
    let replacementExecutions = 0;

    expect(replacementRuntime.size).toBe(0);
    expect(replacementRuntime.inspect(operation).kind).toBe('new');
    const replacementAdmission = replacementRuntime.execute(operation, () => {
      replacementExecutions += 1;
      return { state: 'accepted' };
    });

    expect(replacementAdmission.kind).toBe('stored');
    expect(oldRuntime.inspect(operation).kind).toBe('replay');
    expect(oldExecutions).toBe(1);
    expect(replacementExecutions).toBe(1);
  });
});
