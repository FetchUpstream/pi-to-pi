import { describe, expect, it } from 'vitest';

import {
  DEFAULT_REQUEST_TTL_MS,
  DEDUPE_RETENTION_GRACE_MS,
  MAX_CONTROL_TTL_MS,
} from '../../src/config.js';
import { createProtocolError } from '../../src/protocol/errors.js';
import {
  asRoomId,
  asRuntimeId,
  asSessionId,
  asTraceId,
  asUtcTimestamp,
  asUuidV4,
  type JsonObject,
  type JsonSchema,
  type ProtocolEnvelope,
} from '../../src/protocol/messages.js';
import {
  canonicalizeOperation,
  fingerprintOperation,
  makeDedupeKey,
  RuntimeScopedDedupeStore,
} from '../../src/router/dedupe.js';

// Fingerprint validation uses the default wall clock; keep the fixture live without
// mutating process-wide timers, while every store below uses an injected clock.
const BASE_NOW_MS = Date.now();
const ROOM_ID = `r1-${'a'.repeat(32)}`;
const OTHER_ROOM_ID = `r1-${'b'.repeat(32)}`;
const REQUEST_OPERATION_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_REQUEST_OPERATION_ID = '55555555-5555-4555-8555-555555555555';
const REPLY_OPERATION_ID = '22222222-2222-4222-8222-222222222222';
const REPLY_REQUEST_ID = '33333333-3333-4333-8333-333333333333';
const REPLY_CONFLICT_REQUEST_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PARENT_OPERATION_ID = '44444444-4444-4444-8444-444444444444';
const NOTIFY_OPERATION_ID = '66666666-6666-4666-8666-666666666666';
const CANCEL_OPERATION_ID = '77777777-7777-4777-8777-777777777777';
const SECOND_CANCEL_OPERATION_ID = '88888888-8888-4888-8888-888888888888';
const WORKING_CANCEL_OPERATION_ID = '99999999-9999-4999-8999-999999999999';
const SECOND_CANCEL_TARGET_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

type ExpectedResponseOverride = {
  readonly contentType: 'json';
  readonly schema: JsonSchema;
};

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
  readonly expectedResponse?: ExpectedResponseOverride;
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
      ...(overrides.expectedResponse === undefined
        ? {}
        : { expectedResponse: overrides.expectedResponse }),
      ...(overrides.metadata === undefined ? {} : { metadata: overrides.metadata }),
    },
  } as ProtocolEnvelope;
}

type ReplyOverrides = {
  readonly operationId?: string;
  readonly requestId?: string;
  readonly senderRuntimeId?: string;
  readonly recipientRuntimeId?: string;
  readonly roomId?: string;
  readonly createdAtMs?: number;
  readonly expiresAtMs?: number;
  readonly contentText?: string;
};

