import { randomUUID } from 'node:crypto';

import type { ProtocolError } from '../protocol/errors.js';
import type {
  Content,
  ExpectedResponse,
  JsonObject,
  JsonSchema,
  OperationResponse,
  RequestId,
  RuntimeId,
} from '../protocol/messages.js';
import { validateContent, validateExpectedResponse } from '../protocol/validation.js';
import type { TaskSnapshot } from '../protocol/task-state.js';
import { MessageRouter, RouterError, type RouterNotificationInput } from '../router/router.js';

export const PI_TOOL_NAMES = ['p2p_request', 'p2p_reply', 'p2p_notify'] as const;
export type PiToolName = (typeof PI_TOOL_NAMES)[number];

export interface PiRequestToolInput {
  readonly recipientRuntimeId: RuntimeId;
  readonly content: Content;
  readonly expectedResponse?: ExpectedResponse;
  readonly metadata?: JsonObject;
  readonly expiresAt?: string | number | Date;
}

export interface PiRequestToolResult {
  readonly requestId: RequestId;
  readonly operationId: string;
  readonly state: 'accepted' | 'queued';
  readonly completion: Promise<TaskSnapshot>;
}

export type PiReplyToolInput =
  | {
      readonly requestId: RequestId;
      readonly outcome: 'completed';
      readonly content: Content;
    }
  | {
      readonly requestId: RequestId;
      readonly outcome: 'failed' | 'rejected';
      readonly error: ProtocolError;
    }
  | {
      readonly requestId: RequestId;
      readonly outcome: 'cancelled' | 'expired';
      readonly content?: never;
      readonly error?: never;
    };

export type PiNotifyToolInput = RouterNotificationInput;

export interface PiReplyToolResult {
  readonly requestId: RequestId;
  readonly outcome: 'completed' | 'failed' | 'rejected' | 'cancelled' | 'expired';
  readonly snapshot?: TaskSnapshot;
}

export interface PiToolRegistration {
  readonly name: PiToolName;
  readonly description: string;
  readonly parameters: Record<string, unknown>;
  readonly execute: (input: unknown) => Promise<unknown>;
}

export interface PiToolRegistrar {
  readonly registerTool?: (name: string, definition: PiToolRegistration) => void;
  readonly addTool?: (name: string, definition: PiToolRegistration) => void;
}

export class PiToolError extends Error {
  public readonly protocolError: ProtocolError;

  public constructor(error: ProtocolError) {
    super(error.message);
    this.name = 'PiToolError';
    this.protocolError = error;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requestId(value: unknown): RequestId {
  if (
    typeof value !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)
  ) {
    throw new PiToolError({
      code: 'malformed',
      message: 'requestId must be a UUIDv4',
      retryable: false,
    });
  }
  return value as RequestId;
}

function content(value: unknown): Content {
  const result = validateContent(value);
  if (!result.ok) {
    throw new PiToolError(result.error);
  }
  return result.value;
}

function expectedResponse(value: unknown): ExpectedResponse | undefined {
  if (value === undefined) {
    return undefined;
  }
  const result = validateExpectedResponse(value);
  if (!result.ok) {
    throw new PiToolError(result.error);
  }
  return result.value;
}

function requireResponse(
  response: OperationResponse,
): OperationResponse & { readonly result: Record<string, unknown> } {
  if (!('result' in response) || response.result === undefined) {
    throw new PiToolError(response.error);
  }
  return response as OperationResponse & { readonly result: Record<string, unknown> };
}

/** Model-facing v1 tools. IDs are generated before transport delivery and never inferred. */
export class PiTools<Endpoint = string> {
  public readonly router: MessageRouter<Endpoint>;

  public constructor(router: MessageRouter<Endpoint>) {
    this.router = router;
  }

  public async request(input: PiRequestToolInput): Promise<PiRequestToolResult> {
    const normalizedContent = content(input.content);
    const normalizedExpectedResponse = expectedResponse(input.expectedResponse);
    const handle = await this.router.createRequest({
      recipientRuntimeId: input.recipientRuntimeId,
      content: normalizedContent,
      ...(normalizedExpectedResponse === undefined
        ? {}
        : { expectedResponse: normalizedExpectedResponse }),
      ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
      ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
    });
    const admission = requireResponse(await handle.admission);
    const state = admission.result.state;
    if (state !== 'accepted' && state !== 'queued') {
      throw new PiToolError({
        code: 'malformed',
        message: 'request admission did not return an accepted or queued state',
        retryable: false,
      });
    }
    return Object.freeze({
      requestId: handle.requestId,
      operationId: handle.operationId,
      state,
      completion: handle.completion,
    });
  }

