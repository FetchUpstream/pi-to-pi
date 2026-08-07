import type {
  RuntimeShutdownOptions,
  RuntimeShutdownReport,
  RuntimePersistence,
} from './persistence.js';
import {
  MessageRouter,
  type RouterOptions,
  type RouterRequestExecutor,
  type RouterRequestExecutorResult,
  type RouterTarget,
  type RouterTaskResult,
} from '../router/router.js';
import type { OperationId, RequestId, Content } from '../protocol/messages.js';
import type { ProtocolError } from '../protocol/errors.js';
import type { TaskSnapshot } from '../protocol/task-state.js';
import {
  createPiCancellationMessage,
  createPiExpiredMessage,
  createPiRequestMessage,
  createPiTaskUpdateMessage,
  createPiUnreachableMessage,
  emitPiMessage,
  type PiMessageSink,
} from './messages.js';

export interface PiLifecycleOptions<Endpoint = string> {
  readonly router?: MessageRouter<Endpoint>;
  readonly persistence?: RuntimePersistence;
  readonly sink?: PiMessageSink;
  readonly executeRequest?: RouterRequestExecutor;
  readonly onRequest?: RouterRequestExecutor;
}

export interface PiRuntimeOptions<Endpoint = string> extends Omit<
  RouterOptions<Endpoint>,
  'requestExecutor' | 'onTaskStateChange' | 'onUnreachable'
> {
  readonly sink?: PiMessageSink;
  readonly executeRequest?: RouterRequestExecutor;
  readonly onTaskStateChange?: (requestId: RequestId, snapshot: TaskSnapshot) => void;
  readonly onUnreachable?: (operationId: OperationId, error: ProtocolError) => void;
}

interface ActivePiTask {
  readonly requestId: RequestId;
  readonly operationId: OperationId;
  readonly signal: AbortSignal;
}

/**
 * Session-scoped integration boundary for Pi. Every active model turn is keyed
 * by its request ID; no global current assistant message or agent-end event is
 * used to select a reply.
 */
export class PiLifecycleBridge<Endpoint = string> {
  private routerValue: MessageRouter<Endpoint> | undefined;
  private readonly persistence?: RuntimePersistence;
  private readonly sink?: PiMessageSink;
  private readonly executeRequest?: RouterRequestExecutor;
  private readonly active = new Map<RequestId, ActivePiTask>();
  private started = false;

  public constructor(options: PiLifecycleOptions<Endpoint> = {}) {
    this.routerValue = options.router;
    this.persistence = options.persistence;
    this.sink = options.sink;
    this.executeRequest = options.executeRequest ?? options.onRequest;
  }

  public get router(): MessageRouter<Endpoint> {
    if (this.routerValue === undefined) {
      throw new Error('Pi lifecycle bridge is not attached to a router');
    }
    return this.routerValue;
  }

  public get activeTaskCount(): number {
    return this.active.size;
  }

  public get activeRequestIds(): readonly RequestId[] {
    return Object.freeze([...this.active.keys()]);
  }

  public get isStarted(): boolean {
    return this.started;
  }

  public attach(router: MessageRouter<Endpoint>): void {
    if (this.routerValue !== undefined && this.routerValue !== router) {
      throw new Error('Pi lifecycle bridge is already attached to another router');
    }
    this.routerValue = router;
  }

  public async start(target?: RouterTarget<Endpoint>): Promise<void> {
    await this.router.start(target === undefined ? {} : { target });
    this.started = true;
  }

  /** Handle Pi's session shutdown boundary; no process-global listeners are installed. */
  public async shutdown(
    options: RuntimeShutdownOptions = {},
  ): Promise<RuntimeShutdownReport | undefined> {
    this.started = false;
    if (this.persistence !== undefined) {
      const report = await this.persistence.shutdown(options);
      await this.router.close();
      return report;
    }
    await this.router.close();
    return undefined;
  }

  public async close(
    options: RuntimeShutdownOptions = {},
  ): Promise<RuntimeShutdownReport | undefined> {
    return this.shutdown(options);
  }

  /** Request executor suitable for MessageRouter's per-task injection point. */
  public readonly requestExecutor: RouterRequestExecutor = async (context) => {
    this.active.set(context.requestId, {
      requestId: context.requestId,
      operationId: context.request.operationId,
      signal: context.signal,
    });
    await this.emit(createPiRequestMessage(context.request));
    try {
      if (this.executeRequest === undefined) {
        return undefined;
      }
      return await this.executeRequest(context);
    } finally {
      this.active.delete(context.requestId);
      const snapshot = this.router.taskSnapshot(context.requestId);
      if (snapshot !== undefined) {
        await this.emit(createPiTaskUpdateMessage(snapshot));
      }
    }
  };