function makeReply(overrides: ReplyOverrides = {}): ProtocolEnvelope {
  const createdAtMs = overrides.createdAtMs ?? BASE_NOW_MS;
  const expiresAtMs = overrides.expiresAtMs ?? createdAtMs + DEFAULT_REQUEST_TTL_MS;

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
    roomId: asRoomId(overrides.roomId ?? ROOM_ID),
    createdAt: asUtcTimestamp(new Date(createdAtMs).toISOString()),
    expiresAt: asUtcTimestamp(new Date(expiresAtMs).toISOString()),
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

type NotifyOverrides = {
  readonly operationId?: string;
  readonly senderRuntimeId?: string;
  readonly recipientRuntimeId?: string;
  readonly roomId?: string;
  readonly createdAtMs?: number;
  readonly expiresAtMs?: number;
  readonly contentText?: string;
  readonly metadata?: JsonObject;
};

function makeNotify(overrides: NotifyOverrides = {}): ProtocolEnvelope {
  const createdAtMs = overrides.createdAtMs ?? BASE_NOW_MS;
  const expiresAtMs = overrides.expiresAtMs ?? createdAtMs + DEFAULT_REQUEST_TTL_MS;

  return {
    protocolVersion: '1.0',
    operation: 'message.notify',
    operationId: asUuidV4(overrides.operationId ?? NOTIFY_OPERATION_ID),
    sender: {
      sessionId: asSessionId('session-a'),
      runtimeId: asRuntimeId(overrides.senderRuntimeId ?? 'runtime-a'),
    },
    recipientRuntimeId: asRuntimeId(overrides.recipientRuntimeId ?? 'runtime-b'),
    roomId: asRoomId(overrides.roomId ?? ROOM_ID),
    createdAt: asUtcTimestamp(new Date(createdAtMs).toISOString()),
    expiresAt: asUtcTimestamp(new Date(expiresAtMs).toISOString()),
    traceId: asTraceId('b'.repeat(32)),
    payload: {
      content: {
        type: 'text',
        text: overrides.contentText ?? 'deliver this notification',
      },
      ...(overrides.metadata === undefined ? {} : { metadata: overrides.metadata }),
    },
  } as ProtocolEnvelope;
}

type CancelOverrides = {
  readonly operationId?: string;
  readonly requestId?: string;
  readonly senderRuntimeId?: string;
  readonly recipientRuntimeId?: string;
  readonly roomId?: string;
  readonly createdAtMs?: number;
  readonly expiresAtMs?: number;
  readonly reason?: string;
};

function makeCancel(overrides: CancelOverrides = {}): ProtocolEnvelope {
  const createdAtMs = overrides.createdAtMs ?? BASE_NOW_MS;
  const expiresAtMs = overrides.expiresAtMs ?? createdAtMs + MAX_CONTROL_TTL_MS;

  return {
    protocolVersion: '1.0',
    operation: 'task.cancel',
    operationId: asUuidV4(overrides.operationId ?? CANCEL_OPERATION_ID),
    requestId: asUuidV4(overrides.requestId ?? REQUEST_OPERATION_ID),
    sender: {
      sessionId: asSessionId('session-a'),
      runtimeId: asRuntimeId(overrides.senderRuntimeId ?? 'runtime-a'),
    },
    recipientRuntimeId: asRuntimeId(overrides.recipientRuntimeId ?? 'runtime-b'),
    roomId: asRoomId(overrides.roomId ?? ROOM_ID),
    createdAt: asUtcTimestamp(new Date(createdAtMs).toISOString()),
    expiresAt: asUtcTimestamp(new Date(expiresAtMs).toISOString()),
    traceId: asTraceId('d'.repeat(32)),
    payload: {
      ...(overrides.reason === undefined ? {} : { reason: overrides.reason }),
    },
  } as ProtocolEnvelope;
}

class ManualClock {
  private currentMs: number;
  private nextTimerId = 0;
  private readonly timers = new Map<
    number,
    { readonly at: number; readonly callback: () => void }
  >();

  public constructor(startMs: number) {
    this.currentMs = startMs;
  }

  public now = (): number => this.currentMs;

  public get pendingTimerCount(): number {
    return this.timers.size;
  }

  public setTimeout = (callback: () => void, delayMs: number): number => {
    const id = ++this.nextTimerId;
    this.timers.set(id, {
      at: this.currentMs + Math.max(0, delayMs),
      callback,
    });
    return id;
  };

  public clearTimeout = (handle: unknown): void => {
    this.timers.delete(handle as number);
  };

  public advanceBy(milliseconds: number): void {
    if (milliseconds < 0) {
      throw new RangeError('manual clock cannot move backwards');
    }

    const target = this.currentMs + milliseconds;
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
      this.currentMs = timer.at;
      timer.callback();
    }
    this.currentMs = target;
  }
}

function createStore<Outcome = unknown, TaskReference = unknown>(
  clock: ManualClock,
  options: { readonly runtimeId?: string } = {},
): RuntimeScopedDedupeStore<Outcome, TaskReference> {
  return new RuntimeScopedDedupeStore<Outcome, TaskReference>({
    ...options,
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
  });
}

