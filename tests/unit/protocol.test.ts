import { describe, expect, it } from 'vitest';

import {
  DEFAULT_PROTOCOL_LIMITS,
  DEFAULT_QUEUE_LIMIT,
  DEFAULT_REQUEST_TTL_MS,
  MAX_CONTROL_TTL_MS,
  MAX_ENVELOPE_BYTES,
  MAX_REQUEST_TTL_MS,
  MAX_SCHEMA_BYTES,
  createProtocolConfig,
} from '../../src/config.js';
import { isUuidV4 as isIdentityUuidV4 } from '../../src/identity.js';
import { deriveRoomId } from '../../src/room.js';
import {
  JSON_SCHEMA_DRAFT_2020_12,
  OPERATION_NAMES,
  PROTOCOL_VERSION,
  type JsonSchema,
} from '../../src/protocol/messages.js';
import {
  PROTOCOL_ERROR_CODES,
  createProtocolError,
  type ProtocolError,
  type ProtocolErrorCode,
} from '../../src/protocol/errors.js';
import {
  canonicalRequestData,
  canonicalRequestFingerprint,
  canonicalizeJson,
  isRfc3339Utc,
  isUuidV4 as isValidationUuidV4,
  parseRfc3339Utc,
  validateContent,
  validateEnvelope,
  validateExpectedResponse,
  validateJsonSchema,
  validateJsonValueAgainstSchema,
  MAX_PROTOCOL_ERROR_MESSAGE_LENGTH,
  validateOperationResponse,
  validateReplyContent,
  type ValidationResult,
} from '../../src/protocol/validation.js';

const REQUEST_ID = '8b6f4f7e-1fc4-4c4e-8e4c-5a3c7427c4d1';
const REPLY_OPERATION_ID = '2e7a11d9-aaf9-4b42-b46b-39d16f6a5f06';
const STATUS_OPERATION_ID = '11111111-1111-4111-8111-111111111111';
const CANCEL_OPERATION_ID = '22222222-2222-4222-8222-222222222222';
const DESCRIBE_OPERATION_ID = '33333333-3333-4333-8333-333333333333';
const OTHER_ID = '44444444-4444-4444-8444-444444444444';
const TRACE_ID = '4bf92f3577b34da6a3ce929d0e0e4736';
const ROOM_ID = deriveRoomId('explicit', 'protocol-conformance-room');
const NOW = '2026-08-07T09:59:00.000Z';
const CREATED_AT = '2026-08-07T10:00:00.000Z';
const REQUEST_EXPIRES_AT = '2026-08-07T10:10:00.000Z';
const CONTROL_EXPIRES_AT = '2026-08-07T10:00:30.000Z';

type TestRecord = Record<string, unknown>;

const validRequest = {
  protocolVersion: PROTOCOL_VERSION,
  operation: 'message.request',
  operationId: REQUEST_ID,
  requestId: REQUEST_ID,
  sender: { sessionId: 'session-a', runtimeId: 'runtime-a' },
  recipientRuntimeId: 'runtime-b',
  roomId: ROOM_ID,
  createdAt: CREATED_AT,
  expiresAt: REQUEST_EXPIRES_AT,
  traceId: TRACE_ID,
  payload: {
    content: { type: 'text', text: 'Review this change.' },
  },
} as const;

const validReply = {
  ...validRequest,
  operation: 'message.reply',
  operationId: REPLY_OPERATION_ID,
  requestId: REQUEST_ID,
  sender: { sessionId: 'session-b', runtimeId: 'runtime-b' },
  recipientRuntimeId: 'runtime-a',
  createdAt: '2026-08-07T10:02:00.000Z',
  expiresAt: REQUEST_EXPIRES_AT,
  payload: {
    outcome: 'completed',
    content: { type: 'text', text: 'Reviewed successfully.' },
  },
} as const;

const validStatus = {
  ...validRequest,
  operation: 'task.status',
  operationId: STATUS_OPERATION_ID,
  requestId: REQUEST_ID,
  expiresAt: CONTROL_EXPIRES_AT,
  payload: {},
} as const;

const validCancel = {
  ...validRequest,
  operation: 'task.cancel',
  operationId: CANCEL_OPERATION_ID,
  requestId: REQUEST_ID,
  expiresAt: CONTROL_EXPIRES_AT,
  payload: {},
} as const;

const validNotify = withoutField(
  {
    ...validRequest,
    operation: 'message.notify',
    payload: {
      content: { type: 'json', value: { event: 'ready', count: 1 } },
    },
  },
  'requestId',
);

const validDescribe = withoutField(
  {
    ...validRequest,
    operation: 'peer.describe',
    operationId: DESCRIBE_OPERATION_ID,
    expiresAt: CONTROL_EXPIRES_AT,
    payload: {},
  },
  'requestId',
);

const validTaskSnapshot = {
  requestId: REQUEST_ID,
  state: 'accepted',
  createdAt: CREATED_AT,
  updatedAt: CREATED_AT,
  expiresAt: REQUEST_EXPIRES_AT,
  cancellationRequested: false,
} as const;

function asRecord(value: object): TestRecord {
  return { ...(value as TestRecord) };
}

function withoutField(value: object, field: string): TestRecord {
  const copy = asRecord(value);
  delete copy[field];
  return copy;
}

function expectFailure<Value>(
  result: ValidationResult<Value>,
  code: ProtocolErrorCode,
): ProtocolError {
  if (result.ok) {
    throw new Error(`Expected validation to fail with ${code}`);
  }
  expect(result.error.code).toBe(code);
  return result.error;
}
function makeDescribeResponse(agentCard: unknown): TestRecord {
  return {
    protocolVersion: PROTOCOL_VERSION,
    operation: 'peer.describe',
    operationId: DESCRIBE_OPERATION_ID,
    traceId: TRACE_ID,
    result: { agentCard },
  };
}

const localSchema: JsonSchema = {
  $schema: JSON_SCHEMA_DRAFT_2020_12,
  $defs: {
    identifier: {
      type: 'string',
      format: 'date-time',
      pattern: '^[a-z]+$',
    },
  },
  type: 'object',
  required: ['id'],
  properties: {
    id: { $ref: '#/$defs/identifier' },
  },
  additionalProperties: false,
};

const validAgentCard = {
  name: 'runtime-b',
  description: 'Conformance fixture peer',
  sessionId: 'session-b',
  runtimeId: 'runtime-b',
  supportedProtocolVersions: [PROTOCOL_VERSION],
  operations: OPERATION_NAMES.map((operation) => ({ operation })),
  contentCapabilities: [{ type: 'text' }, { type: 'json', supportsSchema: true }],
  capabilities: {
    supportsCancellation: true,
    supportsNotifications: true,
  },
  limits: {
    requestTtlMs: DEFAULT_REQUEST_TTL_MS,
    maxRequestTtlMs: MAX_REQUEST_TTL_MS,
    maxControlTtlMs: MAX_CONTROL_TTL_MS,
    maxEnvelopeBytes: MAX_ENVELOPE_BYTES,
    maxSchemaBytes: MAX_SCHEMA_BYTES,
    maxQueueEntries: DEFAULT_QUEUE_LIMIT,
  },
};
const AGENT_CARD_LIMIT_CEILINGS = [
  ['requestTtlMs', MAX_REQUEST_TTL_MS],
  ['maxRequestTtlMs', MAX_REQUEST_TTL_MS],
  ['maxControlTtlMs', MAX_CONTROL_TTL_MS],
  ['maxEnvelopeBytes', MAX_ENVELOPE_BYTES],
  ['maxSchemaBytes', MAX_SCHEMA_BYTES],
  ['maxQueueEntries', DEFAULT_QUEUE_LIMIT],
] as const;

