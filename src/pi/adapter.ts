import { Type } from '@earendil-works/pi-ai';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';

import type { AgentCardRegistry } from '../discovery/agent-card-registry.js';
import type { DiagnosticSnapshot } from '../diagnostics.js';
import {
  unavailableIssueReporter,
  type IssueReporter,
  type IssueReportResult,
  type ModelIssueReport,
} from '../issue-reporter.js';
import { resolvePeerTarget } from '../discovery/lookup.js';
import { createProtocolError } from '../protocol/errors.js';
import type {
  Content,
  ExpectedResponse,
  JsonSchema,
  RequestId,
  RuntimeId,
} from '../protocol/messages.js';
import {
  isTerminalTaskState,
  type TaskSnapshot,
  type TerminalOutcome,
} from '../protocol/task-state.js';
import type { TaskExecutor, TaskExecutorContext } from '../protocol/interfaces.js';
import { MessageRouter, type RouterRequestHandle } from '../router/router.js';
import {
  contentText,
  PI_P2P_INBOUND_MESSAGE,
  PI_P2P_OUTBOUND_MESSAGE,
  terminalText,
  type PiInboundCustomMessage,
  type PiInboundRequestDetails,
  type PiOutboundCustomMessage,
  type PiOutboundResultDetails,
} from './messages.js';

export interface PiMessageDelivery {
  readonly sendMessage: <T = unknown>(
    message: {
      readonly customType: string;
      readonly content: string;
      readonly display: boolean;
      readonly details?: T;
    },
    options?: {
      readonly triggerTurn?: boolean;
      readonly deliverAs?: 'steer' | 'followUp' | 'nextTurn';
    },
  ) => void;
  readonly isIdle: ExtensionContext['isIdle'];
}

export interface PiAdapterOptions {
  readonly router: MessageRouter;
  readonly peers: AgentCardRegistry;
  readonly reporter?: IssueReporter;
  readonly diagnostics?: (
    input: Pick<ModelIssueReport, 'operation' | 'requestId' | 'peerRuntimeId'>,
  ) => DiagnosticSnapshot;
}

interface ActiveRuntime {
  readonly delivery: PiMessageDelivery;
  readonly inboundTaskIds: Set<RequestId>;
  readonly outboundTaskIds: Set<RequestId>;
  readonly terminalRequestIds: Set<RequestId>;
}

export interface PiReplyInput {
  readonly requestId: string;
  readonly outcome?: 'completed' | 'failed' | 'rejected';
  readonly content?: Content;
  readonly message?: string;
}

/** Runtime-local bridge between Pi and the production router/discovery seams. */
export class PiAdapter {
  public readonly router: MessageRouter;
  public readonly peers: AgentCardRegistry;
  private readonly reporter: IssueReporter;
  private readonly diagnostics: NonNullable<PiAdapterOptions['diagnostics']>;
  private active: ActiveRuntime | undefined;

  public constructor(options: PiAdapterOptions) {
    this.router = options.router;
    this.peers = options.peers;
    this.reporter = options.reporter ?? unavailableIssueReporter;
    this.diagnostics =
      options.diagnostics ??
      (() => ({
        timestamp: new Date().toISOString(),
        packageVersion: 'unknown',
        runtimeId: 'unknown',
        roomId: 'unknown',
        platform: process.platform,
        lifecycle: 'created',
        events: [],
      }));
  }

  public bind(delivery: PiMessageDelivery): void {
    this.active = {
      delivery,
      inboundTaskIds: new Set(),
      outboundTaskIds: new Set(),
      terminalRequestIds: new Set(),
    };
  }

  public clear(): void {
    this.active = undefined;
  }

