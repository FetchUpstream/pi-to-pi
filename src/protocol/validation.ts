import {
  AGENT_CARD_PROTOCOL_VERSION,
  AGENT_STATES,
  ENDPOINT_TRANSPORTS,
  MAX_AGENT_CARD_SIZE_BYTES,
  MAX_AGENT_ID_LENGTH,
  MAX_CONTEXT_TOKENS,
  MAX_CONTENT_TYPE_LENGTH,
  MAX_DISPLAY_NAME_LENGTH,
  MAX_ENDPOINT_ADDRESS_LENGTH,
  MAX_INBOUND_QUEUE_DEPTH,
  MAX_MESSAGE_SIZE_BYTES,
  MAX_PURPOSE_LENGTH,
  MAX_ROLE_TAG_LENGTH,
  MAX_ROLE_TAGS,
  MAX_ROOM_ID_LENGTH,
  MAX_SUPPORTED_CONTENT_TYPES,
  MAX_WORKING_DIRECTORY_LABEL_LENGTH,
  SUPPORTED_AGENT_CARD_PROTOCOL_VERSIONS,
  type AgentCard,
} from './agent-card.js';
import { isCanonicalRoomId } from '../room.js';

export type AgentCardValidationCode =
  | 'invalid-type'
  | 'card-too-large'
  | 'missing-field'
  | 'invalid-value'
  | 'unsupported-version'
  | 'identity-mismatch'
  | 'room-mismatch'
  | 'invalid-enum'
  | 'invalid-timestamp'
  | 'expired'
  | 'forbidden-field';

export interface AgentCardValidationIssue {
  readonly path: string;
  readonly code: AgentCardValidationCode;
  readonly message: string;
}

export interface AgentCardValidationResult {
  readonly valid: boolean;
  readonly card?: AgentCard;
  readonly errors: readonly AgentCardValidationIssue[];
}

export interface AgentCardValidationOptions {
  /** Require the card to be live at `now`; structural validation does not by default. */
  readonly requireUnexpired?: boolean;
  readonly now?: Date | number;
  readonly expectedRoomId?: string;
  readonly expectedRuntimeInstanceId?: string;
  /** Exact `<runtimeInstanceId>.json` record name, when validating a directory entry. */
  readonly expectedRecordFileName?: string;
  /** A lower per-call bound is allowed; the protocol-wide maximum cannot be raised. */
  readonly maxCardSizeBytes?: number;
}

const CARD_FIELDS = new Set([
  'protocolVersion',
  'sessionId',
  'runtimeInstanceId',
  'displayName',
  'roomId',
  'purpose',
  'workingDirectoryLabel',
  'roleTags',
  'model',
  'capabilities',
  'state',
  'contextUsage',
  'inboundQueueDepth',
  'endpoint',
  'runtimeStartedAt',
  'leaseExpiresAt',
]);

const CARD_FORBIDDEN_FIELDS = new Set([
  'apiKey',
  'apiToken',
  'capabilitySecret',
  'capabilityToken',
  'credentials',
  'message',
  'messages',
  'prompt',
  'request',
  'response',
  'secret',
  'task',
  'taskState',
]);

const CAPABILITY_FIELDS = new Set([
  'structuredReplies',
  'cancellation',
  'statusUpdates',
  'maxMessageSize',
  'supportedContentTypes',
]);

const MODEL_FIELDS = new Set(['provider', 'id']);
const CONTEXT_USAGE_FIELDS = new Set(['tokens', 'percent']);
const ENDPOINT_FIELDS = new Set(['kind', 'address', 'runtimeInstanceId']);
const ISO_TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/u;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/u;
const SAFE_RUNTIME_INSTANCE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const WINDOWS_RESERVED_RUNTIME_INSTANCE_ID_PATTERN =
  /^(?:CON|PRN|AUX|NUL|COM[0-9]|LPT[0-9])(?:\.|$)/iu;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint < 0x20 || codePoint === 0x7f)) {
      return true;
    }
  }
  return false;
}

function serializedSizeBytes(value: unknown): number | null {
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? null : Buffer.byteLength(serialized, 'utf8');
  } catch {
    return null;
  }
}

function isBoundedText(value: unknown, maxLength: number): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= maxLength &&
    value === value.trim() &&
    !hasControlCharacter(value)
  );
}

function isIdentifier(value: unknown): value is string {
  return typeof value === 'string' && IDENTIFIER_PATTERN.test(value);
}

/**
 * Runtime identities are shared by registry construction, path construction, and
 * card schema validation. Keep this check cross-platform and stricter than the
 * generic logical session identity grammar.
 */