describe('protocol envelope foundations', () => {
  it('accepts a deterministic v1 message.request envelope', () => {
    const result = validateEnvelope(validRequest, { now: NOW });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.operation).toBe('message.request');
    expect(result.value.operationId).toBe(REQUEST_ID);
    expect(result.value.requestId).toBe(REQUEST_ID);
  });

  it.each([
    'protocolVersion',
    'operation',
    'operationId',
    'sender',
    'recipientRuntimeId',
    'roomId',
    'createdAt',
    'expiresAt',
    'traceId',
    'payload',
  ])('rejects an envelope missing %s', (field) => {
    expectFailure(validateEnvelope(withoutField(validRequest, field), { now: NOW }), 'malformed');
  });

  it.each([
    ['protocolVersion wrong type', { ...asRecord(validRequest), protocolVersion: 1 }],
    ['operation wrong type', { ...asRecord(validRequest), operation: 1 }],
    ['operationId wrong type', { ...asRecord(validRequest), operationId: 1 }],
    ['sender wrong type', { ...asRecord(validRequest), sender: 'runtime-a' }],
    [
      'sender.sessionId missing',
      { ...asRecord(validRequest), sender: withoutField(validRequest.sender, 'sessionId') },
    ],
    [
      'sender.sessionId wrong type',
      {
        ...asRecord(validRequest),
        sender: { ...validRequest.sender, sessionId: 42 },
      },
    ],
    [
      'sender.runtimeId missing',
      { ...asRecord(validRequest), sender: withoutField(validRequest.sender, 'runtimeId') },
    ],
    [
      'sender.runtimeId wrong type',
      {
        ...asRecord(validRequest),
        sender: { ...validRequest.sender, runtimeId: 42 },
      },
    ],
    ['recipientRuntimeId wrong type', { ...asRecord(validRequest), recipientRuntimeId: 42 }],
    ['roomId wrong type', { ...asRecord(validRequest), roomId: 42 }],
    ['createdAt wrong type', { ...asRecord(validRequest), createdAt: 42 }],
    ['expiresAt wrong type', { ...asRecord(validRequest), expiresAt: 42 }],
    ['traceId wrong type', { ...asRecord(validRequest), traceId: 42 }],
    ['payload wrong type', { ...asRecord(validRequest), payload: 'request' }],
  ] as const)('rejects %s as malformed before admission', (_label, candidate) => {
    expectFailure(validateEnvelope(candidate, { now: NOW }), 'malformed');
  });
  it.each([
    [
      'empty sender sessionId',
      { ...asRecord(validRequest), sender: { ...validRequest.sender, sessionId: '' } },
    ],
    [
      'control sender sessionId',
      {
        ...asRecord(validRequest),
        sender: { ...validRequest.sender, sessionId: 'session-\u0000-a' },
      },
    ],
    [
      'empty sender runtimeId',
      { ...asRecord(validRequest), sender: { ...validRequest.sender, runtimeId: '' } },
    ],
    [
      'control sender runtimeId',
      {
        ...asRecord(validRequest),
        sender: { ...validRequest.sender, runtimeId: 'runtime-\u0007-a' },
      },
    ],
    ['empty recipient runtimeId', { ...asRecord(validRequest), recipientRuntimeId: '' }],
    [
      'control recipient runtimeId',
      { ...asRecord(validRequest), recipientRuntimeId: 'runtime-\u000b-b' },
    ],
  ] as const)('rejects %s identifiers as malformed before admission', (_label, candidate) => {
    expectFailure(validateEnvelope(candidate, { now: NOW }), 'malformed');
  });
  it.each([
    ['room id missing canonical prefix', { ...asRecord(validRequest), roomId: ROOM_ID.slice(3) }],
    ['room id wrong length', { ...asRecord(validRequest), roomId: ROOM_ID.slice(0, -1) }],
    ['room id uppercase', { ...asRecord(validRequest), roomId: ROOM_ID.toUpperCase() }],
    ['room id with extra suffix', { ...asRecord(validRequest), roomId: `${ROOM_ID}0` }],
  ] as const)('rejects %s as malformed before admission', (_label, candidate) => {
    expectFailure(validateEnvelope(candidate, { now: NOW }), 'malformed');
  });

  it.each([
    ['message.request missing requestId', withoutField(validRequest, 'requestId')],
    ['message.request non-UUID requestId', { ...asRecord(validRequest), requestId: 'not-a-uuid' }],
    ['message.request wrong-type requestId', { ...asRecord(validRequest), requestId: 42 }],
    ['message.request mismatched requestId', { ...asRecord(validRequest), requestId: OTHER_ID }],
    ['message.reply missing target requestId', withoutField(validReply, 'requestId')],
    [
      'message.reply non-UUID target requestId',
      { ...asRecord(validReply), requestId: 'not-a-uuid' },
    ],
    [
      'message.reply same-ID target requestId',
      { ...asRecord(validReply), requestId: REPLY_OPERATION_ID },
    ],
    ['task.status missing target requestId', withoutField(validStatus, 'requestId')],
    [
      'task.status non-UUID target requestId',
      { ...asRecord(validStatus), requestId: 'not-a-uuid' },
    ],
    [
      'task.status same-ID target requestId',
      { ...asRecord(validStatus), requestId: STATUS_OPERATION_ID },
    ],
    ['task.cancel missing target requestId', withoutField(validCancel, 'requestId')],
    [
      'task.cancel non-UUID target requestId',
      { ...asRecord(validCancel), requestId: 'not-a-uuid' },
    ],
    [
      'task.cancel same-ID target requestId',
      { ...asRecord(validCancel), requestId: CANCEL_OPERATION_ID },
    ],
  ] as const)('rejects %s as malformed before admission', (_label, candidate) => {
    expectFailure(validateEnvelope(candidate, { now: NOW }), 'malformed');
  });

  it.each([
    ['peer.describe', validDescribe],
    ['message.request', validRequest],
    ['message.reply', validReply],
    ['message.notify', validNotify],
    ['task.status', validStatus],
    ['task.cancel', validCancel],
  ] as const)('rejects a non-UUID operationId for %s before admission', (_operation, envelope) => {
    expectFailure(
      validateEnvelope({ ...asRecord(envelope), operationId: 'not-a-uuid' }, { now: NOW }),
      'malformed',
    );
  });

  it.each([
    ['message.reply', validReply],
    ['task.status', validStatus],
    ['task.cancel', validCancel],
  ] as const)(
    'accepts a distinct operationId for %s target correlation',
    (_operation, envelope) => {
      expect(validateEnvelope(envelope, { now: NOW }).ok).toBe(true);
    },
  );

  it('omits requestId for peer.describe and message.notify, rejecting unexpected IDs', () => {
    expect(validateEnvelope(validDescribe, { now: NOW }).ok).toBe(true);
    expect(validateEnvelope(validNotify, { now: NOW }).ok).toBe(true);

    expectFailure(
      validateEnvelope({ ...validDescribe, requestId: REQUEST_ID }, { now: NOW }),
      'malformed',
    );
    expectFailure(
      validateEnvelope({ ...validNotify, requestId: REQUEST_ID }, { now: NOW }),
      'malformed',
    );
  });

  it('rejects malformed UUIDv4 operation and parent IDs', () => {
    expectFailure(
      validateEnvelope(
        { ...asRecord(validRequest), operationId: '8b6f4f7e-1fc4-5c4e-8e4c-5a3c7427c4d1' },
        { now: NOW },
      ),
      'malformed',
    );
    expectFailure(
      validateEnvelope(
        { ...asRecord(validRequest), parentOperationId: 'not-a-uuid' },
        { now: NOW },
      ),
      'malformed',
    );
    expect(
      validateEnvelope({ ...asRecord(validRequest), parentOperationId: OTHER_ID }, { now: NOW }).ok,
    ).toBe(true);
  });

  it('validates UUIDv4 and RFC 3339 UTC helpers at their boundaries', () => {
    expect(isIdentityUuidV4(REQUEST_ID)).toBe(true);
    expect(isValidationUuidV4(REQUEST_ID)).toBe(true);
    expect(isIdentityUuidV4('8b6f4f7e-1fc4-5c4e-8e4c-5a3c7427c4d1')).toBe(false);
    expect(parseRfc3339Utc(CREATED_AT)).toBe(Date.parse(CREATED_AT));
    expect(isRfc3339Utc(CREATED_AT)).toBe(true);
    expect(parseRfc3339Utc('2026-08-07T10:00:00+00:00')).toBeUndefined();
    expect(isRfc3339Utc('2026-02-30T10:00:00Z')).toBe(false);
  });

  it('rejects non-UTC timestamps, invalid dates, and malformed trace IDs', () => {
    expectFailure(
      validateEnvelope(
        { ...asRecord(validRequest), createdAt: '2026-08-07T10:00:00+00:00' },
        { now: NOW },
      ),
      'malformed',
    );
    expectFailure(
      validateEnvelope(
        { ...asRecord(validRequest), expiresAt: '2026-02-30T10:00:00Z' },
        { now: NOW },
      ),
      'malformed',
    );
    expectFailure(
      validateEnvelope(
        { ...asRecord(validRequest), traceId: TRACE_ID.toUpperCase() },
        { now: NOW },
      ),
      'malformed',
    );
    expectFailure(
      validateEnvelope({ ...asRecord(validRequest), traceId: TRACE_ID.slice(1) }, { now: NOW }),
      'malformed',
    );
  });

  it('rejects invalid expiry ordering, expired operations, and future clock skew', () => {
    expectFailure(
      validateEnvelope({ ...asRecord(validRequest), expiresAt: CREATED_AT }, { now: NOW }),
      'malformed',
    );
    expectFailure(
      validateEnvelope(
        { ...asRecord(validRequest), expiresAt: '2026-08-07T10:00:01.000Z' },
        { now: '2026-08-07T10:00:01.000Z' },
      ),
      'expired',
    );
    expectFailure(
      validateEnvelope(
        {
          ...asRecord(validRequest),
          createdAt: '2026-08-07T10:10:01.000Z',
          expiresAt: '2026-08-07T10:20:00.000Z',
        },
        { now: NOW },
      ),
      'malformed',
    );
  });
});

