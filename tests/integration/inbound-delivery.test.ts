import { describe, expect, it } from 'vitest';
import { fauxAssistantMessage } from '@earendil-works/pi-ai';
import { SettingsManager, type AgentSessionEvent } from '@earendil-works/pi-coding-agent';
import { createPersistedPiSessionFixture } from '../fixtures/index.js';
import { createRequestCorrelation } from './request-correlation.js';

const INBOUND_TYPE = 'p2p.inbound';
type PersistedFixture = Awaited<ReturnType<typeof createPersistedPiSessionFixture>>;

function customInboundEntries(fixture: PersistedFixture) {
  return fixture.entries.filter(
    (entry) => entry.type === 'custom_message' && entry.customType === INBOUND_TYPE,
  );
}

function waitForSessionEvent(
  fixture: PersistedFixture,
  predicate: (event: AgentSessionEvent) => boolean,
  timeoutMs = 2_000,
): Promise<AgentSessionEvent> {
  return new Promise((resolve, reject) => {
    const unsubscribe = fixture.session.subscribe((event) => {
      if (!predicate(event)) {
        return;
      }
      clearTimeout(timeout);
      unsubscribe();
      resolve(event);
    });
    const timeout = setTimeout(() => {
      unsubscribe();
      reject(new Error('Timed out waiting for the expected Pi fixture event'));
    }, timeoutMs);
  });
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolvePromise!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}

async function disposeFixture(fixture: PersistedFixture, pending?: Promise<void>): Promise<void> {
  try {
    await pending?.catch(() => undefined);
    await fixture.waitForIdle().catch(() => undefined);
  } finally {
    await fixture.dispose();
  }
}