export function isSafeRuntimeInstanceId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    SAFE_RUNTIME_INSTANCE_ID_PATTERN.test(value) &&
    !value.endsWith('.') &&
    !value.endsWith(' ') &&
    !WINDOWS_RESERVED_RUNTIME_INSTANCE_ID_PATTERN.test(value)
  );
}

function isFiniteInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value);
}

function isInConstArray<T extends readonly string[]>(
  values: T,
  value: unknown,
): value is T[number] {
  return typeof value === 'string' && values.some((candidate) => candidate === value);
}

function issue(
  errors: AgentCardValidationIssue[],
  path: string,
  code: AgentCardValidationCode,
  message: string,
): void {
  errors.push({ path, code, message });
}

function checkKnownFields(
  record: Record<string, unknown>,
  knownFields: ReadonlySet<string>,
  path: string,
  errors: AgentCardValidationIssue[],
): void {
  for (const key of Object.keys(record)) {
    if (!knownFields.has(key)) {
      issue(errors, `${path}.${key}`, 'invalid-value', 'unknown field');
    }
  }
}

function checkRequiredField(
  record: Record<string, unknown>,
  key: string,
  errors: AgentCardValidationIssue[],
): boolean {
  if (!hasOwn(record, key)) {
    issue(errors, key, 'missing-field', 'required field is missing');
    return false;
  }

  return true;
}

function validateNullableText(
  value: unknown,
  path: string,
  maxLength: number,
  errors: AgentCardValidationIssue[],
): void {
  if (value === null) {
    return;
  }

  if (!isBoundedText(value, maxLength)) {
    issue(errors, path, 'invalid-value', 'must be null or bounded non-empty text');
  }
}

function validateModel(value: unknown, errors: AgentCardValidationIssue[]): void {
  if (value === null) {
    return;
  }

  if (!isRecord(value)) {
    issue(errors, 'model', 'invalid-type', 'must be an object or null');
    return;
  }

  checkKnownFields(value, MODEL_FIELDS, 'model', errors);
  if (!checkRequiredField(value, 'provider', errors)) {
    return;
  }
  if (!checkRequiredField(value, 'id', errors)) {
    return;
  }

  if (!isBoundedText(value.provider, 128)) {
    issue(errors, 'model.provider', 'invalid-value', 'must be bounded non-empty text');
  }
  if (!isBoundedText(value.id, 256)) {
    issue(errors, 'model.id', 'invalid-value', 'must be bounded non-empty text');
  }
}

function validateContextUsage(value: unknown, errors: AgentCardValidationIssue[]): void {
  if (value === null) {
    return;
  }

  if (!isRecord(value)) {
    issue(errors, 'contextUsage', 'invalid-type', 'must be an object or null');
    return;
  }

  checkKnownFields(value, CONTEXT_USAGE_FIELDS, 'contextUsage', errors);
  for (const key of CONTEXT_USAGE_FIELDS) {
    if (!checkRequiredField(value, key, errors)) {
      continue;
    }

    const member = value[key];
    if (member === null) {
      continue;
    }

    if (!isFiniteInteger(member) || member < 0 || member > MAX_CONTEXT_TOKENS) {
      if (key === 'percent') {
        issue(
          errors,
          'contextUsage.percent',
          'invalid-value',
          'must be null or an integer from 0 through 100',
        );
      } else {
        issue(
          errors,
          'contextUsage.tokens',
          'invalid-value',
          `must be null or an integer from 0 through ${MAX_CONTEXT_TOKENS}`,
        );
      }
    } else if (key === 'percent' && member > 100) {
      issue(
        errors,
        'contextUsage.percent',
        'invalid-value',
        'must be null or an integer from 0 through 100',
      );
    }
  }
}