describe('typed content and schema validation', () => {
  it('keeps JSON-looking text typed as text and accepts structured JSON', () => {
    const text = validateContent({ type: 'text', text: '{"ready":true}' });
    const json = validateContent({ type: 'json', value: { ready: true, items: [1, 2] } });

    expect(text.ok).toBe(true);
    expect(json.ok).toBe(true);
    if (text.ok) {
      expect(text.value).toEqual({ type: 'text', text: '{"ready":true}' });
    }
    if (json.ok) {
      expect(json.value).toEqual({ type: 'json', value: { ready: true, items: [1, 2] } });
    }
  });

  it('maps malformed content shapes and non-JSON values to stable errors', () => {
    expectFailure(validateContent(null), 'malformed');
    expectFailure(validateContent({ type: 'text', text: 42 }), 'invalid_content');
    expectFailure(validateContent({ type: 'json' }), 'invalid_content');
    expectFailure(validateContent({ type: 'json', value: Number.NaN }), 'invalid_content');
    expectFailure(validateContent({ type: 'xml', value: '<x />' }), 'invalid_content');
    expectFailure(
      validateEnvelope(
        { ...asRecord(validRequest), payload: { metadata: { source: 'fixture' } } },
        { now: NOW },
      ),
      'invalid_content',
    );
  });

  it('accepts local Draft 2020-12 references and enforces the referenced schema', () => {
    expect(validateJsonSchema(localSchema).ok).toBe(true);
    expect(validateExpectedResponse({ contentType: 'json', schema: localSchema }).ok).toBe(true);

    const matching = validateJsonValueAgainstSchema({ id: 'alice' }, localSchema);
    const mismatching = validateJsonValueAgainstSchema({ id: 'ALICE' }, localSchema);

    expect(matching.ok).toBe(true);
    expectFailure(mismatching, 'invalid_content');
  });
  it('admits a valid expectedResponse at message.request envelope validation', () => {
    const envelope = {
      ...asRecord(validRequest),
      payload: {
        ...validRequest.payload,
        expectedResponse: { contentType: 'json', schema: localSchema },
      },
    };
    expect(validateEnvelope(envelope, { now: NOW }).ok).toBe(true);
  });

  it('rejects remote and unresolved local schema references without network access', () => {
    const remote = validateJsonSchema({ $ref: 'https://example.test/schema.json' });
    const unresolved = validateJsonSchema({ $ref: '#/$defs/missing' });

    expectFailure(remote, 'incompatible');
    expectFailure(unresolved, 'malformed');
  });

  it.each([
    ['remote schema reference', { $ref: 'https://example.test/schema.json' }, 'incompatible'],
    ['unresolved local schema reference', { $ref: '#/$defs/missing' }, 'malformed'],
    ['oversized schema', { description: 'x'.repeat(MAX_SCHEMA_BYTES) }, 'oversized'],
    [
      'required format assertion vocabulary',
      {
        $schema: JSON_SCHEMA_DRAFT_2020_12,
        $vocabulary: {
          'https://json-schema.org/draft/2020-12/vocab/format-assertion': true,
        },
        type: 'string',
        format: 'date-time',
      },
      'incompatible',
    ],
  ] as const)('rejects %s at message.request envelope admission', (_label, schema, code) => {
    expectFailure(
      validateEnvelope(
        {
          ...asRecord(validRequest),
          payload: {
            ...validRequest.payload,
            expectedResponse: { contentType: 'json', schema },
          },
        },
        { now: NOW },
      ),
      code,
    );
  });
  it.each([
    ['expected response missing schema', { contentType: 'json' }, 'malformed'],
    ['expected response wrong contentType', { contentType: 'text', schema: {} }, 'incompatible'],
    [
      'expected response non-Draft-2020-12 schema',
      { contentType: 'json', schema: { $schema: 'https://json-schema.org/draft-07/schema#' } },
      'incompatible',
    ],
  ] as const)(
    'rejects %s at message.request envelope admission',
    (_label, expectedResponse, code) => {
      expectFailure(
        validateEnvelope(
          {
            ...asRecord(validRequest),
            payload: { ...validRequest.payload, expectedResponse },
          },
          { now: NOW },
        ),
        code,
      );
    },
  );

  it.each([
    ['completed', validReply.payload],
    ['failed', { outcome: 'failed', error: createProtocolError('internal', 'failed fixture') }],
    [
      'rejected',
      { outcome: 'rejected', error: createProtocolError('malformed', 'rejected fixture') },
    ],
    ['cancelled without error', { outcome: 'cancelled' }],
    [
      'cancelled with error',
      { outcome: 'cancelled', error: createProtocolError('cancelled', 'cancelled fixture') },
    ],
    ['expired without error', { outcome: 'expired' }],
    [
      'expired with error',
      { outcome: 'expired', error: createProtocolError('expired', 'expired fixture') },
    ],
  ] as const)('accepts a valid %s reply outcome at envelope admission', (_label, payload) => {
    expect(validateEnvelope({ ...asRecord(validReply), payload }, { now: NOW }).ok).toBe(true);
  });
  it.each([
    ['notify missing content', { ...asRecord(validNotify), payload: {} }, 'invalid_content'],
    [
      'notify invalid content discriminant',
      {
        ...asRecord(validNotify),
        payload: { content: { type: 'xml', value: '<event />' } },
      },
      'invalid_content',
    ],
    [
      'reply completed missing content',
      { ...asRecord(validReply), payload: { outcome: 'completed' } },
      'invalid_content',
    ],
    [
      'reply completed invalid content',
      {
        ...asRecord(validReply),
        payload: { outcome: 'completed', content: { type: 'xml', value: '<reply />' } },
      },
      'invalid_content',
    ],
    [
      'reply failed missing wire error',
      { ...asRecord(validReply), payload: { outcome: 'failed' } },
      'malformed',
    ],
    [
      'rejected missing wire error',
      { ...asRecord(validReply), payload: { outcome: 'rejected' } },
      'malformed',
    ],
    [
      'failed reply with content',
      {
        ...asRecord(validReply),
        payload: {
          outcome: 'failed',
          content: { type: 'text', text: 'not allowed' },
          error: createProtocolError('internal', 'failed fixture'),
        },
      },
      'malformed',
    ],
    [
      'rejected reply with content',
      {
        ...asRecord(validReply),
        payload: {
          outcome: 'rejected',
          content: { type: 'text', text: 'not allowed' },
          error: createProtocolError('malformed', 'rejected fixture'),
        },
      },
      'malformed',
    ],
    [
      'cancelled reply with content',
      {
        ...asRecord(validReply),
        payload: { outcome: 'cancelled', content: { type: 'text', text: 'not allowed' } },
      },
      'malformed',
    ],
    [
      'expired reply with content',
      {
        ...asRecord(validReply),
        payload: { outcome: 'expired', content: { type: 'text', text: 'not allowed' } },
      },
      'malformed',
    ],
    [
      'completed reply with error',
      {
        ...asRecord(validReply),
        payload: {
          outcome: 'completed',
          content: { type: 'text', text: 'done' },
          error: createProtocolError('internal', 'not allowed'),
        },
      },
      'malformed',
    ],
    [
      'reply unsupported outcome',
      { ...asRecord(validReply), payload: { outcome: 'working' } },
      'malformed',
    ],
  ] as const)('rejects %s at envelope admission', (_label, envelope, code) => {
    expectFailure(validateEnvelope(envelope, { now: NOW }), code);
  });

  it('enforces the schema-size limit and leaves format as annotation-only', () => {
    const tooLarge = validateJsonSchema({ description: 'x'.repeat(MAX_SCHEMA_BYTES) });
    const formatOnly = validateJsonValueAgainstSchema('not-a-date', {
      type: 'string',
      format: 'date-time',
    });

    expectFailure(tooLarge, 'oversized');
    expect(formatOnly.ok).toBe(true);
    expectFailure(validateExpectedResponse({ contentType: 'text', schema: {} }), 'incompatible');
  });

  it('validates replies against expected JSON schemas and maps mismatches to invalid_reply', () => {
    const expected = {
      contentType: 'json',
      schema: {
        type: 'object',
        required: ['answer'],
        properties: { answer: { type: 'string' } },
        additionalProperties: false,
      },
    };

    expect(validateReplyContent({ type: 'json', value: { answer: 'yes' } }, expected).ok).toBe(
      true,
    );
    expectFailure(
      validateReplyContent({ type: 'json', value: { answer: 42 } }, expected),
      'invalid_reply',
    );
    expectFailure(validateReplyContent({ type: 'text', text: 'yes' }, expected), 'invalid_reply');
  });
});