describe('correlated inbound delivery', () => {
  it('registers before idle triggerTurn delivery and preserves an opaque request ID', async () => {
    const fixture = await createPersistedPiSessionFixture({
      responses: [fauxAssistantMessage('idle response')],
    });
    const correlation = createRequestCorrelation();
    const requestId = 'opaque/request-a::7f';
    correlation.accept(fixture, requestId);
    expect(correlation.events).toEqual([{ type: 'registered', requestId }]);

    try {
      const delivery = correlation.deliver(fixture, requestId, 'idle request body', {
        triggerTurn: true,
      });
      await delivery;
      const registeredIndex = correlation.events.findIndex(
        (event) => event.type === 'registered' && event.requestId === requestId,
      );
      const deliveredIndex = correlation.events.findIndex(
        (event) => event.type === 'delivered' && event.requestId === requestId,
      );
      expect(registeredIndex).toBeGreaterThanOrEqual(0);
      expect(deliveredIndex).toBeGreaterThan(registeredIndex);

      expect(fixture.probe.byType('agent_start')).toHaveLength(1);
      const starts = fixture.probe.byType('custom_message_start');
      const ends = fixture.probe.byType('custom_message_end');
      expect(starts).toHaveLength(1);
      expect(ends).toHaveLength(1);
      expect(starts[0]?.details).toEqual({ requestId });
      expect(ends[0]?.details).toEqual({ requestId });
      expect(starts[0]?.message).toMatchObject({
        role: 'custom',
        customType: INBOUND_TYPE,
        details: { requestId },
      });

      const entries = customInboundEntries(fixture);
      expect(entries).toHaveLength(1);
      expect(entries[0]?.type).toBe('custom_message');
      if (entries[0]?.type !== 'custom_message') {
        throw new Error('Expected a persisted custom-message entry');
      }
      expect(entries[0].details).toEqual({ requestId });
    } finally {
      await disposeFixture(fixture);
    }
  });

  it('processes busy steering before follow-up while retaining independent request metadata', async () => {
    const firstResponse = deferred<ReturnType<typeof fauxAssistantMessage>>();
    const fixture = await createPersistedPiSessionFixture({
      responses: [
        () => firstResponse.promise,
        fauxAssistantMessage('steer response'),
        fauxAssistantMessage('follow-up response'),
      ],
    });
    const correlation = createRequestCorrelation();
    const initialId = 'opaque/request-initial';
    const steerId = 'opaque/request-steer';
    const followUpId = 'opaque/request-follow-up';
    correlation.accept(fixture, initialId);
    correlation.accept(fixture, steerId);
    correlation.accept(fixture, followUpId);

    let initialDelivery: Promise<void> | undefined;
    try {
      initialDelivery = correlation.deliver(fixture, initialId, 'initial request body', {
        triggerTurn: true,
      });
      await waitForSessionEvent(fixture, (event) => event.type === 'agent_start');
      expect(fixture.session.isStreaming).toBe(true);

      await expect(
        correlation.deliver(fixture, initialId, 'duplicate initial request body', {
          deliverAs: 'steer',
        }),
      ).rejects.toThrow('Request ID is already being delivered: opaque/request-initial');

      await correlation.deliver(fixture, steerId, 'steering request body', {
        deliverAs: 'steer',
      });
      await correlation.deliver(fixture, followUpId, 'follow-up request body', {
        deliverAs: 'followUp',
      });
      expect(correlation.events.filter((event) => event.type === 'registered')).toEqual([
        { type: 'registered', requestId: initialId },
        { type: 'registered', requestId: steerId },
        { type: 'registered', requestId: followUpId },
      ]);

      firstResponse.resolve(fauxAssistantMessage('initial response'));
      await initialDelivery;

      const customStarts = fixture.probe.byType('custom_message_start');
      expect(customStarts.map((observation) => observation.details)).toEqual([
        { requestId: initialId },
        { requestId: steerId },
        { requestId: followUpId },
      ]);
      const customStartIds = customStarts.map((observation) => {
        if (
          !observation.details ||
          typeof observation.details !== 'object' ||
          !('requestId' in observation.details)
        ) {
          throw new Error('Expected an inbound request ID in custom-message details');
        }
        return observation.details.requestId;
      });
      expect(customStartIds.indexOf(steerId)).toBeLessThan(customStartIds.indexOf(followUpId));

      const customEndIds = fixture.probe.byType('custom_message_end').map((observation) => {
        if (
          !observation.details ||
          typeof observation.details !== 'object' ||
          !('requestId' in observation.details)
        ) {
          throw new Error('Expected an inbound request ID in custom-message details');
        }
        return observation.details.requestId;
      });
      expect(customEndIds).toEqual([initialId, steerId, followUpId]);

      const entries = customInboundEntries(fixture);
      expect(entries).toHaveLength(3);
      expect(
        entries.map((entry) => (entry.type === 'custom_message' ? entry.details : undefined)),
      ).toEqual([{ requestId: initialId }, { requestId: steerId }, { requestId: followUpId }]);
    } finally {
      firstResponse.resolve(fauxAssistantMessage('initial response after cleanup'));
      await disposeFixture(fixture, initialDelivery);
    }
  });

  it('correlates replies only by explicit request ID and rejects unknown or repeated transitions', async () => {
    const fixture = await createPersistedPiSessionFixture();
    const correlation = createRequestCorrelation();
    const requestA = 'opaque/request-a';
    const requestB = 'opaque/request-b';
    correlation.accept(fixture, requestA);
    correlation.accept(fixture, requestB);

    try {
      await correlation.deliver(fixture, requestA, 'request A body');
      await correlation.deliver(fixture, requestB, 'request B body');
      expect(correlation.state(requestA)).toBe('accepted');
      expect(correlation.state(requestB)).toBe('accepted');

      expect(correlation.reply(fixture, requestA, 'reply A')).toEqual({
        requestId: requestA,
        content: 'reply A',
      });
      expect(correlation.state(requestA)).toBe('completed');
      expect(correlation.state(requestB)).toBe('accepted');
      expect(() => correlation.reply(fixture, requestA, 'duplicate reply A')).toThrow(
        'Cannot reply completed request ID: opaque/request-a',
      );
      expect(() => correlation.reply(fixture, 'unknown/request-id', 'unmatched')).toThrow(
        'Unknown request ID: unknown/request-id',
      );
      expect(correlation.state(requestB)).toBe('accepted');

      expect(correlation.reply(fixture, requestB, 'reply B')).toEqual({
        requestId: requestB,
        content: 'reply B',
      });
      expect(correlation.state(requestB)).toBe('completed');
    } finally {
      await disposeFixture(fixture);
    }
  });

  it('binds accepted request state to the session and runtime identity', async () => {
    const fixture = await createPersistedPiSessionFixture();
    const correlation = createRequestCorrelation();
    const requestId = 'opaque/request-session-bound';
    correlation.accept(fixture, requestId);
    const originalSessionId = fixture.sessionId;

    try {
      await fixture.newSession();
      expect(fixture.sessionId).not.toBe(originalSessionId);
      await expect(correlation.deliver(fixture, requestId, 'stale request body')).rejects.toThrow(
        'Request ID belongs to another Pi session/runtime: opaque/request-session-bound',
      );
      expect(() => correlation.reply(fixture, requestId, 'stale reply')).toThrow(
        'Request ID belongs to another Pi session/runtime: opaque/request-session-bound',
      );
      expect(correlation.state(requestId)).toBe('accepted');
    } finally {
      await disposeFixture(fixture);
    }
  });

  it('does not complete a request at agent_end before retry settlement', async () => {
    const fixture = await createPersistedPiSessionFixture({
      settingsManager: SettingsManager.inMemory({
        compaction: { enabled: false },
        retry: { enabled: true, maxRetries: 1, baseDelayMs: 100 },
      }),
      responses: [
        fauxAssistantMessage('transient failure', {
          stopReason: 'error',
          errorMessage: 'server error',
        }),
        fauxAssistantMessage('recovered response'),
      ],
    });
    const correlation = createRequestCorrelation();
    const requestId = 'opaque/request-retry';
    correlation.accept(fixture, requestId);

    let delivery: Promise<void> | undefined;
    try {
      const firstAgentEnd = waitForSessionEvent(
        fixture,
        (event) => event.type === 'agent_end' && event.willRetry,
      );
      delivery = correlation.deliver(fixture, requestId, 'retry request body', {
        triggerTurn: true,
      });
      const agentEnd = await firstAgentEnd;
      expect(agentEnd.type).toBe('agent_end');
      if (agentEnd.type !== 'agent_end') {
        throw new Error('Expected an agent_end event before retry settlement');
      }
      expect(agentEnd.willRetry).toBe(true);
      expect(fixture.probe.latest('agent_end')?.idle).toBe(false);
      expect(fixture.probe.byType('agent_settled')).toHaveLength(0);
      expect(correlation.state(requestId)).toBe('accepted');

      await delivery;
      expect(fixture.probe.byType('agent_end')).toHaveLength(2);
      expect(fixture.probe.byType('agent_settled')).toHaveLength(1);
      expect(correlation.state(requestId)).toBe('accepted');

      correlation.reply(fixture, requestId, 'explicit retry reply');
      expect(correlation.state(requestId)).toBe('completed');
    } finally {
      await disposeFixture(fixture, delivery);
    }
  });
});