function validateCapabilities(value: unknown, errors: AgentCardValidationIssue[]): void {
  if (!isRecord(value)) {
    issue(errors, 'capabilities', 'invalid-type', 'must be an object');
    return;
  }

  checkKnownFields(value, CAPABILITY_FIELDS, 'capabilities', errors);
  for (const key of ['structuredReplies', 'cancellation', 'statusUpdates']) {
    if (!checkRequiredField(value, key, errors)) {
      continue;
    }
    if (typeof value[key] !== 'boolean') {
      issue(errors, `capabilities.${key}`, 'invalid-type', 'must be a boolean');
    }
  }

  if (checkRequiredField(value, 'maxMessageSize', errors)) {
    if (
      !isFiniteInteger(value.maxMessageSize) ||
      value.maxMessageSize < 1 ||
      value.maxMessageSize > MAX_MESSAGE_SIZE_BYTES
    ) {
      issue(
        errors,
        'capabilities.maxMessageSize',
        'invalid-value',
        `must be an integer from 1 through ${MAX_MESSAGE_SIZE_BYTES}`,
      );
    }
  }

  if (!checkRequiredField(value, 'supportedContentTypes', errors)) {
    return;
  }
  if (!Array.isArray(value.supportedContentTypes)) {
    issue(errors, 'capabilities.supportedContentTypes', 'invalid-type', 'must be an array');
    return;
  }
  if (value.supportedContentTypes.length > MAX_SUPPORTED_CONTENT_TYPES) {
    issue(
      errors,
      'capabilities.supportedContentTypes',
      'invalid-value',
      `must contain at most ${MAX_SUPPORTED_CONTENT_TYPES} entries`,
    );
  }
  const seen = new Set<string>();
  for (const [index, contentType] of value.supportedContentTypes.entries()) {
    if (!isBoundedText(contentType, MAX_CONTENT_TYPE_LENGTH)) {
      issue(
        errors,
        `capabilities.supportedContentTypes[${index}]`,
        'invalid-value',
        'must be bounded non-empty text',
      );
      continue;
    }
    if (seen.has(contentType)) {
      issue(
        errors,
        `capabilities.supportedContentTypes[${index}]`,
        'invalid-value',
        'must not contain duplicate content types',
      );
    }
    seen.add(contentType);
  }
}

function validateEndpoint(
  value: unknown,
  runtimeInstanceId: unknown,
  errors: AgentCardValidationIssue[],
): void {
  if (!isRecord(value)) {
    issue(errors, 'endpoint', 'invalid-type', 'must be an object');
    return;
  }

  checkKnownFields(value, ENDPOINT_FIELDS, 'endpoint', errors);
  if (!checkRequiredField(value, 'kind', errors)) {
    return;
  }
  if (!isInConstArray(ENDPOINT_TRANSPORTS, value.kind)) {
    issue(errors, 'endpoint.kind', 'invalid-enum', 'unsupported endpoint transport');
  }

  if (!checkRequiredField(value, 'address', errors)) {
    return;
  }
  if (!isBoundedText(value.address, MAX_ENDPOINT_ADDRESS_LENGTH)) {
    issue(errors, 'endpoint.address', 'invalid-value', 'must be bounded non-empty text');
  }

  if (!checkRequiredField(value, 'runtimeInstanceId', errors)) {
    return;
  }
  if (!isSafeRuntimeInstanceId(value.runtimeInstanceId)) {
    issue(
      errors,
      'endpoint.runtimeInstanceId',
      'invalid-value',
      'must be a bounded runtime identity',
    );
  } else if (value.runtimeInstanceId !== runtimeInstanceId) {
    issue(
      errors,
      'endpoint.runtimeInstanceId',
      'identity-mismatch',
      'must match the card runtimeInstanceId',
    );
  }
}

function parseTimestamp(
  value: unknown,
  path: string,
  errors: AgentCardValidationIssue[],
): number | null {
  if (typeof value !== 'string' || value.length > 64 || !ISO_TIMESTAMP_PATTERN.test(value)) {
    issue(
      errors,
      path,
      'invalid-timestamp',
      'must be a bounded ISO-8601 timestamp with an explicit timezone',
    );
    return null;
  }

  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    issue(errors, path, 'invalid-timestamp', 'must be a valid ISO-8601 timestamp');
    return null;
  }

  const year = Number(value.slice(0, 4));
  if (year < 2000 || year > 2100) {
    issue(
      errors,
      path,
      'invalid-timestamp',
      'timestamp year is outside the supported bounded range',
    );
    return null;
  }

  return parsed;
}

function validationNow(
  value: Date | number | undefined,
  errors: AgentCardValidationIssue[],
): number {
  if (value === undefined) {
    return Date.now();
  }

  const timestamp = value instanceof Date ? value.getTime() : value;
  if (!Number.isFinite(timestamp)) {
    issue(errors, 'now', 'invalid-value', 'validation time must be finite');
    return Date.now();
  }

  return timestamp;
}

function forbiddenTopLevelFields(
  record: Record<string, unknown>,
  errors: AgentCardValidationIssue[],
): void {
  for (const key of Object.keys(record)) {
    if (CARD_FORBIDDEN_FIELDS.has(key)) {
      issue(
        errors,
        key,
        'forbidden-field',
        'Agent Cards are discovery metadata and cannot contain message or secret data',
      );
    }
  }
}