describe('operation responses, versions, and limits', () => {
  const validRequestResponse = {
    protocolVersion: PROTOCOL_VERSION,
    operation: 'message.request',
    operationId: REQUEST_ID,
    traceId: TRACE_ID,
    result: { requestId: REQUEST_ID, state: 'accepted' },
  } as const;

  const validOperationResponses = [
    [
      'peer.describe',
      {
        protocolVersion: PROTOCOL_VERSION,
        operation: 'peer.describe',
        operationId: DESCRIBE_OPERATION_ID,
        traceId: TRACE_ID,
        result: { agentCard: validAgentCard },
      },
    ],
    ['message.request', validRequestResponse],
    [
      'message.reply',
      {
        protocolVersion: PROTOCOL_VERSION,
        operation: 'message.reply',
        operationId: REPLY_OPERATION_ID,
        traceId: TRACE_ID,
        result: { requestId: REQUEST_ID, outcome: 'completed', delivered: true },
      },
    ],
    [
      'message.notify',
      {
        protocolVersion: PROTOCOL_VERSION,
        operation: 'message.notify',
        operationId: OTHER_ID,
        traceId: TRACE_ID,
        result: { delivered: true },
      },
    ],
    [
      'task.status',
      {
        protocolVersion: PROTOCOL_VERSION,
        operation: 'task.status',
        operationId: STATUS_OPERATION_ID,
        traceId: TRACE_ID,
        result: { snapshot: validTaskSnapshot },
      },
    ],
    [
      'task.cancel',
      {
        protocolVersion: PROTOCOL_VERSION,
        operation: 'task.cancel',
        operationId: CANCEL_OPERATION_ID,
        traceId: TRACE_ID,
        result: { snapshot: validTaskSnapshot },
      },
    ],
  ] as const;

  it.each(validOperationResponses)(
    'accepts a valid %s operation result',
    (_operation, response) => {
      expect(validateOperationResponse(response, { now: NOW }).ok).toBe(true);
    },
  );
  it('rejects expectedRequestId mismatches for replies, status, and cancellation responses', () => {
    expectFailure(
      validateOperationResponse(validOperationResponses[2][1], {
        expectedRequestId: OTHER_ID,
      }),
      'malformed',
    );
    expectFailure(
      validateOperationResponse(
        {
          ...asRecord(validOperationResponses[4][1]),
          result: { snapshot: { ...validTaskSnapshot, requestId: OTHER_ID } },
        },
        { expectedRequestId: REQUEST_ID },
      ),
      'malformed',
    );
    expectFailure(
      validateOperationResponse(
        {
          ...asRecord(validOperationResponses[5][1]),
          result: { snapshot: { ...validTaskSnapshot, requestId: OTHER_ID } },
        },
        { expectedRequestId: REQUEST_ID },
      ),
      'malformed',
    );
  });

  it.each([
    ['peer.describe missing agent card', validOperationResponses[0][1], {}],
    [
      'message.request invalid admission state',
      validRequestResponse,
      { requestId: REQUEST_ID, state: 'working' },
    ],
    [
      'message.reply missing delivery acknowledgment',
      validOperationResponses[2][1],
      { requestId: REQUEST_ID, outcome: 'completed' },
    ],
    ['message.notify not acknowledged', validOperationResponses[3][1], { delivered: false }],
    ['task.status missing snapshot', validOperationResponses[4][1], {}],
    [
      'task.cancel invalid snapshot',
      validOperationResponses[5][1],
      { snapshot: { ...validTaskSnapshot, state: 'unknown' } },
    ],
  ] as const)('rejects %s with malformed result data', (_label, response, result) => {
    expectFailure(
      validateOperationResponse({ ...asRecord(response), result }, { now: NOW }),
      'malformed',
    );
  });

  it.each([
    ['missing operation', withoutField(validRequestResponse, 'operation')],
    ['wrong-type operation', { ...asRecord(validRequestResponse), operation: 42 }],
    ['missing operationId', withoutField(validRequestResponse, 'operationId')],
    ['non-UUID operationId', { ...asRecord(validRequestResponse), operationId: 'not-a-uuid' }],
    ['missing traceId', withoutField(validRequestResponse, 'traceId')],
    ['wrong-type traceId', { ...asRecord(validRequestResponse), traceId: 42 }],
    ['malformed traceId', { ...asRecord(validRequestResponse), traceId: TRACE_ID.slice(1) }],
  ] as const)('rejects %s response envelope field as malformed', (_label, response) => {
    expectFailure(validateOperationResponse(response, { now: NOW }), 'malformed');
  });

  it('rejects an oversized operation response before result validation', () => {
    expectFailure(
      validateOperationResponse(validRequestResponse, { now: NOW, maxEnvelopeBytes: 64 }),
      'oversized',
    );
  });
  it('requires exactly one operation response result or error and preserves correlation', () => {
    expect(validateOperationResponse(validRequestResponse).ok).toBe(true);

    expectFailure(
      validateOperationResponse({
        ...asRecord(validRequestResponse),
        error: createProtocolError('busy', 'queue is full'),
      }),
      'malformed',
    );
    expectFailure(
      validateOperationResponse(withoutField(validRequestResponse, 'result')),
      'malformed',
    );
    expectFailure(
      validateOperationResponse({
        ...asRecord(validRequestResponse),
        result: { requestId: OTHER_ID, state: 'accepted' },
      }),
      'malformed',
    );
  });

  it('rejects malformed wire-error fields with malformed mapping', () => {
    const validWireError = createProtocolError('busy', 'queue is full', { retryAfterMs: 250 });
    const validWireErrorResponse = {
      ...withoutField(validRequestResponse, 'result'),
      error: validWireError,
    };
    const malformedErrors = [
      ['error is not an object', null],
      ['missing code', withoutField(validWireError, 'code')],
      ['unknown code', { ...asRecord(validWireError), code: 'unknown' }],
      ['wrong-type code', { ...asRecord(validWireError), code: 42 }],
      ['missing message', withoutField(validWireError, 'message')],
      ['wrong-type message', { ...asRecord(validWireError), message: 42 }],
      ['missing retryable', withoutField(validWireError, 'retryable')],
      ['wrong-type retryable', { ...asRecord(validWireError), retryable: 'yes' }],
      ['retryability mismatch', { ...asRecord(validWireError), retryable: false }],
      ['retryAfterMs zero', { ...asRecord(validWireError), retryAfterMs: 0 }],
      ['retryAfterMs negative', { ...asRecord(validWireError), retryAfterMs: -1 }],
      ['retryAfterMs non-finite', { ...asRecord(validWireError), retryAfterMs: Number.NaN }],
      [
        'retryAfterMs on permanent code',
        { code: 'malformed', message: 'bad envelope', retryable: false, retryAfterMs: 100 },
      ],
      ['details is not an object', { ...asRecord(validWireError), details: [] }],
    ] as const;
    for (const [, error] of malformedErrors) {
      expectFailure(
        validateOperationResponse({ ...asRecord(validWireErrorResponse), error }, { now: NOW }),
        'malformed',
      );
    }
  });

  it('maps unsupported versions and operations to incompatible', () => {
    expectFailure(
      validateEnvelope({ ...asRecord(validRequest), protocolVersion: '2.0' }, { now: NOW }),
      'incompatible',
    );
    expectFailure(
      validateEnvelope({ ...asRecord(validRequest), operation: 'message.unknown' }, { now: NOW }),
      'incompatible',
    );
    expectFailure(
      validateOperationResponse({ ...asRecord(validRequestResponse), protocolVersion: '2.0' }),
      'incompatible',
    );
    for (const version of ['0.9', '1.1']) {
      expectFailure(
        validateEnvelope({ ...asRecord(validRequest), protocolVersion: version }, { now: NOW }),
        'incompatible',
      );
      expectFailure(
        validateOperationResponse({ ...asRecord(validRequestResponse), protocolVersion: version }),
        'incompatible',
      );
    }
    expect(
      validateEnvelope(
        {
          ...asRecord(validDescribe),
          payload: { requestedProtocolVersion: PROTOCOL_VERSION },
        },
        { now: NOW },
      ).ok,
    ).toBe(true);
    expectFailure(
      validateEnvelope(
        { ...asRecord(validDescribe), payload: { requestedProtocolVersion: '0.9' } },
        { now: NOW },
      ),
      'incompatible',
    );
    expectFailure(
      validateEnvelope(
        { ...asRecord(validDescribe), payload: { requestedProtocolVersion: '1.1' } },
        { now: NOW },
      ),
      'incompatible',
    );
    expectFailure(
      validateEnvelope(
        { ...asRecord(validDescribe), payload: { requestedProtocolVersion: 1 } },
        { now: NOW },
      ),
      'malformed',
    );
    expectFailure(
      validateOperationResponse(
        {
          ...asRecord(validRequestResponse),
          operation: 'message.unknown',
          result: {},
        },
        { now: NOW },
      ),
      'incompatible',
    );
    expect(
      validateEnvelope(
        { ...asRecord(validRequest), optionalExtension: { fixture: true } },
        { now: NOW },
      ).ok,
    ).toBe(true);
  });

  it('validates peer.describe capability versions and advertised limits', () => {
    const response = {
      protocolVersion: PROTOCOL_VERSION,
      operation: 'peer.describe',
      operationId: DESCRIBE_OPERATION_ID,
      traceId: TRACE_ID,
      result: { agentCard: validAgentCard },
    };

    expect(validateOperationResponse(response).ok).toBe(true);
    expectFailure(
      validateOperationResponse({
        ...response,
        result: { agentCard: { ...validAgentCard, supportedProtocolVersions: ['2.0'] } },
      }),
      'incompatible',
    );
    expectFailure(
      validateOperationResponse({
        ...response,
        result: {
          agentCard: {
            ...validAgentCard,
            limits: { ...validAgentCard.limits, maxQueueEntries: DEFAULT_QUEUE_LIMIT + 1 },
          },
        },
      }),
      'malformed',
    );
  });
  it.each([
    ['missing agent card name', withoutField(validAgentCard, 'name'), 'malformed'],
    ['missing agent card sessionId', withoutField(validAgentCard, 'sessionId'), 'malformed'],
    ['missing agent card runtimeId', withoutField(validAgentCard, 'runtimeId'), 'malformed'],
    [
      'missing supported protocol versions',
      withoutField(validAgentCard, 'supportedProtocolVersions'),
      'incompatible',
    ],
    [
      'empty supported protocol versions',
      { ...validAgentCard, supportedProtocolVersions: [] },
      'incompatible',
    ],
    [
      'duplicate supported protocol versions',
      { ...validAgentCard, supportedProtocolVersions: [PROTOCOL_VERSION, PROTOCOL_VERSION] },
      'malformed',
    ],
    [
      'unsupported supported protocol version',
      { ...validAgentCard, supportedProtocolVersions: ['1.1'] },
      'incompatible',
    ],
    ['missing operations', withoutField(validAgentCard, 'operations'), 'malformed'],
    ['empty operations', { ...validAgentCard, operations: [] }, 'malformed'],
    [
      'operation capability missing operation',
      { ...validAgentCard, operations: [{}] },
      'malformed',
    ],
    [
      'duplicate operation capability',
      {
        ...validAgentCard,
        operations: [{ operation: 'peer.describe' }, ...validAgentCard.operations],
      },
      'malformed',
    ],
    [
      'unsupported operation capability',
      { ...validAgentCard, operations: [{ operation: 'message.unknown' }] },
      'incompatible',
    ],
    [
      'missing content capabilities',
      withoutField(validAgentCard, 'contentCapabilities'),
      'malformed',
    ],
    ['empty content capabilities', { ...validAgentCard, contentCapabilities: [] }, 'malformed'],
    [
      'content capability missing type',
      { ...validAgentCard, contentCapabilities: [{}] },
      'malformed',
    ],
    [
      'duplicate content capability',
      { ...validAgentCard, contentCapabilities: [{ type: 'text' }, { type: 'text' }] },
      'malformed',
    ],
    [
      'unsupported content capability',
      { ...validAgentCard, contentCapabilities: [{ type: 'xml' }] },
      'malformed',
    ],
    [
      'non-boolean content schema capability',
      { ...validAgentCard, contentCapabilities: [{ type: 'json', supportsSchema: 'yes' }] },
      'malformed',
    ],
    ['missing capabilities', withoutField(validAgentCard, 'capabilities'), 'malformed'],
    [
      'missing cancellation capability',
      {
        ...validAgentCard,
        capabilities: withoutField(validAgentCard.capabilities, 'supportsCancellation'),
      },
      'malformed',
    ],
    [
      'non-boolean cancellation capability',
      {
        ...validAgentCard,
        capabilities: { ...validAgentCard.capabilities, supportsCancellation: 'yes' },
      },
      'malformed',
    ],
    [
      'missing notification capability',
      {
        ...validAgentCard,
        capabilities: withoutField(validAgentCard.capabilities, 'supportsNotifications'),
      },
      'malformed',
    ],
    [
      'non-boolean notification capability',
      {
        ...validAgentCard,
        capabilities: { ...validAgentCard.capabilities, supportsNotifications: 1 },
      },
      'malformed',
    ],
    ['missing limits', withoutField(validAgentCard, 'limits'), 'malformed'],
    [
      'missing requestTtlMs limit',
      { ...validAgentCard, limits: withoutField(validAgentCard.limits, 'requestTtlMs') },
      'malformed',
    ],
    [
      'missing maxRequestTtlMs limit',
      { ...validAgentCard, limits: withoutField(validAgentCard.limits, 'maxRequestTtlMs') },
      'malformed',
    ],
    [
      'missing maxControlTtlMs limit',
      { ...validAgentCard, limits: withoutField(validAgentCard.limits, 'maxControlTtlMs') },
      'malformed',
    ],
    [
      'missing maxEnvelopeBytes limit',
      { ...validAgentCard, limits: withoutField(validAgentCard.limits, 'maxEnvelopeBytes') },
      'malformed',
    ],
    [
      'missing maxSchemaBytes limit',
      { ...validAgentCard, limits: withoutField(validAgentCard.limits, 'maxSchemaBytes') },
      'malformed',
    ],
    [
      'missing maxQueueEntries limit',
      { ...validAgentCard, limits: withoutField(validAgentCard.limits, 'maxQueueEntries') },
      'malformed',
    ],
  ] as const)('rejects %s in an Agent Card', (_label, agentCard, code) => {
    expectFailure(validateOperationResponse(makeDescribeResponse(agentCard)), code);
  });
  it('accepts explicit false cancellation and notification capability booleans', () => {
    expect(
      validateOperationResponse(
        makeDescribeResponse({
          ...validAgentCard,
          capabilities: { supportsCancellation: false, supportsNotifications: false },
        }),
      ).ok,
    ).toBe(true);
  });
  it.each(AGENT_CARD_LIMIT_CEILINGS)(
    'accepts Agent Card %s at its exact v1 ceiling',
    (field, ceiling) => {
      expect(
        validateOperationResponse(
          makeDescribeResponse({
            ...validAgentCard,
            limits: { ...validAgentCard.limits, [field]: ceiling },
          }),
        ).ok,
      ).toBe(true);
    },
  );
  it.each(AGENT_CARD_LIMIT_CEILINGS)(
    'rejects Agent Card %s above its v1 ceiling',
    (field, ceiling) => {
      expectFailure(
        validateOperationResponse(
          makeDescribeResponse({
            ...validAgentCard,
            limits: { ...validAgentCard.limits, [field]: ceiling + 1 },
          }),
        ),
        'malformed',
      );
    },
  );
  it.each(AGENT_CARD_LIMIT_CEILINGS)(
    'rejects zero and non-integer Agent Card %s limits',
    (field) => {
      for (const value of [0, 1.5]) {
        expectFailure(
          validateOperationResponse(
            makeDescribeResponse({
              ...validAgentCard,
              limits: { ...validAgentCard.limits, [field]: value },
            }),
          ),
          'malformed',
        );
      }
    },
  );
  it('rejects an Agent Card whose request TTL exceeds its maximum TTL', () => {
    expectFailure(
      validateOperationResponse(
        makeDescribeResponse({
          ...validAgentCard,
          limits: {
            ...validAgentCard.limits,
            requestTtlMs: MAX_REQUEST_TTL_MS,
            maxRequestTtlMs: DEFAULT_REQUEST_TTL_MS,
          },
        }),
      ),
      'malformed',
    );
  });
  it.each(AGENT_CARD_LIMIT_CEILINGS)(
    'accepts configured %s at its exact v1 ceiling',
    (field, ceiling) => {
      const overrides =
        field === 'maxRequestTtlMs'
          ? { [field]: ceiling, requestTtlMs: DEFAULT_REQUEST_TTL_MS }
          : { [field]: ceiling };
      expect(createProtocolConfig(overrides)).toMatchObject(overrides);
    },
  );
  it.each([
    ['requestTtlMs', { requestTtlMs: DEFAULT_REQUEST_TTL_MS - 1 }],
    [
      'maxRequestTtlMs',
      { requestTtlMs: DEFAULT_REQUEST_TTL_MS, maxRequestTtlMs: DEFAULT_REQUEST_TTL_MS },
    ],
    ['maxControlTtlMs', { maxControlTtlMs: MAX_CONTROL_TTL_MS - 1 }],
    ['maxEnvelopeBytes', { maxEnvelopeBytes: MAX_ENVELOPE_BYTES - 1 }],
    ['maxSchemaBytes', { maxSchemaBytes: MAX_SCHEMA_BYTES - 1 }],
    ['maxQueueEntries', { maxQueueEntries: DEFAULT_QUEUE_LIMIT - 1 }],
  ] as const)('accepts stricter configured %s overrides', (_field, overrides) => {
    expect(createProtocolConfig(overrides)).toMatchObject(overrides);
  });
  it.each(AGENT_CARD_LIMIT_CEILINGS)(
    'rejects configured %s above its v1 ceiling',
    (field, ceiling) => {
      expect(() => createProtocolConfig({ [field]: ceiling + 1 })).toThrow(RangeError);
    },
  );
  it.each(AGENT_CARD_LIMIT_CEILINGS)(
    'rejects zero and non-integer configured %s overrides',
    (field) => {
      for (const value of [0, 1.5]) {
        expect(() => createProtocolConfig({ [field]: value })).toThrow(RangeError);
      }
    },
  );
  it('rejects configured request TTL values that exceed maxRequestTtlMs', () => {
    expect(() =>
      createProtocolConfig({
        requestTtlMs: DEFAULT_REQUEST_TTL_MS + 1,
        maxRequestTtlMs: DEFAULT_REQUEST_TTL_MS,
      }),
    ).toThrow(RangeError);
  });

  it('enforces normal, control, envelope, and schema limits', () => {
    expectFailure(
      validateEnvelope(
        {
          ...asRecord(validRequest),
          expiresAt: '2026-08-07T11:00:01.000Z',
        },
        { now: NOW },
      ),
      'malformed',
    );
    expectFailure(validateEnvelope(validRequest, { now: NOW, maxEnvelopeBytes: 64 }), 'oversized');
    expectFailure(
      validateJsonSchema({ description: 'bounded fixture' }, { maxSchemaBytes: 8 }),
      'oversized',
    );

    expect(DEFAULT_PROTOCOL_LIMITS).toEqual({
      requestTtlMs: DEFAULT_REQUEST_TTL_MS,
      maxRequestTtlMs: MAX_REQUEST_TTL_MS,
      maxControlTtlMs: MAX_CONTROL_TTL_MS,
      maxEnvelopeBytes: MAX_ENVELOPE_BYTES,
      maxSchemaBytes: MAX_SCHEMA_BYTES,
      maxQueueEntries: DEFAULT_QUEUE_LIMIT,
    });
    expect(createProtocolConfig({ maxQueueEntries: 4 }).maxQueueEntries).toBe(4);
    expect(() => createProtocolConfig({ maxQueueEntries: DEFAULT_QUEUE_LIMIT + 1 })).toThrow(
      RangeError,
    );
  });
  it.each([
    ['peer.describe', validDescribe],
    ['task.status', validStatus],
    ['task.cancel', validCancel],
  ] as const)(
    'enforces the 30-second control limit for %s at its exact boundary',
    (_operation, envelope) => {
      expect(
        validateEnvelope({ ...asRecord(envelope), expiresAt: CONTROL_EXPIRES_AT }, { now: NOW }).ok,
      ).toBe(true);
      expectFailure(
        validateEnvelope(
          { ...asRecord(envelope), expiresAt: '2026-08-07T10:00:31.000Z' },
          { now: NOW },
        ),
        'malformed',
      );
    },
  );
});