  public readonly taskExecutor: TaskExecutor = async (context) => {
    const active = this.active;
    if (active === undefined || context.signal.aborted) {
      return;
    }
    const details: PiInboundRequestDetails = {
      kind: 'inbound-request',
      requestId: context.requestId,
      senderRuntimeId: context.request.sender.runtimeId,
      traceId: context.request.traceId,
      ...(context.request.parentOperationId === undefined
        ? {}
        : { parentOperationId: context.request.parentOperationId }),
      ...(context.request.payload.expectedResponse === undefined
        ? {}
        : { expectedResponse: context.request.payload.expectedResponse }),
      state: context.snapshot.state,
      expiresAt: context.snapshot.expiresAt,
    };
    const message: PiInboundCustomMessage = {
      customType: PI_P2P_INBOUND_MESSAGE,
      content: `Peer request ${context.requestId} from ${context.request.sender.runtimeId}: ${contentText(context.request.payload.content)}`,
      display: true,
      details,
    };
    active.inboundTaskIds.add(context.requestId);
    await active.delivery.sendMessage(
      message,
      active.delivery.isIdle() ? { triggerTurn: true } : { deliverAs: 'steer' },
    );
  };

  public async send(
    target: string,
    content: Content,
    expectedResponse?: ExpectedResponse,
  ): Promise<{ requestId: RequestId; targetRuntimeId: RuntimeId; admission: unknown }> {
    const resolved = await this.resolveTarget(target);
    if (resolved.kind !== 'found') {
      throw new Error(this.targetError(resolved));
    }
    const handle = await this.router.createRequest({
      recipientRuntimeId: resolved.record.runtimeId,
      content,
      ...(expectedResponse === undefined ? {} : { expectedResponse }),
    });
    const active = this.active;
    active?.outboundTaskIds.add(handle.requestId);
    this.trackCompletion(handle, resolved.record.runtimeId as unknown as RuntimeId, active);
    try {
      const admission = await handle.admission;
      return {
        requestId: handle.requestId,
        targetRuntimeId: resolved.record.runtimeId as unknown as RuntimeId,
        admission,
      };
    } catch (error) {
      throw new Error(error instanceof Error ? error.message : 'Router failed to admit request');
    }
  }

  public async notify(target: string, content: Content): Promise<unknown> {
    const resolved = await this.resolveTarget(target);
    if (resolved.kind !== 'found') {
      throw new Error(this.targetError(resolved));
    }
    return this.router.notify({ recipientRuntimeId: resolved.record.runtimeId, content });
  }

  public async listPeers(): Promise<unknown[]> {
    return this.peers.listPeers().then((peers) =>
      peers.map((peer) => ({
        displayName: peer.displayName,
        publishedName: peer.networkName,
        runtimeId: peer.runtimeId,
        endpoint: peer.endpoint,
        model: peer.card.model,
        state: peer.card.state,
        contextUsage: peer.card.contextUsage,
        inboundQueueDepth: peer.card.inboundQueueDepth,
        capabilities: peer.card.capabilities,
      })),
    );
  }

  public reply(input: PiReplyInput): TaskSnapshot {
    const requestId = input.requestId as RequestId;
    const snapshot = this.router.taskSnapshot(requestId);
    if (snapshot === undefined || !this.active?.inboundTaskIds.has(requestId)) {
      throw new Error('Request is not an active inbound task for this runtime');
    }
    if (isTerminalTaskState(snapshot.state) || snapshot.state === 'cancelling') {
      throw new Error(`Request is ${snapshot.state} and cannot be replied to`);
    }
    const outcome = input.outcome ?? 'completed';
    const result =
      outcome === 'completed'
        ? input.content === undefined
          ? undefined
          : this.router.completeTask(requestId, input.content)
        : outcome === 'failed'
          ? this.router.failTask(
              requestId,
              createProtocolError('internal', input.message ?? 'Peer request failed'),
            )
          : this.router.rejectTask(
              requestId,
              createProtocolError('invalid_content', input.message ?? 'Peer request rejected'),
            );
    if (result === undefined) {
      throw new Error('Reply was rejected by the router; correct the response and try again');
    }
    return result.snapshot;
  }