function resultFor(
  input: unknown,
  errors: readonly AgentCardValidationIssue[],
): AgentCardValidationResult {
  if (errors.length > 0) {
    return { valid: false, errors };
  }

  return { valid: true, card: input as AgentCard, errors: [] };
}

/** Validate one decoded Agent Card without aborting room discovery. */
export function validateAgentCard(
  input: unknown,
  options: AgentCardValidationOptions = {},
): AgentCardValidationResult {
  const errors: AgentCardValidationIssue[] = [];
  const configuredMax = options.maxCardSizeBytes ?? MAX_AGENT_CARD_SIZE_BYTES;
  const maxCardSize = Math.min(configuredMax, MAX_AGENT_CARD_SIZE_BYTES);
  const size = serializedSizeBytes(input);

  if (size === null) {
    issue(errors, '$', 'invalid-type', 'card must be JSON-serializable');
  } else if (!Number.isFinite(maxCardSize) || maxCardSize < 1 || size > maxCardSize) {
    issue(
      errors,
      '$',
      'card-too-large',
      `card exceeds the ${MAX_AGENT_CARD_SIZE_BYTES}-byte size limit`,
    );
  }

  if (!isRecord(input)) {
    issue(errors, '$', 'invalid-type', 'card must be a JSON object');
    return resultFor(input, errors);
  }

  checkKnownFields(input, CARD_FIELDS, '$', errors);
  forbiddenTopLevelFields(input, errors);

  const requiredFields = [
    'protocolVersion',
    'sessionId',
    'runtimeInstanceId',
    'displayName',
    'roomId',
    'purpose',
    'workingDirectoryLabel',
    'roleTags',
    'model',
    'capabilities',
    'state',
    'contextUsage',
    'inboundQueueDepth',
    'endpoint',
    'runtimeStartedAt',
    'leaseExpiresAt',
  ];
  for (const key of requiredFields) {
    checkRequiredField(input, key, errors);
  }

  if (!isFiniteInteger(input.protocolVersion)) {
    issue(errors, 'protocolVersion', 'invalid-type', 'must be an integer protocol version');
  } else if (
    !SUPPORTED_AGENT_CARD_PROTOCOL_VERSIONS.some((version) => version === input.protocolVersion)
  ) {
    issue(
      errors,
      'protocolVersion',
      'unsupported-version',
      `supported version is ${AGENT_CARD_PROTOCOL_VERSION}`,
    );
  }

  if (!isIdentifier(input.sessionId)) {
    issue(
      errors,
      'sessionId',
      'invalid-value',
      `must be a bounded identity of at most ${MAX_AGENT_ID_LENGTH} characters`,
    );
  }
  if (!isSafeRuntimeInstanceId(input.runtimeInstanceId)) {
    issue(
      errors,
      'runtimeInstanceId',
      'invalid-value',
      `must be a bounded identity of at most ${MAX_AGENT_ID_LENGTH} characters`,
    );
  }
  if (
    options.expectedRuntimeInstanceId !== undefined &&
    input.runtimeInstanceId !== options.expectedRuntimeInstanceId
  ) {
    issue(
      errors,
      'runtimeInstanceId',
      'identity-mismatch',
      'does not match the expected runtime identity',
    );
  }

  if (!isBoundedText(input.displayName, MAX_DISPLAY_NAME_LENGTH)) {
    issue(errors, 'displayName', 'invalid-value', 'must be bounded non-empty text');
  }
  if (!isCanonicalRoomId(input.roomId)) {
    issue(
      errors,
      'roomId',
      'invalid-value',
      `must be a canonical room identity of at most ${MAX_ROOM_ID_LENGTH} characters`,
    );
  }
  if (options.expectedRoomId !== undefined && input.roomId !== options.expectedRoomId) {
    issue(errors, 'roomId', 'room-mismatch', 'does not match the room being listed');
  }

  validateNullableText(input.purpose, 'purpose', MAX_PURPOSE_LENGTH, errors);
  validateNullableText(
    input.workingDirectoryLabel,
    'workingDirectoryLabel',
    MAX_WORKING_DIRECTORY_LABEL_LENGTH,
    errors,
  );

  if (!Array.isArray(input.roleTags)) {
    issue(errors, 'roleTags', 'invalid-type', 'must be an array');
  } else {
    if (input.roleTags.length > MAX_ROLE_TAGS) {
      issue(errors, 'roleTags', 'invalid-value', `must contain at most ${MAX_ROLE_TAGS} entries`);
    }
    const seenTags = new Set<string>();
    for (const [index, roleTag] of input.roleTags.entries()) {
      if (!isBoundedText(roleTag, MAX_ROLE_TAG_LENGTH)) {
        issue(errors, `roleTags[${index}]`, 'invalid-value', 'must be bounded non-empty text');
      } else if (seenTags.has(roleTag)) {
        issue(
          errors,
          `roleTags[${index}]`,
          'invalid-value',
          'must not contain duplicate role tags',
        );
      } else {
        seenTags.add(roleTag);
      }
    }
  }

  validateModel(input.model, errors);
  validateCapabilities(input.capabilities, errors);

  if (!isInConstArray(AGENT_STATES, input.state)) {
    issue(errors, 'state', 'invalid-enum', 'unsupported agent state');
  }

  validateContextUsage(input.contextUsage, errors);
  if (
    !isFiniteInteger(input.inboundQueueDepth) ||
    input.inboundQueueDepth < 0 ||
    input.inboundQueueDepth > MAX_INBOUND_QUEUE_DEPTH
  ) {
    issue(
      errors,
      'inboundQueueDepth',
      'invalid-value',
      `must be an integer from 0 through ${MAX_INBOUND_QUEUE_DEPTH}`,
    );
  }

  validateEndpoint(input.endpoint, input.runtimeInstanceId, errors);
  const runtimeStartedAt = parseTimestamp(input.runtimeStartedAt, 'runtimeStartedAt', errors);
  const leaseExpiresAt = parseTimestamp(input.leaseExpiresAt, 'leaseExpiresAt', errors);
  if (runtimeStartedAt !== null && leaseExpiresAt !== null && leaseExpiresAt <= runtimeStartedAt) {
    issue(errors, 'leaseExpiresAt', 'invalid-timestamp', 'must be later than runtimeStartedAt');
  }

  if (options.expectedRecordFileName !== undefined) {
    const expectedName = `${String(input.runtimeInstanceId)}.json`;
    if (options.expectedRecordFileName !== expectedName) {
      issue(
        errors,
        'runtimeInstanceId',
        'identity-mismatch',
        'card runtime identity does not match its record filename',
      );
    }
  }

  if (options.requireUnexpired && leaseExpiresAt !== null) {
    const now = validationNow(options.now, errors);
    if (leaseExpiresAt <= now) {
      issue(errors, 'leaseExpiresAt', 'expired', 'card lease has expired');
    }
  }

  return resultFor(input, errors);
}

