import { describe, expect, it } from 'vitest';
import { fauxAssistantMessage } from '@earendil-works/pi-ai';
import { SettingsManager } from '@earendil-works/pi-coding-agent';
import { createPersistedPiSessionFixture } from '../fixtures/index.js';
import { createRequestCorrelation } from './request-correlation.js';

const INBOUND_TYPE = 'p2p.inbound';

function customInboundEntries(
  fixture: Awaited<ReturnType<typeof createPersistedPiSessionFixture>>,
) {
  return fixture.entries.filter(
    (entry) => entry.type === 'custom_message' && entry.customType === INBOUND_TYPE,
  );
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error('Timed out waiting for the expected Pi fixture observation');
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
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

describe('correlated inbound delivery', () => {
  it('registers before idle triggerTurn delivery and preserves an opaque request ID', async () => {
    const fixture = await createPersistedPiSessionFixture({
      responses: [fauxAssistantMessage('idle response')],
    });
    const correlation = createRequestCorrelation();
    const requestId = 'opaque/request-a::7f';
    correlation.accept(requestId);

    try {
      const delivery = correlation.deliver(fixture, requestId, 'idle request body', {
        triggerTurn: true,
      });
      expect(correlation.events).toEqual([
        { type: 'registered', requestId },
        { type: 'delivered', requestId, stateAtDelivery: 'accepted' },
      ]);

      await delivery;

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
      await fixture.dispose();
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
    correlation.accept(initialId);
    correlation.accept(steerId);
    correlation.accept(followUpId);

    let initialDelivery: Promise<void> | undefined;
    try {
      initialDelivery = correlation.deliver(fixture, initialId, 'initial request body', {
        triggerTurn: true,
      });
      await waitFor(() => fixture.faux.state.callCount === 1);
      expect(fixture.session.isStreaming).toBe(true);

      await correlation.deliver(fixture, steerId, 'steering request body', {
        deliverAs: 'steer',
      });
      await correlation.deliver(fixture, followUpId, 'follow-up request body', {
        deliverAs: 'followUp',
      });
      expect(correlation.events.slice(-2)).toEqual([
        { type: 'delivered', requestId: steerId, stateAtDelivery: 'accepted' },
        { type: 'delivered', requestId: followUpId, stateAtDelivery: 'accepted' },
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
      if (initialDelivery) {
        await initialDelivery.catch(() => undefined);
      }
      await fixture.dispose();
    }
  });

  it('correlates replies only by explicit request ID and rejects unknown IDs', async () => {
    const fixture = await createPersistedPiSessionFixture();
    const correlation = createRequestCorrelation();
    const requestA = 'opaque/request-a';
    const requestB = 'opaque/request-b';
    correlation.accept(requestA);
    correlation.accept(requestB);

    try {
      await correlation.deliver(fixture, requestA, 'request A body');
      await correlation.deliver(fixture, requestB, 'request B body');
      expect(correlation.state(requestA)).toBe('accepted');
      expect(correlation.state(requestB)).toBe('accepted');

      expect(correlation.reply(requestA, 'reply A')).toEqual({
        requestId: requestA,
        content: 'reply A',
      });
      expect(correlation.state(requestA)).toBe('completed');
      expect(correlation.state(requestB)).toBe('accepted');
      expect(() => correlation.reply('unknown/request-id', 'unmatched')).toThrow(
        'Unknown request ID: unknown/request-id',
      );
      expect(correlation.state(requestB)).toBe('accepted');

      expect(correlation.reply(requestB, 'reply B')).toEqual({
        requestId: requestB,
        content: 'reply B',
      });
      expect(correlation.state(requestB)).toBe('completed');
    } finally {
      await fixture.dispose();
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
    correlation.accept(requestId);

    try {
      const delivery = correlation.deliver(fixture, requestId, 'retry request body', {
        triggerTurn: true,
      });
      await waitFor(() => fixture.probe.byType('agent_end').length === 1);

      expect(fixture.probe.latest('agent_end')?.idle).toBe(false);
      expect(fixture.probe.byType('agent_settled')).toHaveLength(0);
      expect(correlation.state(requestId)).toBe('accepted');

      await delivery;
      expect(fixture.probe.byType('agent_end')).toHaveLength(2);
      expect(fixture.probe.byType('agent_settled')).toHaveLength(1);
      expect(correlation.state(requestId)).toBe('accepted');

      correlation.reply(requestId, 'explicit retry reply');
      expect(correlation.state(requestId)).toBe('completed');
    } finally {
      await fixture.dispose();
    }
  });
});