  public async reply(input: PiReplyToolInput): Promise<PiReplyToolResult> {
    const id = requestId(input.requestId);
    if (input.outcome === 'cancelled' || input.outcome === 'expired') {
      throw new PiToolError({
        code: 'invalid_content',
        message: 'cancelled and expired outcomes are system-generated',
        retryable: false,
      });
    }
    if (input.outcome === 'completed') {
      const result = this.router.completeTask(id, content(input.content));
      if (result === undefined) {
        throw new PiToolError({
          code: 'not_found',
          message: 'requestId does not identify an active peer task',
          retryable: false,
        });
      }
      return Object.freeze({ requestId: id, outcome: input.outcome, snapshot: result.snapshot });
    }
    if (input.error === undefined) {
      throw new PiToolError({
        code: 'malformed',
        message: 'failed and rejected replies require an error',
        retryable: false,
      });
    }
    const result =
      input.outcome === 'failed'
        ? this.router.failTask(id, input.error)
        : this.router.rejectTask(id, input.error);
    if (result === undefined) {
      throw new PiToolError({
        code: 'not_found',
        message: 'requestId does not identify an active peer task',
        retryable: false,
      });
    }
    return Object.freeze({ requestId: id, outcome: input.outcome, snapshot: result.snapshot });
  }

  public async notify(input: PiNotifyToolInput): Promise<OperationResponse> {
    return this.router.notify({
      ...input,
      content: content(input.content),
    });
  }

  public async status(
    requestIdValue: RequestId,
    recipientRuntimeId: RuntimeId,
  ): Promise<OperationResponse> {
    return this.router.status({
      requestId: requestId(requestIdValue),
      recipientRuntimeId,
    });
  }

  public async cancel(
    requestIdValue: RequestId,
    recipientRuntimeId: RuntimeId,
    reason?: string,
  ): Promise<OperationResponse> {
    return this.router.cancel({
      requestId: requestId(requestIdValue),
      recipientRuntimeId,
      ...(reason === undefined ? {} : { reason }),
    });
  }

  public definitions(): readonly PiToolRegistration[] {
    return [
      {
        name: 'p2p_request',
        description: 'Send a typed, explicitly correlated request to another Pi runtime.',
        parameters: {
          type: 'object',
          required: ['recipientRuntimeId', 'content'],
          properties: {
            recipientRuntimeId: { type: 'string' },
            content: { type: 'object' },
            expectedResponse: { type: 'object' },
          },
        },
        execute: async (input) => this.request(input as PiRequestToolInput),
      },
      {
        name: 'p2p_reply',
        description: 'Complete one inbound peer request by its explicit request ID.',
        parameters: {
          type: 'object',
          required: ['requestId', 'outcome'],
          properties: {
            requestId: { type: 'string' },
            outcome: { enum: ['completed', 'failed', 'rejected'] },
            content: { type: 'object' },
            error: { type: 'object' },
          },
        },
        execute: async (input) => this.reply(input as PiReplyToolInput),
      },
      {
        name: 'p2p_notify',
        description: 'Deliver a typed notification with a delivery acknowledgment.',
        parameters: {
          type: 'object',
          required: ['recipientRuntimeId', 'content'],
          properties: {
            recipientRuntimeId: { type: 'string' },
            content: { type: 'object' },
          },
        },
        execute: async (input) => this.notify(input as PiNotifyToolInput),
      },
    ];
  }

  public register(registrar: PiToolRegistrar): void {
    const register = registrar.registerTool ?? registrar.addTool;
    if (register === undefined) {
      throw new TypeError('Pi tool registrar must expose registerTool or addTool');
    }
    for (const definition of this.definitions()) {
      register.call(registrar, definition.name, definition);
    }
  }
}

export function createPiTools<Endpoint = string>(
  router: MessageRouter<Endpoint>,
): PiTools<Endpoint> {
  return new PiTools(router);
}

export function registerPiTools<Endpoint = string>(
  registrar: PiToolRegistrar,
  router: MessageRouter<Endpoint>,
): PiTools<Endpoint> {
  const tools = new PiTools(router);
  tools.register(registrar);
  return tools;
}

export const ModelFacingPiTools = PiTools;
export const createModelFacingTools = createPiTools;

/** A schema helper for callers that construct expected JSON responses from a schema value. */
export function jsonExpectedResponse(schema: JsonSchema): ExpectedResponse {
  return { contentType: 'json', schema };
}

/** Generate a request ID for higher-level tool wrappers that need to preallocate one. */
export function generateToolOperationId(): string {
  return randomUUID();
}

export function isPiToolInput(value: unknown): value is Record<string, unknown> {
  return isRecord(value);
}

export function isRouterToolError(value: unknown): value is RouterError | PiToolError {
  return value instanceof RouterError || value instanceof PiToolError;
}