describe('canonical request fingerprints', () => {
  it('canonicalizes object key order deterministically', () => {
    expect(canonicalizeJson({ z: 1, a: [true, null] })).toBe('{"a":[true,null],"z":1}');
  });

  it('excludes binding credentials but fingerprints application metadata named token', () => {
    const withCredentials = {
      ...asRecord(validRequest),
      bindingCredentials: { token: 'fixture-secret-a' },
    };
    const withDifferentCredentials = {
      ...asRecord(validRequest),
      bindingCredentials: { token: 'fixture-secret-b' },
    };
    const withApplicationToken = {
      ...asRecord(validRequest),
      payload: { ...validRequest.payload, metadata: { token: 'application-token-a' } },
    };
    const withDifferentApplicationToken = {
      ...asRecord(validRequest),
      payload: { ...validRequest.payload, metadata: { token: 'application-token-b' } },
    };
    const withBindingCredentialToken = {
      ...asRecord(withApplicationToken),
      bindingCredentials: { token: 'binding-token-a' },
      bindingToken: 'binding-token-a',
    };
    const withDifferentBindingCredentialToken = {
      ...asRecord(withApplicationToken),
      bindingCredentials: { token: 'binding-token-b' },
      bindingToken: 'binding-token-b',
    };
    const reordered = {
      payload: validRequest.payload,
      traceId: validRequest.traceId,
      expiresAt: validRequest.expiresAt,
      createdAt: validRequest.createdAt,
      roomId: validRequest.roomId,
      recipientRuntimeId: validRequest.recipientRuntimeId,
      sender: validRequest.sender,
      requestId: validRequest.requestId,
      operationId: validRequest.operationId,
      operation: validRequest.operation,
      protocolVersion: validRequest.protocolVersion,
    };

    const fingerprint = canonicalRequestFingerprint(withCredentials, { now: NOW });
    expect(fingerprint).toBe(canonicalRequestFingerprint(withDifferentCredentials, { now: NOW }));
    expect(fingerprint).toBe(canonicalRequestFingerprint(reordered, { now: NOW }));
    expect(canonicalRequestData(withCredentials, { now: NOW })).not.toContain('fixture-secret-a');

    const applicationFingerprint = canonicalRequestFingerprint(withApplicationToken, { now: NOW });
    expect(applicationFingerprint).not.toBe(fingerprint);
    expect(applicationFingerprint).not.toBe(
      canonicalRequestFingerprint(withDifferentApplicationToken, { now: NOW }),
    );
    expect(canonicalRequestData(withApplicationToken, { now: NOW })).toContain(
      'application-token-a',
    );
    expect(canonicalRequestFingerprint(withBindingCredentialToken, { now: NOW })).toBe(
      canonicalRequestFingerprint(withDifferentBindingCredentialToken, { now: NOW }),
    );
    expect(canonicalRequestData(withBindingCredentialToken, { now: NOW })).not.toContain(
      'binding-token-a',
    );
    expect(
      canonicalRequestFingerprint(
        { ...asRecord(validRequest), recipientRuntimeId: 'runtime-c' },
        { now: NOW },
      ),
    ).not.toBe(fingerprint);
    expect(
      canonicalRequestFingerprint(
        { ...asRecord(validRequest), payload: { content: { type: 'text', text: 'changed' } } },
        { now: NOW },
      ),
    ).not.toBe(fingerprint);
  });
  it('changes fingerprints for every mutable immutable-field fixture', () => {
    const candidates = [
      [
        'sender sessionId',
        validRequest,
        { ...asRecord(validRequest), sender: { ...validRequest.sender, sessionId: 'session-c' } },
      ],
      [
        'sender runtimeId',
        validRequest,
        { ...asRecord(validRequest), sender: { ...validRequest.sender, runtimeId: 'runtime-c' } },
      ],
      ['operationId', validReply, { ...asRecord(validReply), operationId: OTHER_ID }],
      [
        'operationId and initial requestId',
        validRequest,
        { ...asRecord(validRequest), operationId: OTHER_ID, requestId: OTHER_ID },
      ],
      ['target requestId', validReply, { ...asRecord(validReply), requestId: OTHER_ID }],
      [
        'roomId',
        validRequest,
        {
          ...asRecord(validRequest),
          roomId: deriveRoomId('explicit', 'different-conformance-room'),
        },
      ],
      [
        'createdAt',
        validRequest,
        { ...asRecord(validRequest), createdAt: '2026-08-07T10:01:00.000Z' },
      ],
      [
        'expiresAt',
        validRequest,
        { ...asRecord(validRequest), expiresAt: '2026-08-07T10:11:00.000Z' },
      ],
      [
        'traceId',
        validRequest,
        { ...asRecord(validRequest), traceId: `${TRACE_ID.slice(0, -1)}7` },
      ],
      [
        'parentOperationId',
        validRequest,
        { ...asRecord(validRequest), parentOperationId: OTHER_ID },
      ],
      [
        'operation',
        validRequest,
        withoutField(
          {
            ...asRecord(validRequest),
            operation: 'message.notify',
            payload: { content: validRequest.payload.content },
          },
          'requestId',
        ),
      ],
      [
        'recipientRuntimeId',
        validRequest,
        { ...asRecord(validRequest), recipientRuntimeId: 'runtime-c' },
      ],
      [
        'payload',
        validRequest,
        { ...asRecord(validRequest), payload: { content: { type: 'text', text: 'changed' } } },
      ],
    ] as const;
    for (const [label, original, candidate] of candidates) {
      expect(canonicalRequestFingerprint(candidate, { now: NOW }), label).not.toBe(
        canonicalRequestFingerprint(original, { now: NOW }),
      );
    }
  });
  it('binds protocolVersion into canonical data while rejecting other exact versions', () => {
    expect(canonicalRequestData(validRequest, { now: NOW })).toContain(
      `"protocolVersion":"${PROTOCOL_VERSION}"`,
    );
    expect(() =>
      canonicalRequestFingerprint(
        { ...asRecord(validRequest), protocolVersion: '1.1' },
        { now: NOW },
      ),
    ).toThrow();
  });
});