  /** Explicitly complete one request; the request ID is mandatory. */
  public complete(requestId: RequestId, content: Content): RouterTaskResult | undefined {
    return this.router.completeTask(requestId, content);
  }

  public fail(requestId: RequestId, error: ProtocolError): RouterTaskResult | undefined {
    return this.router.failTask(requestId, error);
  }

  public reject(requestId: RequestId, error: ProtocolError): RouterTaskResult | undefined {
    return this.router.rejectTask(requestId, error);
  }

  public cancel(requestId: RequestId, reason?: string): RouterTaskResult | undefined {
    const result = this.router.cancelTask(requestId, {
      caller: this.router.runtimeId,
      reason,
    });
    void this.emit(createPiCancellationMessage(requestId, reason));
    return result;
  }

  /** Explicit agent completion hook. It never searches for a latest task. */
  public agentEnd(
    requestId: RequestId,
    result: RouterRequestExecutorResult,
  ): RouterTaskResult | undefined {
    if (!this.active.has(requestId)) {
      return undefined;
    }
    if (
      result !== undefined &&
      typeof result === 'object' &&
      result !== null &&
      'error' in result &&
      result.error !== undefined
    ) {
      return this.fail(requestId, result.error);
    }
    const content =
      typeof result === 'object' && result !== null && 'content' in result
        ? result.content
        : (result as Content);
    return content === undefined ? undefined : this.complete(requestId, content);
  }

  public agentSettled(
    requestId: RequestId,
    result: RouterRequestExecutorResult,
  ): RouterTaskResult | undefined {
    return this.agentEnd(requestId, result);
  }

  public async publishTaskUpdate(snapshot: TaskSnapshot): Promise<void> {
    await this.emit(createPiTaskUpdateMessage(snapshot));
    if (snapshot.state === 'expired' && snapshot.error !== undefined) {
      await this.emit(createPiExpiredMessage(snapshot, snapshot.error));
    }
  }

  public async publishUnreachable(
    operationId: OperationId,
    error: ProtocolError & { readonly code: 'unreachable' },
    requestId?: RequestId,
  ): Promise<void> {
    await this.emit(createPiUnreachableMessage(operationId, error, requestId));
  }

  private async emit(message: Parameters<typeof emitPiMessage>[1]): Promise<void> {
    if (this.sink !== undefined) {
      await emitPiMessage(this.sink, message);
    }
  }
}

/** Create a lifecycle bridge around an already-created router. */
export function createPiLifecycle<Endpoint = string>(
  options: PiLifecycleOptions<Endpoint> = {},
): PiLifecycleBridge<Endpoint> {
  return new PiLifecycleBridge(options);
}

export interface PiRuntime<Endpoint = string> {
  readonly router: MessageRouter<Endpoint>;
  readonly lifecycle: PiLifecycleBridge<Endpoint>;
}

/** Construct the router and Pi lifecycle together with per-request execution wired in. */
export function createPiRuntime<Endpoint = string>(
  options: PiRuntimeOptions<Endpoint>,
): PiRuntime<Endpoint> {
  const userStateChange = options.onTaskStateChange;
  const userUnreachable = options.onUnreachable;
  const lifecycle: PiLifecycleBridge<Endpoint> = new PiLifecycleBridge<Endpoint>({
    sink: options.sink,
    executeRequest: options.executeRequest,
    persistence: options.persistence,
  });
  const router = new MessageRouter({
    ...options,
    requestExecutor: lifecycle.requestExecutor,
    onTaskStateChange: (requestId, snapshot) => {
      userStateChange?.(requestId, snapshot);
      void lifecycle.publishTaskUpdate(snapshot);
    },
    onUnreachable: (operationId, error) => {
      userUnreachable?.(operationId, error);
      if (error.code === 'unreachable') {
        void lifecycle.publishUnreachable(
          operationId,
          error as ProtocolError & { readonly code: 'unreachable' },
        );
      }
    },
  });
  lifecycle.attach(router);
  return Object.freeze({ router, lifecycle });
}

/** Compatibility aliases for callers that name this boundary by session. */
export const PiLifecycle = PiLifecycleBridge;
export const SessionLifecycle = PiLifecycleBridge;
export const createPiSessionLifecycle = createPiLifecycle;
