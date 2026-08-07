import type { PiRuntimeFixture } from '../fixtures/index.js';

export type InboundDeliveryOptions = {
  triggerTurn?: boolean;
  deliverAs?: 'steer' | 'followUp' | 'nextTurn';
};

export type RequestState = 'accepted' | 'completed';

export type CorrelationEvent =
  | { type: 'registered'; requestId: string }
  | { type: 'delivered'; requestId: string; stateAtDelivery: RequestState }
  | { type: 'replied'; requestId: string };

export interface RequestCorrelation {
  readonly events: readonly CorrelationEvent[];
  accept(requestId: string): void;
  state(requestId: string): RequestState | undefined;
  deliver(
    fixture: PiRuntimeFixture,
    requestId: string,
    content: string,
    options?: InboundDeliveryOptions,
  ): Promise<void>;
  reply(requestId: string, content: string): { requestId: string; content: string };
}

export function createRequestCorrelation(): RequestCorrelation {
  const requests = new Map<string, RequestState>();
  const events: CorrelationEvent[] = [];

  return {
    events,

    accept(requestId) {
      if (requests.has(requestId)) {
        throw new Error(`Request ID is already accepted: ${requestId}`);
      }
      requests.set(requestId, 'accepted');
      events.push({ type: 'registered', requestId });
    },

    state(requestId) {
      return requests.get(requestId);
    },

    async deliver(fixture, requestId, content, options) {
      const state = requests.get(requestId);
      if (state === undefined) {
        throw new Error(`Cannot deliver unknown request ID: ${requestId}`);
      }
      if (state !== 'accepted') {
        throw new Error(`Cannot deliver completed request ID: ${requestId}`);
      }
      events.push({ type: 'delivered', requestId, stateAtDelivery: state });
      await fixture.session.sendCustomMessage(
        {
          customType: 'p2p.inbound',
          content,
          display: false,
          details: { requestId },
        },
        options,
      );
    },

    reply(requestId, content) {
      if (!requests.has(requestId)) {
        throw new Error(`Unknown request ID: ${requestId}`);
      }
      requests.set(requestId, 'completed');
      events.push({ type: 'replied', requestId });
      return { requestId, content };
    },
  };
}