  public status(requestId: string): TaskSnapshot | undefined {
    return this.router.taskSnapshot(requestId as RequestId);
  }

  public async reportIssue(input: ModelIssueReport): Promise<IssueReportResult> {
    try {
      return await this.reporter.report({
        ...input,
        diagnostics: this.diagnostics(input),
      });
    } catch {
      return { status: 'failed', reason: 'Pi-to-Pi issue reporting failed' };
    }
  }

  public statusReport(requestId: string): {
    readonly direction: 'inbound' | 'outbound' | 'unknown';
    readonly snapshot?: TaskSnapshot;
  } {
    const id = requestId as RequestId;
    return {
      direction: this.active?.inboundTaskIds.has(id)
        ? 'inbound'
        : this.active?.outboundTaskIds.has(id)
          ? 'outbound'
          : 'unknown',
      ...(this.router.taskSnapshot(id) === undefined
        ? {}
        : { snapshot: this.router.taskSnapshot(id) }),
    };
  }

  private async resolveTarget(target: string) {
    const peers = await this.peers.listPeers();
    return resolvePeerTarget(target, this.peers.roomId, peers);
  }

  private targetError(result: Awaited<ReturnType<PiAdapter['resolveTarget']>>): string {
    if (result.kind === 'ambiguous') {
      return `Peer target is ambiguous; use one runtime ID: ${result.candidates.map((candidate) => candidate.runtimeId).join(', ')}`;
    }
    if (result.kind === 'cross-room') {
      return 'Peer target belongs to another room';
    }
    return 'Peer target was not found';
  }

  private trackCompletion(
    handle: RouterRequestHandle,
    peerRuntimeId: RuntimeId,
    active: ActiveRuntime | undefined,
  ): void {
    void handle.completion.then((snapshot) =>
      this.injectTerminal(handle.requestId, peerRuntimeId, snapshot, active),
    );
  }

  private async injectTerminal(
    requestId: RequestId,
    peerRuntimeId: RuntimeId,
    snapshot: TaskSnapshot,
    active: ActiveRuntime | undefined,
  ): Promise<void> {
    if (
      active === undefined ||
      active !== this.active ||
      !isTerminalTaskState(snapshot.state) ||
      active.terminalRequestIds.has(requestId)
    ) {
      return;
    }
    active.terminalRequestIds.add(requestId);
    const details: PiOutboundResultDetails = {
      kind: 'outbound-result',
      requestId,
      peerRuntimeId,
      state: snapshot.state,
      terminalOutcome: snapshot.state as TerminalOutcome,
    };
    const message: PiOutboundCustomMessage = {
      customType: PI_P2P_OUTBOUND_MESSAGE,
      content: `Peer result for ${requestId} from ${peerRuntimeId}: ${terminalText(snapshot)}`,
      display: true,
      details,
    };
    await active.delivery.sendMessage(
      message,
      active.delivery.isIdle() ? { triggerTurn: true } : { deliverAs: 'followUp' },
    );
  }
}

function textResult(content: string, isError = false) {
  return { content: [{ type: 'text' as const, text: content }], details: { isError } };
}