describe('runtime-scoped deduplication', () => {
  it('uses sender runtime plus operation ID as the composite key', () => {
    const clock = new ManualClock(BASE_NOW_MS);
    const store = createStore<{ readonly state: 'accepted' }, { readonly taskId: string }>(clock);
    const mutations: string[] = [];
    const runtimeARequest = makeRequest({ senderRuntimeId: 'runtime-a' });
    const runtimeBRequest = makeRequest({ senderRuntimeId: 'runtime-c' });
    const sameSenderDifferentOperation = makeRequest({
      senderRuntimeId: 'runtime-a',
      operationId: OTHER_REQUEST_OPERATION_ID,
    });

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
    const differentOperation = store.execute(
      sameSenderDifferentOperation,
      () => {
        mutations.push('runtime-a-second-operation');
        return { state: 'accepted' };
      },
      { taskId: 'task-a-second-operation' },
    );

    expect(first.kind).toBe('stored');
    expect(identicalRetry.kind).toBe('replay');
    expect(differentRuntime.kind).toBe('stored');
    expect(differentOperation.kind).toBe('stored');
    expect(mutations).toEqual(['runtime-a', 'runtime-c', 'runtime-a-second-operation']);
    expect(store.size).toBe(3);
    expect(first.key).toBe(makeDedupeKey('runtime-a', REQUEST_OPERATION_ID));
    expect(differentRuntime.key).toBe(makeDedupeKey('runtime-c', REQUEST_OPERATION_ID));
    expect(differentOperation.key).toBe(makeDedupeKey('runtime-a', OTHER_REQUEST_OPERATION_ID));
    expect(store.getRecord(runtimeARequest)?.taskReference).toEqual({ taskId: 'task-a' });
    expect(store.getRecord(runtimeBRequest)?.taskReference).toEqual({ taskId: 'task-c' });
    expect(store.getRecord(sameSenderDifferentOperation)?.taskReference).toEqual({
      taskId: 'task-a-second-operation',
    });
    store.dispose();
  });

  it('fingerprints schemas and application metadata while excluding binding credentials', () => {
    const original = makeRequest();
    const schemaV1 = makeRequest({
      expectedResponse: {
        contentType: 'json',
        schema: {
          $schema: 'https://json-schema.org/draft/2020-12/schema',
          type: 'object',
          properties: { answer: { type: 'string' } },
        },
      },
    });
    const schemaV2 = makeRequest({
      expectedResponse: {
        contentType: 'json',
        schema: {
          $schema: 'https://json-schema.org/draft/2020-12/schema',
          type: 'object',
          properties: { answer: { type: 'number' } },
        },
      },
    });
    const applicationMetadataA = makeRequest({
      metadata: {
        token: 'application-token-a',
        credentials: { capability: 'read' },
      },
    });
    const applicationMetadataB = makeRequest({
      metadata: {
        token: 'application-token-b',
        credentials: { capability: 'read' },
      },
    });
    const originalFingerprint = fingerprintOperation(original, { token: 'binding-a' });
    const rotatedCredentialFingerprint = fingerprintOperation(original, {
      token: 'binding-b',
      capability: 'rotated',
    });
    const credentialFieldA = {
      ...original,
      bindingCredentials: { token: 'binding-a' },
    } as unknown as ProtocolEnvelope;
    const credentialFieldB = {
      ...original,
      bindingCredentials: { token: 'binding-b', capability: 'rotated' },
    } as unknown as ProtocolEnvelope;
    const metadataWithOneOrder = makeRequest({ metadata: { first: '1', second: '2' } });
    const metadataWithAnotherOrder = makeRequest({ metadata: { second: '2', first: '1' } });

    expect(rotatedCredentialFingerprint).toBe(originalFingerprint);
    expect(fingerprintOperation(credentialFieldA)).toBe(fingerprintOperation(credentialFieldB));
    expect(fingerprintOperation(schemaV1)).not.toBe(originalFingerprint);
    expect(fingerprintOperation(schemaV2)).not.toBe(fingerprintOperation(schemaV1));
    expect(fingerprintOperation(applicationMetadataA)).not.toBe(originalFingerprint);
    expect(fingerprintOperation(applicationMetadataB)).not.toBe(
      fingerprintOperation(applicationMetadataA),
    );
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
      makeRequest({ traceId: 'e'.repeat(32) }),
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
    const store = createStore<CachedOutcome, { readonly requestId: string }>(clock);
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
    store.dispose();
  });

  it('rejects a conflicting fingerprint without changing the original record or executing it', () => {
    const clock = new ManualClock(BASE_NOW_MS);
    const store = createStore<{ readonly state: 'accepted' }>(clock);
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
    expect(store.getRecord(original)?.fingerprint).toBe(first.fingerprint);
    store.dispose();
  });

  it('deduplicates message.notify retries and rejects conflicting notification content', () => {
    type NotifyOutcome = { readonly delivered: true };
    const clock = new ManualClock(BASE_NOW_MS);
    const store = createStore<NotifyOutcome>(clock);
    const notification = makeNotify({
      metadata: { token: 'application-token', credentials: { capability: 'notify' } },
    });
    const conflictingNotification = makeNotify({ contentText: 'different notification' });
    let deliveries = 0;
    let stateMutations = 0;
    const deliver = (): NotifyOutcome => {
      deliveries += 1;
      stateMutations += 1;
      return { delivered: true };
    };

    const first = store.execute(notification, deliver);
    const identicalRetry = store.execute(notification, deliver);
    const conflictingRetry = store.execute(conflictingNotification, deliver);

    expect(first.kind).toBe('stored');
    expect(identicalRetry.kind).toBe('replay');
    expect(conflictingRetry.kind).toBe('duplicate');
    expect(conflictingRetry.error?.code).toBe('duplicate');
    expect(deliveries).toBe(1);
    expect(stateMutations).toBe(1);
    expect(store.getRecord(notification)?.result).toEqual({ delivered: true });
    store.dispose();
  });

  it('deduplicates task.cancel retries and keeps cancellation idempotent by target state', () => {
    type CancelState = 'queued' | 'working' | 'cancelling' | 'cancelled';
    type CancelOutcome = {
      readonly snapshot: { readonly requestId: string; readonly state: CancelState };
    };
    const clock = new ManualClock(BASE_NOW_MS);
    const store = createStore<CancelOutcome>(clock);
    const cancellation = makeCancel({ reason: 'stop queued task' });
    const conflictingCancellation = makeCancel({ reason: 'different reason' });
    const retryAfterCancellation = makeCancel({
      operationId: SECOND_CANCEL_OPERATION_ID,
      reason: 'repeat after terminal state',
    });
    let taskState: CancelState = 'queued';
    let stateTransitions = 0;

    const cancelTask = (operation: ProtocolEnvelope): CancelOutcome => {
      if (taskState === 'queued') {
        taskState = 'cancelled';
        stateTransitions += 1;
      }
      return {
        snapshot: {
          requestId: operation.requestId as string,
          state: taskState,
        },
      };
    };

    const first = store.execute(cancellation, () => cancelTask(cancellation));
    const identicalRetry = store.execute(cancellation, () => cancelTask(cancellation));
    const conflictingRetry = store.execute(conflictingCancellation, () => cancelTask(cancellation));
    const idempotentRetry = store.execute(retryAfterCancellation, () =>
      cancelTask(retryAfterCancellation),
    );

    expect(first.kind).toBe('stored');
    expect(first.result?.snapshot).toEqual({
      requestId: REQUEST_OPERATION_ID,
      state: 'cancelled',
    });
    expect(identicalRetry.kind).toBe('replay');
    expect(conflictingRetry.kind).toBe('duplicate');
    expect(conflictingRetry.error?.code).toBe('duplicate');
    expect(idempotentRetry.kind).toBe('stored');
    expect(idempotentRetry.result?.snapshot).toEqual({
      requestId: REQUEST_OPERATION_ID,
      state: 'cancelled',
    });
    expect(taskState).toBe('cancelled');
    expect(stateTransitions).toBe(1);

    const workingCancellation = makeCancel({
      operationId: WORKING_CANCEL_OPERATION_ID,
      requestId: SECOND_CANCEL_TARGET_ID,
      reason: 'stop working task',
    });
    let workingState: CancelState = 'working';
    let workingTransitions = 0;
    const transitionWorkingTask = (): CancelOutcome => {
      if (workingState === 'working') {
        workingState = 'cancelling';
        workingTransitions += 1;
      }
      return {
        snapshot: { requestId: SECOND_CANCEL_TARGET_ID, state: workingState },
      };
    };
    const workingFirst = store.execute(workingCancellation, transitionWorkingTask);
    const workingRetry = store.execute(workingCancellation, transitionWorkingTask);

    expect(workingFirst.kind).toBe('stored');
    expect(workingFirst.result?.snapshot.state).toBe('cancelling');
    expect(workingRetry.kind).toBe('replay');
    expect(workingTransitions).toBe(1);
    expect(workingState).toBe('cancelling');
    store.dispose();
  });

  it('replays duplicate replies without applying a second terminal transition', () => {
    type ReplyOutcome = {
      readonly delivered: true;
      readonly outcome: 'completed';
    };
    const clock = new ManualClock(BASE_NOW_MS);
    const store = createStore<ReplyOutcome>(clock);
    const reply = makeReply();
    let taskState: 'working' | 'completed' = 'working';
    let terminalTransitions = 0;
    const deliver = (): ReplyOutcome => {
      terminalTransitions += 1;
      taskState = 'completed';
      return { delivered: true, outcome: 'completed' };
    };

    const first = store.execute(reply, deliver);
    const retry = store.execute(reply, deliver);
    const conflictingTarget = store.execute(
      makeReply({ requestId: REPLY_CONFLICT_REQUEST_ID }),
      deliver,
    );

    expect(first.kind).toBe('stored');
    expect(retry.kind).toBe('replay');
    expect(retry.result).toEqual({ delivered: true, outcome: 'completed' });
    expect(conflictingTarget.kind).toBe('duplicate');
    expect(conflictingTarget.error?.code).toBe('duplicate');
    expect(terminalTransitions).toBe(1);
    expect(taskState).toBe('completed');
    expect(store.getRecord(reply)?.result).toEqual({ delivered: true, outcome: 'completed' });
    store.dispose();
  });

  it('returns pending for a deterministic reentrant retry and mutates state once', () => {
    type AdmissionOutcome = { readonly state: 'accepted' };
    const clock = new ManualClock(BASE_NOW_MS);
    const store = createStore<AdmissionOutcome>(clock);
    const operation = makeRequest();
    let producerCalls = 0;
    let stateMutations = 0;
    let taskState: 'created' | 'accepted' = 'created';
    let reentrantRetry: ReturnType<typeof store.execute> | undefined;

    const first = store.execute(operation, () => {
      producerCalls += 1;
      stateMutations += 1;
      taskState = 'accepted';
      reentrantRetry = store.execute(operation, () => {
        producerCalls += 1;
        stateMutations += 1;
        taskState = 'accepted';
        return { state: 'accepted' };
      });
      return { state: 'accepted' };
    });

    expect(first.kind).toBe('stored');
    expect(reentrantRetry).toMatchObject({
      kind: 'pending',
      status: 'pending',
      action: 'retry',
      key: makeDedupeKey('runtime-a', REQUEST_OPERATION_ID),
    });
    expect(producerCalls).toBe(1);
    expect(stateMutations).toBe(1);
    expect(taskState).toBe('accepted');
    expect(store.getRecord(operation)?.pending).toBe(false);
    store.dispose();
  });

  it('releases an execute reservation when the producer returns busy before retrying', () => {
    const clock = new ManualClock(BASE_NOW_MS);
    const store = createStore<unknown>(clock);
    const operation = makeRequest();
    let executions = 0;

    const busy = store.execute(operation, () => {
      executions += 1;
      return createProtocolError('busy', 'executor is temporarily busy', { retryAfterMs: 25 });
    });

    expect(busy.kind).toBe('busy');
    expect(busy.action).toBe('retry');
    expect(busy.error).toMatchObject({ code: 'busy', retryable: true });
    expect(store.size).toBe(0);
    expect(store.inspect(operation).kind).toBe('new');
    expect(clock.pendingTimerCount).toBe(0);

    const retry = store.execute(operation, () => {
      executions += 1;
      return { state: 'accepted' };
    });
    const identicalRetry = store.execute(operation, () => {
      executions += 1;
      return { state: 'accepted' };
    });

    expect(retry.kind).toBe('stored');
    expect(identicalRetry.kind).toBe('replay');
    expect(executions).toBe(2);
    expect(store.size).toBe(1);
    store.dispose();
  });

  it('retains records through expiry plus grace and runs scheduled cleanup at the exact boundary', () => {
    const clock = new ManualClock(BASE_NOW_MS);
    const store = createStore<{ readonly delivered: true }>(clock);
    const operation = makeRequest({ expiresAtMs: BASE_NOW_MS + DEFAULT_REQUEST_TTL_MS });

    store.execute(operation, () => ({ delivered: true }));
    const record = store.getRecord(operation);
    const expiryMs = BASE_NOW_MS + DEFAULT_REQUEST_TTL_MS;
    const retentionDeadlineMs = expiryMs + DEDUPE_RETENTION_GRACE_MS;

    expect(record?.retainedUntil).toBe(retentionDeadlineMs);
    expect(clock.pendingTimerCount).toBe(1);

    clock.advanceBy(DEFAULT_REQUEST_TTL_MS + DEDUPE_RETENTION_GRACE_MS - 1);
    expect(clock.now()).toBe(retentionDeadlineMs - 1);
    expect(clock.pendingTimerCount).toBe(1);
    expect(store.size).toBe(1);
    expect(store.inspect(operation).kind).toBe('replay');

    clock.advanceBy(1);
    expect(clock.now()).toBe(retentionDeadlineMs);
    expect(clock.pendingTimerCount).toBe(0);
    expect(store.size).toBe(0);
    expect(store.inspect(operation).kind).toBe('new');
    store.dispose();
  });

  it('starts a fresh empty dedupe scope for a replacement runtime', () => {
    const clock = new ManualClock(BASE_NOW_MS);
    const operation = makeRequest();
    const oldRuntime = createStore<{ readonly state: 'accepted' }>(clock, {
      runtimeId: 'runtime-old',
    });
    let oldExecutions = 0;
    oldRuntime.execute(operation, () => {
      oldExecutions += 1;
      return { state: 'accepted' };
    });

    const replacementRuntime = createStore<{ readonly state: 'accepted' }>(clock, {
      runtimeId: 'runtime-new',
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
    oldRuntime.dispose();
    replacementRuntime.dispose();
  });
});
