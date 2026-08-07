import { describe, expect, it } from 'vitest';

import { RuntimePersistence } from '../../src/pi/persistence.js';
import { deriveRoomId } from '../../src/room.js';
import { validateEnvelope } from '../../src/protocol/validation.js';
import {
  asRoomId,
  asRuntimeId,
  asSessionId,
  asTraceId,
  asUtcTimestamp,
  asUuidV4,
  type ProtocolEnvelope,
} from '../../src/protocol/messages.js';

const SESSION_ID = asSessionId('session-reload');
const OLD_RUNTIME_ID = asRuntimeId('runtime-old');
const NEW_RUNTIME_ID = asRuntimeId('runtime-new');
const DESTINATION_RUNTIME_ID = asRuntimeId('runtime-destination');
const ROOM_ID = deriveRoomId('explicit', 'reload-integration');
const REQUEST_ID = asUuidV4('90000000-0000-4000-8000-000000000001');
const OPERATION_ID = asUuidV4('90000000-0000-4000-8000-000000000002');

function requestEnvelope(now: number): ProtocolEnvelope {
  return {
    protocolVersion: '1.0',
    operation: 'message.request',
    operationId: REQUEST_ID,
    requestId: REQUEST_ID,
    sender: { sessionId: SESSION_ID, runtimeId: OLD_RUNTIME_ID },
    recipientRuntimeId: DESTINATION_RUNTIME_ID,
    roomId: asRoomId(ROOM_ID),
    createdAt: asUtcTimestamp(new Date(now - 1_000).toISOString()),
    expiresAt: asUtcTimestamp(new Date(now + 60_000).toISOString()),
    traceId: asTraceId('b'.repeat(32)),
    payload: { content: { type: 'text', text: 'accepted before reload' } },
  } as ProtocolEnvelope;
}

describe('runtime replacement boundaries', () => {
  it('does not adopt active tasks or dedupe records and fences old operation IDs', async () => {
    const now = Date.now();
    const clock = () => now;
    const oldRuntime = new RuntimePersistence({
      identity: { sessionId: SESSION_ID, runtimeId: OLD_RUNTIME_ID },
      now: clock,
      dedupeStoreOptions: { now: clock },
    });
    const task = oldRuntime.taskStore.createTask({
      requestId: REQUEST_ID,
      operationId: OPERATION_ID,
      owner: { runtimeId: OLD_RUNTIME_ID, sessionId: SESSION_ID },
      createdAt: now - 1_000,
      expiresAt: now + 60_000,
      initialState: 'working',
    });
    const operation = requestEnvelope(now);
    const validation = validateEnvelope(operation, { now });
    expect(validation).toMatchObject({ ok: true });
    const dedupe = oldRuntime.dedupeStore.execute(
      operation,
      () => ({ accepted: true }),
      REQUEST_ID,
    );
    oldRuntime.recordAcceptedOperation(
      OPERATION_ID,
      DESTINATION_RUNTIME_ID,
      operation.expiresAt,
      OLD_RUNTIME_ID,
    );

    expect(task).toMatchObject({ requestId: REQUEST_ID, state: 'working' });
    expect(dedupe.kind).toBe('stored');
    expect(oldRuntime.taskStore.size).toBe(1);
    expect(oldRuntime.dedupeStore.size).toBe(1);

    const replacement = oldRuntime.reload({
      identity: { sessionId: SESSION_ID, runtimeId: NEW_RUNTIME_ID },
    });
    const previousShutdown = replacement.previousRuntimeShutdown;
    if (previousShutdown !== undefined) {
      await previousShutdown;
    }

    expect(oldRuntime.closed).toBe(true);
    expect(replacement.identity.sessionId).toBe(SESSION_ID);
    expect(replacement.identity.runtimeId).toBe(NEW_RUNTIME_ID);
    expect(replacement.taskStore.size).toBe(0);
    expect(replacement.taskStore.getTask(REQUEST_ID)).toBeUndefined();
    expect(replacement.dedupeStore.size).toBe(0);
    expect(() => replacement.assertReplayAllowed(OPERATION_ID, DESTINATION_RUNTIME_ID)).toThrow(
      /new operationId/i,
    );
    expect(replacement.createRetryOperationId(OPERATION_ID, DESTINATION_RUNTIME_ID)).not.toBe(
      OPERATION_ID,
    );

    await replacement.close();
  });
});