describe('stable protocol errors and retryability', () => {
  it('publishes the normative stable error taxonomy', () => {
    expect(PROTOCOL_ERROR_CODES).toEqual([
      'malformed',
      'incompatible',
      'expired',
      'cross_room',
      'ambiguous',
      'busy',
      'unauthorized',
      'oversized',
      'duplicate',
      'cancelled',
      'unreachable',
      'not_found',
      'not_cancelable',
      'invalid_content',
      'invalid_reply',
      'internal',
    ]);
  });

  it.each(
    PROTOCOL_ERROR_CODES.map((code) => [code, code === 'busy' || code === 'unreachable'] as const),
  )('validates %s retryability on the wire for every canonical error', (code, retryable) => {
    const error = createProtocolError(code, 'stable fixture message');
    const response = {
      protocolVersion: PROTOCOL_VERSION,
      operation: 'message.request',
      operationId: REQUEST_ID,
      traceId: TRACE_ID,
      error,
    };
    const result = validateOperationResponse(response, { now: NOW });
    expect(error.code).toBe(code);
    expect(error.retryable).toBe(retryable);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const validatedError = (result.value as { error: ProtocolError }).error;
      expect(validatedError.code).toBe(code);
      expect(validatedError.retryable).toBe(retryable);
    }
  });

  it('preserves retry delay only for retryable errors and rejects conflicting metadata', () => {
    const busy = createProtocolError('busy', 'queue is full', { retryAfterMs: 250 });
    const response = {
      protocolVersion: PROTOCOL_VERSION,
      operation: 'message.request',
      operationId: REQUEST_ID,
      traceId: TRACE_ID,
      error: busy,
    };

    expect(busy.retryAfterMs).toBe(250);
    expect(validateOperationResponse(response).ok).toBe(true);
    expect(() => createProtocolError('malformed', 'bad envelope', { retryable: true })).toThrow(
      RangeError,
    );
    expect(() => createProtocolError('busy', 'queue is full', { retryable: false })).toThrow(
      RangeError,
    );
    expect(() => createProtocolError('malformed', 'bad envelope', { retryAfterMs: 100 })).toThrow(
      RangeError,
    );

    expectFailure(
      validateOperationResponse({
        ...response,
        error: { ...busy, retryable: false },
      }),
      'malformed',
    );
  });

  it.each([
    ['empty', ''],
    ['leading whitespace', ' queue is full'],
    ['trailing whitespace', 'queue is full '],
    ['control character', 'queue is full\n'],
    ['overlong', 'x'.repeat(MAX_PROTOCOL_ERROR_MESSAGE_LENGTH + 1)],
  ] as const)('rejects %s wire-error message fixture', (_label, message) => {
    const error = { ...createProtocolError('busy', 'queue is full'), message };
    expectFailure(
      validateOperationResponse({
        protocolVersion: PROTOCOL_VERSION,
        operation: 'message.request',
        operationId: REQUEST_ID,
        traceId: TRACE_ID,
        error,
      }),
      'malformed',
    );
  });
  it('accepts bounded structured error details', () => {
    const error = createProtocolError('busy', 'queue is full', {
      retryAfterMs: 250,
      details: { queue: 'inbound', attempt: 2, nested: { available: false } },
    });
    const result = validateOperationResponse({
      protocolVersion: PROTOCOL_VERSION,
      operation: 'message.request',
      operationId: REQUEST_ID,
      traceId: TRACE_ID,
      error,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect((result.value as { error: ProtocolError }).error.details).toEqual(error.details);
    }
  });
  it.each([
    ['primitive string details', 'not-an-object'],
    ['primitive number details', 42],
    ['primitive boolean details', true],
    ['null details', null],
    ['array details', []],
  ] as const)('rejects %s on a wire error', (_label, details) => {
    const error = { ...createProtocolError('busy', 'queue is full'), details };
    expectFailure(
      validateOperationResponse({
        protocolVersion: PROTOCOL_VERSION,
        operation: 'message.request',
        operationId: REQUEST_ID,
        traceId: TRACE_ID,
        error,
      }),
      'malformed',
    );
  });
  it('rejects oversized structured error details', () => {
    const error = {
      ...createProtocolError('busy', 'queue is full'),
      details: { note: 'x'.repeat(MAX_ENVELOPE_BYTES) },
    };
    expectFailure(
      validateOperationResponse({
        protocolVersion: PROTOCOL_VERSION,
        operation: 'message.request',
        operationId: REQUEST_ID,
        traceId: TRACE_ID,
        error,
      }),
      'oversized',
    );
  });
  it.each(['busy', 'unreachable'] as const)(
    'accepts retryAfterMs for retryable %s errors',
    (code) => {
      const error = createProtocolError(code, `${code} fixture`, { retryAfterMs: 250 });
      expect(
        validateOperationResponse({
          protocolVersion: PROTOCOL_VERSION,
          operation: 'message.request',
          operationId: REQUEST_ID,
          traceId: TRACE_ID,
          error,
        }).ok,
      ).toBe(true);
    },
  );
  it.each([
    [
      'busy retryAfterMs zero',
      { ...createProtocolError('busy', 'queue is full'), retryAfterMs: 0 },
    ],
    [
      'busy retryAfterMs negative',
      { ...createProtocolError('busy', 'queue is full'), retryAfterMs: -1 },
    ],
    [
      'busy retryAfterMs non-finite',
      { ...createProtocolError('busy', 'queue is full'), retryAfterMs: Number.NaN },
    ],
    [
      'busy retryAfterMs wrong type',
      { ...createProtocolError('busy', 'queue is full'), retryAfterMs: '250' },
    ],
    [
      'permanent retryable mismatch',
      { ...createProtocolError('malformed', 'bad envelope'), retryable: true },
    ],
    [
      'permanent retryAfterMs',
      { code: 'malformed', message: 'bad envelope', retryable: false, retryAfterMs: 100 },
    ],
  ] as const)('rejects %s retry metadata on a wire error', (_label, error) => {
    expectFailure(
      validateOperationResponse(
        {
          protocolVersion: PROTOCOL_VERSION,
          operation: 'message.request',
          operationId: REQUEST_ID,
          traceId: TRACE_ID,
          error,
        },
        { now: NOW },
      ),
      'malformed',
    );
  });
});