/** Validate a card and require its lease to be live at the supplied time. */
export function validateLiveAgentCard(
  input: unknown,
  options: Omit<AgentCardValidationOptions, 'requireUnexpired'> = {},
): AgentCardValidationResult {
  return validateAgentCard(input, { ...options, requireUnexpired: true });
}

export function isAgentCard(
  input: unknown,
  options: AgentCardValidationOptions = {},
): input is AgentCard {
  return validateAgentCard(input, options).valid;
}

export function isLiveAgentCard(
  input: unknown,
  options: Omit<AgentCardValidationOptions, 'requireUnexpired'> = {},
): input is AgentCard {
  return validateLiveAgentCard(input, options).valid;
}

export class AgentCardValidationError extends Error {
  readonly issues: readonly AgentCardValidationIssue[];

  constructor(result: AgentCardValidationResult) {
    super(result.errors.map((error) => `${error.path}: ${error.message}`).join('; '));
    this.name = 'AgentCardValidationError';
    this.issues = result.errors;
  }
}

export function assertValidAgentCard(
  input: unknown,
  options: AgentCardValidationOptions = {},
): asserts input is AgentCard {
  const result = validateAgentCard(input, options);
  if (!result.valid) {
    throw new AgentCardValidationError(result);
  }
}

export function parseAgentCardJson(
  source: string,
  options: AgentCardValidationOptions = {},
): AgentCardValidationResult {
  if (typeof source !== 'string') {
    return {
      valid: false,
      errors: [{ path: '$', code: 'invalid-type', message: 'card source must be a string' }],
    };
  }

  if (Buffer.byteLength(source, 'utf8') > MAX_AGENT_CARD_SIZE_BYTES) {
    return {
      valid: false,
      errors: [
        {
          path: '$',
          code: 'card-too-large',
          message: `card exceeds the ${MAX_AGENT_CARD_SIZE_BYTES}-byte size limit`,
        },
      ],
    };
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(source) as unknown;
  } catch {
    return {
      valid: false,
      errors: [{ path: '$', code: 'invalid-type', message: 'card source is not valid JSON' }],
    };
  }

  return validateAgentCard(decoded, options);
}