/** Register communication-only Pi tools against an injectable adapter. */
/** Register communication-only Pi tools against an adapter or current-runtime resolver. */
export function registerPiTools(
  pi: Pick<ExtensionAPI, 'registerTool'>,
  adapter: PiAdapter | (() => PiAdapter | undefined),
): void {
  const current = (): PiAdapter => {
    const resolved = typeof adapter === 'function' ? adapter() : adapter;
    if (resolved === undefined) throw new Error('No active Pi-to-Pi runtime');
    return resolved;
  };
  pi.registerTool({
    name: 'p2p_peers',
    label: 'P2P peers',
    description: 'List live peers in this room.',
    parameters: Type.Object({}),
    execute: async () => {
      try {
        return textResult(JSON.stringify(await current().listPeers(), null, 2));
      } catch (error) {
        return textResult(error instanceof Error ? error.message : 'Unable to list peers', true);
      }
    },
  });
  pi.registerTool({
    name: 'p2p_send',
    label: 'P2P send',
    description: 'Send a request or notification to one exact live peer.',
    parameters: Type.Object({
      target: Type.String(),
      text: Type.String(),
      notification: Type.Optional(Type.Boolean()),
      expectedResponse: Type.Optional(Type.Object({ schema: Type.Unknown() })),
    }),
    execute: async (_id, params) => {
      try {
        const content = { type: 'text' as const, text: params.text };
        if (params.notification) {
          await current().notify(params.target, content);
          return textResult('Notification admitted.');
        }
        const result = await current().send(
          params.target,
          content,
          params.expectedResponse === undefined
            ? undefined
            : { contentType: 'json', schema: params.expectedResponse.schema as JsonSchema },
        );
        return textResult(`Request ${result.requestId} admitted for ${result.targetRuntimeId}.`);
      } catch (error) {
        return textResult(error instanceof Error ? error.message : 'Unable to send request', true);
      }
    },
  });
  pi.registerTool({
    name: 'p2p_reply',
    label: 'P2P reply',
    description: 'Explicitly reply to one exact inbound request ID.',
    parameters: Type.Object({
      requestId: Type.String(),
      text: Type.Optional(Type.String()),
      outcome: Type.Optional(
        Type.Union([Type.Literal('completed'), Type.Literal('failed'), Type.Literal('rejected')]),
      ),
    }),
    execute: async (_id, params) => {
      try {
        const snapshot = current().reply({
          requestId: params.requestId,
          outcome: params.outcome,
          ...(params.text === undefined
            ? {}
            : { content: { type: 'text', text: params.text }, message: params.text }),
        });
        return textResult(`Request ${snapshot.requestId} is ${snapshot.state}.`);
      } catch (error) {
        return textResult(error instanceof Error ? error.message : 'Unable to reply', true);
      }
    },
  });
  pi.registerTool({
    name: 'p2p_report_issue',
    label: 'Report Pi-to-Pi defect',
    description:
      'Report only suspected Pi-to-Pi discovery, transport, routing, lifecycle, or protocol defects; do not use for application failures, feature requests, or arbitrary GitHub issues.',
    parameters: Type.Object({
      title: Type.String(),
      description: Type.String(),
      expected: Type.Optional(Type.String()),
      actual: Type.Optional(Type.String()),
      operation: Type.Optional(Type.String()),
      requestId: Type.Optional(Type.String()),
      peerRuntimeId: Type.Optional(Type.String()),
    }),
    execute: async (_id, params) => {
      try {
        const result = await current().reportIssue(params);
        if (result.status === 'created' || result.status === 'existing') {
          return textResult(
            `${result.status === 'created' ? 'Created' : 'Reused'} upstream issue #${result.number}: ${result.url}`,
          );
        }
        return textResult(
          `Issue reporting ${result.status}: ${'reason' in result ? result.reason : 'failed'}`,
          result.status === 'failed',
        );
      } catch {
        return textResult('Pi-to-Pi issue reporting failed', true);
      }
    },
  });
  pi.registerTool({
    name: 'p2p_status',
    label: 'P2P status',
    description: 'Inspect one live router task by exact request ID.',
    parameters: Type.Object({ requestId: Type.String() }),
    execute: async (_id, params) => {
      try {
        const report = current().statusReport(params.requestId);
        return textResult(
          report.snapshot === undefined
            ? 'No live router task found.'
            : JSON.stringify(report, null, 2),
        );
      } catch (error) {
        return textResult(
          error instanceof Error ? error.message : 'Unable to inspect status',
          true,
        );
      }
    },
  });
}

export function executorFor(adapter: PiAdapter): (context: TaskExecutorContext) => Promise<void> {
  return async (context) => {
    await adapter.taskExecutor(context);
  };
}
