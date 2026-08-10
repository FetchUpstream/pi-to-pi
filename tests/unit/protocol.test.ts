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

  it('rejects an initial request whose requestId does not equal operationId', () => {
    const candidate = { ...asRecord(validRequest), requestId: OTHER_ID };

    expectFailure(validateEnvelope(candidate, { now: NOW }), 'malformed');
  });

  it('requires a requestId for target operations and requires a new operationId', () => {
    for (const envelope of [validReply, validStatus, validCancel]) {
      expectFailure(
        validateEnvelope(withoutField(envelope, 'requestId'), { now: NOW }),
        'malformed',
      );
    }

    expectFailure(
      validateEnvelope(
        { ...asRecord(validReply), requestId: REPLY_OPERATION_ID },
        { now: '2026-08-07T10:01:00.000Z' },
      ),
      'malformed',
    );

    expect(validateEnvelope(validReply, { now: '2026-08-07T10:01:00.000Z' }).ok).toBe(true);
  });

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

  it('rejects remote and unresolved local schema references without network access', () => {
    const remote = validateJsonSchema({ $ref: 'https://example.test/schema.json' });
    const unresolved = validateJsonSchema({ $ref: '#/$defs/missing' });

    expectFailure(remote, 'incompatible');
    expectFailure(unresolved, 'malformed');
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
    expectFailure(
      validateEnvelope(
        {
          ...asRecord(validDescribe),
          expiresAt: '2026-08-07T10:00:31.000Z',
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
});

describe('canonical request fingerprints', () => {
  it('canonicalizes object key order deterministically', () => {
    expect(canonicalizeJson({ z: 1, a: [true, null] })).toBe('{"a":[true,null],"z":1}');
  });

  it('excludes binding credential metadata while covering immutable operation data', () => {
    const withCredentials = {
      ...asRecord(validRequest),
      bindingCredentials: { token: 'fixture-secret-a' },
    };
    const withDifferentCredentials = {
      ...asRecord(validRequest),
      bindingCredentials: { token: 'fixture-secret-b' },
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

  it.each([
    ['busy', true],
    ['unreachable', true],
    ['malformed', false],
    ['incompatible', false],
    ['expired', false],
    ['cross_room', false],
    ['unauthorized', false],
    ['oversized', false],
    ['duplicate', false],
    ['invalid_reply', false],
    ['not_cancelable', false],
  ] as const)('derives retryability for %s errors', (code, retryable) => {
    const error = createProtocolError(code, 'stable fixture message');

    expect(error.code).toBe(code);
    expect(error.retryable).toBe(retryable);
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
});
