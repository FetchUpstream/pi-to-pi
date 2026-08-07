import type { AgentSessionEvent } from '@earendil-works/pi-coding-agent';
import type { PiRuntimeFixture } from '../fixtures/index.js';

const INBOUND_TYPE = 'p2p.inbound';

export type InboundDeliveryOptions = {
  triggerTurn?: boolean;
  deliverAs?: 'steer' | 'followUp' | 'nextTurn';
};

export type RequestState = 'accepted' | 'completed';

type RequestRecord = {
  state: RequestState;
  delivered: boolean;
  invalidated: boolean;
  readonly runtime: PiRuntimeFixture['runtime'];
  readonly session: PiRuntimeFixture['session'];
  readonly sessionId: string;
};
type DeliveryWaiter = {
  readonly promise: Promise<void>;
  cancel(reason: unknown): void;
};

export type CorrelationEvent =
  | { type: 'registered'; requestId: string }
  | { type: 'enqueued'; requestId: string; deliveryAs: 'steer' | 'followUp' }
  | { type: 'delivered'; requestId: string; stateAtDelivery: RequestState }
  | { type: 'replied'; requestId: string };

type CorrelationEventListener = (event: CorrelationEvent) => void;

export interface RequestCorrelation {
  readonly events: readonly CorrelationEvent[];
  accept(fixture: PiRuntimeFixture, requestId: string): void;
  subscribe(listener: CorrelationEventListener): () => void;
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

function hasRequestId(details: unknown, requestId: string): boolean {
  return (
    typeof details === 'object' &&
    details !== null &&
    'requestId' in details &&
    details.requestId === requestId
  );
}

function isInboundMessageEnd(event: AgentSessionEvent, requestId: string): boolean {
  return (
    event.type === 'message_end' &&
    event.message.role === 'custom' &&
    event.message.customType === INBOUND_TYPE &&
    hasRequestId(event.message.details, requestId)
  );
}

function assertFixtureRuntimeBinding(fixture: PiRuntimeFixture, requestId: string): void {
  const runtime = fixture.runtime;
  const session = fixture.session;
  const sessionId = fixture.sessionId;
  if (
    runtime.session !== session ||
    runtime.session.sessionId !== sessionId ||
    session.sessionId !== sessionId
  ) {
    throw new Error(`Cannot accept request in a stale Pi session/runtime: ${requestId}`);
  }
}

function assertRequestBelongsToFixture(
  requestId: string,
  request: RequestRecord,
  fixture: PiRuntimeFixture,
): void {
  const runtime = fixture.runtime;
  const session = fixture.session;
  const sessionId = fixture.sessionId;
  if (
    request.invalidated ||
    request.runtime !== runtime ||
    request.session !== session ||
    request.sessionId !== sessionId ||
    runtime.session !== session ||
    runtime.session.sessionId !== sessionId ||
    session.sessionId !== sessionId
  ) {
    throw new Error(`Request ID belongs to another Pi session/runtime: ${requestId}`);
  }
}

function waitForBusyDeliverySettlement(
  fixture: PiRuntimeFixture,
  session: PiRuntimeFixture['session'],
  requestId: string,
): DeliveryWaiter {
  let resolvePromise!: () => void;
  let rejectPromise!: (reason: unknown) => void;
  let finished = false;
  let processed = false;
  const promise = new Promise<void>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });

  const finish = (reason?: unknown): void => {
    if (finished) {
      return;
    }
    finished = true;
    queueMicrotask(() => {
      unsubscribeSession?.();
      unsubscribeInvalidation?.();
    });
    if (reason === undefined) {
      resolvePromise();
    } else {
      rejectPromise(reason);
    }
  };
  const unsubscribeSession = session.subscribe((event) => {
    if (finished) {
      return;
    }
    if (isInboundMessageEnd(event, requestId)) {
      processed = true;
      return;
    }
    if (event.type !== 'agent_settled') {
      return;
    }
    if (!processed) {
      finish(new Error(`Inbound request was not processed before settlement: ${requestId}`));
      return;
    }
    finish();
  });
  const unsubscribeInvalidation = fixture.subscribeToSessionInvalidation?.(() => {
    finish(new Error(`Inbound request session/runtime was replaced: ${requestId}`));
  });

  return {
    promise,
    cancel(reason) {
      finish(reason instanceof Error ? reason : new Error(String(reason)));
    },
  };
}

export function createRequestCorrelation(): RequestCorrelation {
  const requests = new Map<string, RequestRecord>();
  const deliveriesInFlight = new Set<string>();
  const events: CorrelationEvent[] = [];
  const listeners = new Set<CorrelationEventListener>();
  const recordEvent = (event: CorrelationEvent): void => {
    events.push(event);
    for (const listener of listeners) {
      listener(event);
    }
  };

  return {
    events,

    accept(fixture, requestId) {
      if (requests.has(requestId)) {
        throw new Error(`Request ID is already accepted: ${requestId}`);
      }
      assertFixtureRuntimeBinding(fixture, requestId);
      const runtime = fixture.runtime;
      const session = fixture.session;
      const sessionId = fixture.sessionId;
      const request: RequestRecord = {
        state: 'accepted',
        delivered: false,
        invalidated: false,
        runtime,
        session,
        sessionId,
      };
      requests.set(requestId, request);
      fixture.subscribeToSessionInvalidation?.(() => {
        request.invalidated = true;
      });
      recordEvent({ type: 'registered', requestId });
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
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
      if (options?.deliverAs === 'nextTurn') {
        throw new Error('Correlated inbound delivery does not support deliverAs "nextTurn"');
      }
      if (request.delivered || deliveriesInFlight.has(requestId)) {
        throw new Error(`Request ID is already being delivered: ${requestId}`);
      }

      const session = fixture.session;
      const waitsForSettlement = session.isStreaming;
      let busyWaiter: DeliveryWaiter | undefined;
      deliveriesInFlight.add(requestId);
      try {
        if (waitsForSettlement) {
          busyWaiter = waitForBusyDeliverySettlement(fixture, session, requestId);
        }
        await session.sendCustomMessage(
          {
            customType: INBOUND_TYPE,
            content,
            display: false,
            details: { requestId },
          },
          options,
        );
        assertRequestBelongsToFixture(requestId, request, fixture);
        if (waitsForSettlement) {
          recordEvent({
            type: 'enqueued',
            requestId,
            deliveryAs: options?.deliverAs ?? 'steer',
          });
        }
        await busyWaiter?.promise;
        assertRequestBelongsToFixture(requestId, request, fixture);
        request.delivered = true;
        recordEvent({
          type: 'delivered',
          requestId,
          stateAtDelivery: request.state,
        });
      } catch (error) {
        busyWaiter?.cancel(error);
        await busyWaiter?.promise.catch(() => undefined);
        assertRequestBelongsToFixture(requestId, request, fixture);
        throw error;
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
      if (deliveriesInFlight.has(requestId)) {
        throw new Error(`Cannot reply while delivery is in flight: ${requestId}`);
      }
      if (request.state !== 'accepted') {
        throw new Error(`Cannot reply completed request ID: ${requestId}`);
      }
      request.state = 'completed';
      recordEvent({ type: 'replied', requestId });
      return { requestId, content };
    },
  };
}
