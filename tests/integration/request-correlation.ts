import type { PiRuntimeFixture } from '../fixtures/index.js';

export type InboundDeliveryOptions = {
  triggerTurn?: boolean;
  deliverAs?: 'steer' | 'followUp' | 'nextTurn';
};

export type RequestState = 'accepted' | 'completed';

type RequestRecord = {
  state: RequestState;
  delivered: boolean;
  readonly runtime: PiRuntimeFixture['runtime'];
  readonly sessionId: string;
};

export type CorrelationEvent =
  | { type: 'registered'; requestId: string }
  | { type: 'delivered'; requestId: string; stateAtDelivery: RequestState }
  | { type: 'replied'; requestId: string };

export interface RequestCorrelation {
  readonly events: readonly CorrelationEvent[];
  accept(fixture: PiRuntimeFixture, requestId: string): void;
  state(requestId: string): RequestState | undefined;
  deliver(
    fixture: PiRuntimeFixture,
    requestId: string,
    content: string,
    options?: InboundDeliveryOptions,
  ): Promise<void>;
  reply(
    fixture: PiRuntimeFixture,
    requestId: string,
    content: string,
  ): { requestId: string; content: string };
}

function assertRequestBelongsToFixture(
  requestId: string,
  request: RequestRecord,
  fixture: PiRuntimeFixture,
): void {
  if (request.runtime !== fixture.runtime || request.sessionId !== fixture.sessionId) {
    throw new Error(`Request ID belongs to another Pi session/runtime: ${requestId}`);
  }
}

export function createRequestCorrelation(): RequestCorrelation {
  const requests = new Map<string, RequestRecord>();
  const deliveriesInFlight = new Set<string>();
  const events: CorrelationEvent[] = [];

  return {
    events,

    accept(fixture, requestId) {
      if (requests.has(requestId)) {
        throw new Error(`Request ID is already accepted: ${requestId}`);
      }
      requests.set(requestId, {
        state: 'accepted',
        delivered: false,
        runtime: fixture.runtime,
        sessionId: fixture.sessionId,
      });
      events.push({ type: 'registered', requestId });
    },

    state(requestId) {
      return requests.get(requestId)?.state;
    },

    async deliver(fixture, requestId, content, options) {
      const request = requests.get(requestId);
      if (request === undefined) {
        throw new Error(`Cannot deliver unknown request ID: ${requestId}`);
      }
      assertRequestBelongsToFixture(requestId, request, fixture);
      if (request.state !== 'accepted') {
        throw new Error(`Cannot deliver completed request ID: ${requestId}`);
      }
      if (request.delivered || deliveriesInFlight.has(requestId)) {
        throw new Error(`Request ID is already being delivered: ${requestId}`);
      }

      deliveriesInFlight.add(requestId);
      try {
        await fixture.session.sendCustomMessage(
          {
            customType: 'p2p.inbound',
            content,
            display: false,
            details: { requestId },
          },
          options,
        );
        request.delivered = true;
        events.push({
          type: 'delivered',
          requestId,
          stateAtDelivery: request.state,
        });
      } finally {
        deliveriesInFlight.delete(requestId);
      }
    },

    reply(fixture, requestId, content) {
      const request = requests.get(requestId);
      if (request === undefined) {
        throw new Error(`Unknown request ID: ${requestId}`);
      }
      assertRequestBelongsToFixture(requestId, request, fixture);
      if (request.state !== 'accepted') {
        throw new Error(`Cannot reply completed request ID: ${requestId}`);
      }
      request.state = 'completed';
      events.push({ type: 'replied', requestId });
      return { requestId, content };
    },
  };
}
