import { createHash } from 'node:crypto';
import { Ajv2020 } from 'ajv/dist/2020.js';

/** Discovery Agent Card validation remains a separate contract from wire validation. */
export * from './agent-card-validation.js';
import { validateAgentCard as validateDiscoveryAgentCard } from './agent-card-validation.js';

import { isSafeIdentifier, isUuidV4 as canonicalIsUuidV4 } from '../identity.js';
import { isRoomId } from '../room.js';
import {
  createProtocolConfig,
  DEFAULT_QUEUE_LIMIT,
  MAX_CONTROL_TTL_MS,
  MAX_ENVELOPE_BYTES,
  MAX_REQUEST_TTL_MS,
  MAX_SCHEMA_BYTES,
} from '../config.js';
import {
  JSON_SCHEMA_DRAFT_2020_12,
  OPERATION_NAMES,
  PROTOCOL_VERSION,
  type Content,
  type ExpectedResponse,
  type JsonObject,
  type JsonSchema,
  type JsonValue,
  type MessageReplyPayload,
  type OperationName,
  type OperationResponse,
  type ProtocolEnvelope,
  type ProtocolOperationResponse,
  type TypedContent,
  type ProtocolLimits,
} from './messages.js';
import {
  createProtocolError,
  isRetryableErrorCode,
  PROTOCOL_ERROR_CODES,
  type ProtocolError,
  type ProtocolErrorCode,
} from './errors.js';
import {
  isTerminalOutcome,
  isTerminalTaskState,
  TASK_STATES,
  type TaskState,
} from './task-state.js';

/** Error classes emitted by the validation boundary. */
export type ValidationErrorCode =
  'malformed' | 'incompatible' | 'expired' | 'oversized' | 'invalid_content' | 'invalid_reply';

/** A validation result never throws for untrusted wire input. */
export interface ValidationSuccess<Value> {
  readonly ok: true;
  readonly value: Value;
}

export interface ValidationFailure {
  readonly ok: false;
  readonly error: ProtocolError;
}

export type ValidationResult<Value> = ValidationSuccess<Value> | ValidationFailure;

/** Options controlling limits and the wall-clock used for deadline checks. */
export interface ValidationOptions {
  readonly now?: Date | number | string;
  readonly maxEnvelopeBytes?: number;
  readonly maxSchemaBytes?: number;
  readonly maxDepth?: number;
  readonly maxNodes?: number;
  readonly limits?: Partial<ProtocolLimits>;
  /** Optional request ID expected in an operation result or task snapshot. */
  readonly expectedRequestId?: string;
}

export type ProtocolValidationOptions = ValidationOptions;

/** The default maximum nesting accepted while inspecting untrusted JSON. */
export const DEFAULT_VALIDATION_MAX_DEPTH = 128;

/** The default maximum number of JSON nodes inspected in one validation pass. */
export const DEFAULT_VALIDATION_MAX_NODES = 200_000;

/** Future timestamps are tolerated only within a small same-host clock-skew window. */
export const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;

/** Error messages are deliberately short and contain no control characters. */
export const MAX_PROTOCOL_ERROR_MESSAGE_LENGTH = 512;

/** Compile only already-bounded local schemas; no async/network loader is supplied. */
function compileDraft2020Schema(schema: JsonSchema): ((value: unknown) => boolean) | undefined {
  try {
    const ajv = new Ajv2020({
      addUsedSchema: false,
      allErrors: false,
      strict: false,
      validateFormats: false,
    });
    return ajv.compile(schema as object | boolean);
  } catch {
    return undefined;
  }
}

const TRACE_ID_PATTERN = /^[0-9a-f]{32}$/u;
const RFC3339_UTC_PATTERN = /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?Z$/u;
const SCHEMA_ANCHOR_PATTERN = /^[A-Za-z][A-Za-z0-9._-]*$/u;
const JSON_SCHEMA_TYPES = new Set([
  'null',
  'boolean',
  'object',
  'array',
  'number',
  'integer',
  'string',
]);
const FORMAT_ASSERTION_VOCABULARY = 'https://json-schema.org/draft/2020-12/vocab/format-assertion';
const SUPPORTED_REQUIRED_VOCABULARIES = new Set([
  'https://json-schema.org/draft/2020-12/vocab/core',
  'https://json-schema.org/draft/2020-12/vocab/applicator',
  'https://json-schema.org/draft/2020-12/vocab/validation',
  'https://json-schema.org/draft/2020-12/vocab/meta-data',
  'https://json-schema.org/draft/2020-12/vocab/format-annotation',
  'https://json-schema.org/draft/2020-12/vocab/content',
]);
const LOCAL_REFERENCE_PATTERN = /^(?:|#(?:[^\s]*))$/u;
const MAX_SAFE_REGEX_PATTERN_LENGTH = 1024;
const MAX_SAFE_REGEX_REPETITIONS = 256;
const MAX_SAFE_REGEX_VARIANTS = 256;
const REQUIRED_ENVELOPE_FIELDS = [
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
] as const;
const ADMISSION_STATES = new Set(['accepted', 'queued']);

type UnknownRecord = Record<string, unknown>;
type InternalCode = ValidationErrorCode;

interface InternalIssue {
  readonly code: InternalCode;
  readonly path: string;
  readonly reason: string;
  readonly keyword?: string;
}

interface MeasureContext {
  readonly maxBytes: number;
  readonly maxDepth: number;
  readonly maxNodes: number;
  nodes: number;
  readonly seen: Set<object>;
}

type MeasureResult =
  | { readonly kind: 'ok'; readonly bytes: number }
  | { readonly kind: 'too_large'; readonly bytes: number }
  | { readonly kind: 'invalid'; readonly path: string; readonly reason: string };

interface ResolvedLimits {
  readonly maxEnvelopeBytes: number;
  readonly maxSchemaBytes: number;
  readonly maxDepth: number;
  readonly maxNodes: number;
  readonly maxRequestTtlMs: number;
  readonly maxControlTtlMs: number;
}

interface SchemaIndex {
  readonly root: JsonSchema;
  readonly refs: ReadonlyMap<string, JsonSchema>;
  readonly anchors: ReadonlyMap<string, JsonSchema>;
  readonly references: readonly { readonly ref: string; readonly path: string }[];
}

interface EvaluationBudget {
  readonly maxOperations: number;
  operations: number;
  exhausted: boolean;
}

interface SchemaContext extends SchemaIndex {
  readonly maxDepth: number;
  readonly budget: EvaluationBudget;
  readonly regexCache: Map<string, RegExp>;
}

interface SchemaValidationResult {
  readonly valid: boolean;
  readonly path?: string;
  readonly reason?: string;
}

function hasOwn(value: UnknownRecord, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function isPlainObject(value: unknown): value is UnknownRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isJsonObject(value: unknown): value is JsonObject {
  return isPlainObject(value);
}

function issue(code: InternalCode, path: string, reason: string, keyword?: string): InternalIssue {
  return { code, path, reason, ...(keyword === undefined ? {} : { keyword }) };
}

function issueDetails(path: string, reason: string, keyword?: string): JsonObject {
  return {
    path,
    reason,
    ...(keyword === undefined ? {} : { keyword }),
  };
}

function validationFailure<Value>(
  code: ValidationErrorCode,
  message: string,
  path: string,
  reason: string,
  keyword?: string,
): ValidationResult<Value> {
  return {
    ok: false,
    error: createProtocolError(code, message, {
      details: issueDetails(path, reason, keyword),
    }),
  };
}

function messageForInternalCode(code: InternalCode): string {
  switch (code) {
    case 'incompatible':
      return 'protocol value is not supported';
    case 'expired':
      return 'protocol value has expired';
    case 'oversized':
      return 'protocol value exceeds a configured size limit';
    case 'invalid_content':
      return 'protocol content is invalid';
    case 'invalid_reply':
      return 'protocol reply is invalid';
    case 'malformed':
      return 'protocol value is malformed';
  }
}

function internalIssueFailure<Value>(issueValue: InternalIssue): ValidationResult<Value> {
  return validationFailure(
    issueValue.code,
    messageForInternalCode(issueValue.code),
    issueValue.path,
    issueValue.reason,
    issueValue.keyword,
  );
}

function success<Value>(value: Value): ValidationSuccess<Value> {
  return { ok: true, value };
}

function hasControlCharacters(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f)) {
      return true;
    }
  }
  return false;
}

function isSafeHumanReadableMessage(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= MAX_PROTOCOL_ERROR_MESSAGE_LENGTH &&
    value.trim() === value &&
    value.trim().length > 0 &&
    !hasControlCharacters(value)
  );
}

function resolvePositiveLimit(
  value: number | undefined,
  fallback: number,
  field: string,
  ceiling = fallback,
): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new RangeError(`${field} must be a positive safe integer`);
  }
  return Math.min(resolved, ceiling);
}

function resolveLimits(options: ValidationOptions): ResolvedLimits {
  const configured = createProtocolConfig(options.limits);
  return {
    maxEnvelopeBytes: resolvePositiveLimit(
      options.maxEnvelopeBytes,
      configured.maxEnvelopeBytes,
      'maxEnvelopeBytes',
      Math.min(MAX_ENVELOPE_BYTES, configured.maxEnvelopeBytes),
    ),
    maxSchemaBytes: resolvePositiveLimit(
      options.maxSchemaBytes,
      configured.maxSchemaBytes,
      'maxSchemaBytes',
      Math.min(MAX_SCHEMA_BYTES, configured.maxSchemaBytes),
    ),
    maxDepth: resolvePositiveLimit(
      options.maxDepth,
      DEFAULT_VALIDATION_MAX_DEPTH,
      'maxDepth',
      DEFAULT_VALIDATION_MAX_DEPTH,
    ),
    maxNodes: resolvePositiveLimit(
      options.maxNodes,
      DEFAULT_VALIDATION_MAX_NODES,
      'maxNodes',
      DEFAULT_VALIDATION_MAX_NODES,
    ),
    maxRequestTtlMs: configured.maxRequestTtlMs,
    maxControlTtlMs: configured.maxControlTtlMs,
  };
}

function resolveNow(value: ValidationOptions['now']): number {
  if (value === undefined) {
    return Date.now();
  }

  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) {
      throw new RangeError('now must be a finite safe integer');
    }
    return value;
  }

  if (value instanceof Date) {
    const milliseconds = value.getTime();
    if (!Number.isSafeInteger(milliseconds)) {
      throw new RangeError('now must be a valid Date');
    }
    return milliseconds;
  }

  const milliseconds = parseUtcTimestamp(value);
  if (milliseconds === undefined) {
    throw new RangeError('now must be a valid RFC 3339 UTC timestamp');
  }
  return milliseconds;
}

function isUuidV4Value(value: unknown): value is string {
  return canonicalIsUuidV4(value);
}

/** Return whether a canonical UUIDv4 wire string. */
export const isUUIDv4 = isUuidV4Value;
export const isUuidV4 = isUuidV4Value;

function parseUtcTimestamp(value: unknown): number | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const match = RFC3339_UTC_PATTERN.exec(value);
  if (match === null) {
    return undefined;
  }

  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) {
    return undefined;
  }

  const date = new Date(milliseconds);
  let iso: string;
  try {
    iso = date.toISOString();
  } catch {
    return undefined;
  }

  const [, year, month, day, hour, minute, second] = match;
  const normalizedInput = `${year}-${month}-${day}T${hour}:${minute}:${second}Z`;
  const normalizedOutput = iso.replace(/\.\d{3}Z$/u, 'Z');
  return normalizedInput === normalizedOutput ? milliseconds : undefined;
}

/** Return the epoch milliseconds for an RFC 3339 UTC timestamp, if valid. */
export function parseRfc3339Utc(value: unknown): number | undefined {
  return parseUtcTimestamp(value);
}

export const parseRFC3339UTC = parseRfc3339Utc;
export const isRfc3339Utc = (value: unknown): value is string =>
  parseUtcTimestamp(value) !== undefined;
export const isRFC3339UTC = isRfc3339Utc;

function jsonStringByteLength(value: string): number {
  let bytes = 2;

  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (
      code === 0x22 ||
      code === 0x5c ||
      code === 0x08 ||
      code === 0x09 ||
      code === 0x0a ||
      code === 0x0c ||
      code === 0x0d
    ) {
      bytes += 2;
    } else if (code <= 0x1f) {
      bytes += 6;
    } else if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else {
        bytes += 6;
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      bytes += 6;
    } else {
      if (code <= 0x7f) {
        bytes += 1;
      } else if (code <= 0x7ff) {
        bytes += 2;
      } else {
        bytes += 3;
      }
    }
  }

  return bytes;
}

function addMeasuredBytes(
  current: number,
  additional: number,
  context: MeasureContext,
): MeasureResult {
  const total = current + additional;
  if (!Number.isSafeInteger(total) || total > context.maxBytes) {
    return { kind: 'too_large', bytes: total };
  }
  return { kind: 'ok', bytes: total };
}

function measureJsonBytes(
  value: unknown,
  maxBytes: number,
  options: ValidationOptions = {},
): MeasureResult {
  const context: MeasureContext = {
    maxBytes,
    maxDepth: resolvePositiveLimit(options.maxDepth, DEFAULT_VALIDATION_MAX_DEPTH, 'maxDepth'),
    maxNodes: resolvePositiveLimit(options.maxNodes, DEFAULT_VALIDATION_MAX_NODES, 'maxNodes'),
    nodes: 0,
    seen: new Set<object>(),
  };

  const measure = (candidate: unknown, path: string, depth: number): MeasureResult => {
    context.nodes += 1;
    if (context.nodes > context.maxNodes) {
      return { kind: 'too_large', bytes: context.maxBytes + 1 };
    }
    if (depth > context.maxDepth) {
      return { kind: 'invalid', path, reason: 'maximum JSON nesting depth exceeded' };
    }

    if (candidate === null) {
      return addMeasuredBytes(0, 4, context);
    }
    if (typeof candidate === 'string') {
      return addMeasuredBytes(0, jsonStringByteLength(candidate), context);
    }
    if (typeof candidate === 'boolean') {
      return addMeasuredBytes(0, candidate ? 4 : 5, context);
    }
    if (typeof candidate === 'number') {
      if (!Number.isFinite(candidate)) {
        return { kind: 'invalid', path, reason: 'JSON numbers must be finite' };
      }
      const serialized = JSON.stringify(candidate);
      return serialized === undefined
        ? { kind: 'invalid', path, reason: 'value is not JSON serializable' }
        : addMeasuredBytes(0, Buffer.byteLength(serialized, 'utf8'), context);
    }
    if (typeof candidate !== 'object') {
      return { kind: 'invalid', path, reason: 'value is not JSON serializable' };
    }

    if (context.seen.has(candidate)) {
      return { kind: 'invalid', path, reason: 'cyclic JSON values are not permitted' };
    }
    context.seen.add(candidate);

    let result: MeasureResult;
    if (Array.isArray(candidate)) {
      let bytes = 2;
      for (let index = 0; index < candidate.length; index += 1) {
        const child = measure(candidate[index], `${path}[${index}]`, depth + 1);
        if (child.kind !== 'ok') {
          result = child;
          context.seen.delete(candidate);
          return result;
        }
        const added = addMeasuredBytes(bytes, child.bytes, context);
        if (added.kind !== 'ok') {
          context.seen.delete(candidate);
          return added;
        }
        bytes = added.bytes;
        if (index + 1 < candidate.length) {
          const comma = addMeasuredBytes(bytes, 1, context);
          if (comma.kind !== 'ok') {
            context.seen.delete(candidate);
            return comma;
          }
          bytes = comma.bytes;
        }
      }
      result = addMeasuredBytes(0, bytes, context);
    } else if (isPlainObject(candidate)) {
      if (Object.getOwnPropertySymbols(candidate).length > 0) {
        context.seen.delete(candidate);
        return { kind: 'invalid', path, reason: 'symbol properties are not JSON serializable' };
      }

      let bytes = 2;
      const keys = Object.keys(candidate);
      for (let index = 0; index < keys.length; index += 1) {
        const key = keys[index];
        const child = measure(candidate[key], `${path}.${key}`, depth + 1);
        if (child.kind !== 'ok') {
          result = child;
          context.seen.delete(candidate);
          return result;
        }
        const keyBytes = addMeasuredBytes(bytes, jsonStringByteLength(key), context);
        if (keyBytes.kind !== 'ok') {
          context.seen.delete(candidate);
          return keyBytes;
        }
        const colon = addMeasuredBytes(keyBytes.bytes, 1, context);
        if (colon.kind !== 'ok') {
          context.seen.delete(candidate);
          return colon;
        }
        const valueBytes = addMeasuredBytes(colon.bytes, child.bytes, context);
        if (valueBytes.kind !== 'ok') {
          context.seen.delete(candidate);
          return valueBytes;
        }
        bytes = valueBytes.bytes;
        if (index + 1 < keys.length) {
          const comma = addMeasuredBytes(bytes, 1, context);
          if (comma.kind !== 'ok') {
            context.seen.delete(candidate);
            return comma;
          }
          bytes = comma.bytes;
        }
      }
      result = addMeasuredBytes(0, bytes, context);
    } else {
      result = { kind: 'invalid', path, reason: 'objects must be plain JSON objects' };
    }

    context.seen.delete(candidate);
    return result;
  };

  return measure(value, '$', 0);
}

function validateJsonValueInternal(
  value: unknown,
  path: string,
  options: ValidationOptions,
): InternalIssue | undefined {
  const measured = measureJsonBytes(value, Number.MAX_SAFE_INTEGER, options);
  if (measured.kind === 'invalid') {
    return issue('malformed', measured.path, measured.reason);
  }
  if (measured.kind === 'too_large') {
    return issue('oversized', path, 'JSON value exceeds the validation complexity bound');
  }
  return undefined;
}

/** Return whether a value is representable as protocol JSON. */
export function isJsonValue(value: unknown, options: ValidationOptions = {}): value is JsonValue {
  return validateJsonValueInternal(value, '$', options) === undefined;
}

function validateTypedContentInternal(
  value: unknown,
  path: string,
  options: ValidationOptions,
): InternalIssue | undefined {
  if (!isPlainObject(value)) {
    return issue('malformed', path, 'content must be an object');
  }
  if (!hasOwn(value, 'type') || typeof value.type !== 'string') {
    return issue('malformed', `${path}.type`, 'content type is required');
  }

  if (value.type === 'text') {
    if (!hasOwn(value, 'text') || typeof value.text !== 'string') {
      return issue('invalid_content', `${path}.text`, 'text content requires a string text value');
    }
    return undefined;
  }

  if (value.type === 'json') {
    if (!hasOwn(value, 'value')) {
      return issue('invalid_content', `${path}.value`, 'JSON content requires a value');
    }
    const jsonIssue = validateJsonValueInternal(value.value, `${path}.value`, options);
    if (jsonIssue === undefined) {
      return undefined;
    }
    return jsonIssue.code === 'oversized'
      ? issue('oversized', `${path}.value`, jsonIssue.reason, jsonIssue.keyword)
      : issue('invalid_content', `${path}.value`, 'value is not valid JSON');
  }

  return issue('invalid_content', `${path}.type`, 'unsupported content type');
}

/** Validate explicit text/JSON content without guessing from text. */
export function validateContent(
  value: unknown,
  options: ValidationOptions = {},
): ValidationResult<TypedContent> {
  const contentIssue = validateTypedContentInternal(value, '$', options);
  if (contentIssue !== undefined) {
    const code: ValidationErrorCode = contentIssue.code;
    return validationFailure(
      code,
      'typed content is invalid',
      contentIssue.path,
      contentIssue.reason,
    );
  }
  return success(value as TypedContent);
}

export const validateTypedContent = validateContent;
export const validateMessageContent = validateContent;

/** Type guard for already validated typed content. */
export function isTypedContent(value: unknown): value is TypedContent {
  return validateContent(value).ok;
}

function validateMetadataInternal(
  value: unknown,
  path: string,
  options: ValidationOptions,
): InternalIssue | undefined {
  if (!isJsonObject(value)) {
    return issue('invalid_content', path, 'metadata must be a JSON object');
  }
  const jsonIssue = validateJsonValueInternal(value, path, options);
  if (jsonIssue === undefined) {
    return undefined;
  }
  return jsonIssue.code === 'oversized'
    ? issue('oversized', path, jsonIssue.reason, jsonIssue.keyword)
    : issue('invalid_content', path, 'metadata must contain only JSON values');
}

function validateSchemaKeywordType(
  schema: UnknownRecord,
  key: string,
  path: string,
  expected: (value: unknown) => boolean,
  reason: string,
): InternalIssue | undefined {
  if (!hasOwn(schema, key)) {
    return undefined;
  }
  return expected(schema[key]) ? undefined : issue('malformed', `${path}.${key}`, reason, key);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isSchemaValue(value: unknown): value is JsonSchema {
  return typeof value === 'boolean' || isPlainObject(value);
}

function addSchemaReference(
  references: { readonly ref: string; readonly path: string }[],
  value: unknown,
  path: string,
  key: '$ref' | '$dynamicRef' | '$recursiveRef',
): InternalIssue | undefined {
  if (typeof value !== 'string') {
    return issue('malformed', `${path}.${key}`, 'schema reference must be a string', key);
  }
  if (!LOCAL_REFERENCE_PATTERN.test(value)) {
    return issue(
      'incompatible',
      `${path}.${key}`,
      'remote schema references are not supported',
      key,
    );
  }
  references.push({ ref: value, path: `${path}.${key}` });
  return undefined;
}
function validateRegexPattern(
  pattern: string,
  path: string,
  keyword: string,
): InternalIssue | undefined {
  if (pattern.length > MAX_SAFE_REGEX_PATTERN_LENGTH) {
    return issue('incompatible', path, 'regular expression exceeds the safety limit', keyword);
  }
  try {
    new RegExp(pattern, 'u');
  } catch {
    return issue('malformed', path, 'pattern is not a valid regular expression', keyword);
  }

  function unsafe(): InternalIssue {
    return issue(
      'incompatible',
      path,
      'regular expression uses unsupported or unsafe constructs',
      keyword,
    );
  }
  let canQuantify = false;
  let unboundedQuantifiers = 0;
  let finiteVariants = 1;
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === '\\') {
      const escaped = pattern[index + 1];
      if (escaped === undefined) {
        continue;
      }
      if (/[1-9]/u.test(escaped) || escaped === 'k') {
        return unsafe();
      }
      if (escaped === 'p' || escaped === 'P' || (escaped === 'u' && pattern[index + 2] === '{')) {
        const closingBrace = pattern.indexOf('}', index + 2);
        if (closingBrace >= 0) {
          index = closingBrace;
        }
      } else {
        index += 1;
      }
      canQuantify = true;
      continue;
    }
    if (character === '[') {
      let closingBracket = -1;
      for (let end = index + 1; end < pattern.length; end += 1) {
        if (pattern[end] === '\\') {
          end += 1;
          continue;
        }
        if (pattern[end] === ']') {
          closingBracket = end;
          break;
        }
      }
      if (closingBracket >= 0) {
        index = closingBracket;
      }
      canQuantify = true;
      continue;
    }
    if (character === '(' || character === ')' || character === '|' || character === '?') {
      return unsafe();
    }
    if (character === '*' || character === '+') {
      if (!canQuantify) {
        return unsafe();
      }
      unboundedQuantifiers += 1;
      if (unboundedQuantifiers > 1) {
        return unsafe();
      }
      canQuantify = false;
      continue;
    }
    if (character === '{' && canQuantify) {
      const quantifier = /^\{(\d+)(?:,(\d*))?\}/u.exec(pattern.slice(index));
      if (quantifier !== null) {
        const minimum = Number(quantifier[1]);
        const maximumText = quantifier[2];
        const maximum = maximumText === undefined ? minimum : Number(maximumText);
        if (
          maximumText === '' ||
          !Number.isSafeInteger(minimum) ||
          !Number.isSafeInteger(maximum)
        ) {
          unboundedQuantifiers += 1;
          if (unboundedQuantifiers > 1) {
            return unsafe();
          }
        } else if (
          minimum > maximum ||
          maximum > MAX_SAFE_REGEX_REPETITIONS ||
          minimum > MAX_SAFE_REGEX_REPETITIONS
        ) {
          return unsafe();
        } else {
          finiteVariants *= maximum - minimum + 1;
          if (finiteVariants > MAX_SAFE_REGEX_VARIANTS) {
            return unsafe();
          }
        }
        index += quantifier[0].length - 1;
        canQuantify = false;
        continue;
      }
    }
    canQuantify = true;
  }
  return undefined;
}

function createEvaluationBudget(maxOperations: number): EvaluationBudget {
  return { maxOperations, operations: 0, exhausted: false };
}

function consumeEvaluationBudget(budget: EvaluationBudget, cost = 1): boolean {
  if (budget.exhausted) {
    return false;
  }
  budget.operations += cost;
  if (budget.operations > budget.maxOperations) {
    budget.exhausted = true;
    return false;
  }
  return true;
}

function budgetFailure(path: string): SchemaValidationResult {
  return { valid: false, path, reason: 'schema evaluation budget exceeded' };
}

function schemaRegex(context: SchemaContext, pattern: string): RegExp | undefined {
  const cached = context.regexCache.get(pattern);
  if (cached !== undefined) {
    return cached;
  }
  try {
    const expression = new RegExp(pattern, 'u');
    context.regexCache.set(pattern, expression);
    return expression;
  } catch {
    return undefined;
  }
}

function testSchemaRegex(
  context: SchemaContext,
  pattern: string,
  value: string,
): { readonly matched: boolean; readonly exhausted: boolean } {
  const cost = Math.min(Number.MAX_SAFE_INTEGER, pattern.length + value.length + 1);
  if (!consumeEvaluationBudget(context.budget, cost)) {
    return { matched: false, exhausted: true };
  }
  const expression = schemaRegex(context, pattern);
  if (expression === undefined) {
    return { matched: false, exhausted: context.budget.exhausted };
  }
  return { matched: expression.test(value), exhausted: false };
}

function validateSchemaShape(
  value: JsonSchema,
  path: string,
  seen: Set<object>,
  references: { readonly ref: string; readonly path: string }[],
): InternalIssue | undefined {
  if (typeof value === 'boolean') {
    return undefined;
  }
  if (!isPlainObject(value)) {
    return issue('malformed', path, 'schema must be an object or boolean');
  }
  if (seen.has(value)) {
    return issue('malformed', path, 'cyclic schema objects are not permitted');
  }
  seen.add(value);

  if (hasOwn(value, '$schema')) {
    if (typeof value.$schema !== 'string') {
      seen.delete(value);
      return issue('malformed', `${path}.$schema`, '$schema must be a string', '$schema');
    }
    if (value.$schema !== JSON_SCHEMA_DRAFT_2020_12) {
      seen.delete(value);
      return issue(
        'incompatible',
        `${path}.$schema`,
        'only JSON Schema Draft 2020-12 is supported',
        '$schema',
      );
    }
  }

  if (hasOwn(value, '$ref')) {
    const referenceIssue = addSchemaReference(references, value.$ref, path, '$ref');
    if (referenceIssue !== undefined) {
      seen.delete(value);
      return referenceIssue;
    }
  }
  for (const key of ['$dynamicRef', '$recursiveRef'] as const) {
    if (hasOwn(value, key)) {
      seen.delete(value);
      return issue('incompatible', `${path}.${key}`, `${key} is not supported`, key);
    }
  }

  if (
    hasOwn(value, '$anchor') &&
    (typeof value.$anchor !== 'string' || !SCHEMA_ANCHOR_PATTERN.test(value.$anchor))
  ) {
    seen.delete(value);
    return issue('malformed', `${path}.$anchor`, 'schema anchor is invalid', '$anchor');
  }
  if (hasOwn(value, '$dynamicAnchor')) {
    seen.delete(value);
    return issue(
      'incompatible',
      `${path}.$dynamicAnchor`,
      'dynamic anchors are not supported',
      '$dynamicAnchor',
    );
  }

  if (hasOwn(value, '$vocabulary')) {
    if (!isPlainObject(value.$vocabulary)) {
      seen.delete(value);
      return issue(
        'malformed',
        `${path}.$vocabulary`,
        '$vocabulary must be an object',
        '$vocabulary',
      );
    }
    for (const [vocabulary, required] of Object.entries(value.$vocabulary)) {
      if (typeof required !== 'boolean') {
        seen.delete(value);
        return issue(
          'malformed',
          `${path}.$vocabulary.${vocabulary}`,
          'vocabulary requirement must be boolean',
          '$vocabulary',
        );
      }
      if (required && !SUPPORTED_REQUIRED_VOCABULARIES.has(vocabulary)) {
        seen.delete(value);
        return issue(
          'incompatible',
          `${path}.$vocabulary.${vocabulary}`,
          vocabulary === FORMAT_ASSERTION_VOCABULARY
            ? 'format assertion vocabulary is not enabled'
            : 'required schema vocabulary is not supported',
          '$vocabulary',
        );
      }
    }
  }

  const typeIssue = validateSchemaKeywordType(
    value,
    'type',
    path,
    (candidate) =>
      (typeof candidate === 'string' && JSON_SCHEMA_TYPES.has(candidate)) ||
      (Array.isArray(candidate) &&
        candidate.length > 0 &&
        new Set(candidate).size === candidate.length &&
        candidate.every((entry) => typeof entry === 'string' && JSON_SCHEMA_TYPES.has(entry))),
    'type must be a JSON Schema type name or a non-empty array of unique type names',
  );
  if (typeIssue !== undefined) {
    seen.delete(value);
    return typeIssue;
  }

  for (const key of [
    'minLength',
    'maxLength',
    'minItems',
    'maxItems',
    'minProperties',
    'maxProperties',
  ] as const) {
    const keywordIssue = validateSchemaKeywordType(
      value,
      key,
      path,
      isNonNegativeInteger,
      `${key} must be a non-negative integer`,
    );
    if (keywordIssue !== undefined) {
      seen.delete(value);
      return keywordIssue;
    }
  }

  for (const key of [
    'minimum',
    'maximum',
    'exclusiveMinimum',
    'exclusiveMaximum',
    'multipleOf',
  ] as const) {
    const keywordIssue = validateSchemaKeywordType(
      value,
      key,
      path,
      isFiniteNumber,
      `${key} must be a finite number`,
    );
    if (keywordIssue !== undefined) {
      seen.delete(value);
      return keywordIssue;
    }
  }
  if (hasOwn(value, 'multipleOf')) {
    const multipleOf = value.multipleOf;
    if (!isFiniteNumber(multipleOf) || multipleOf <= 0) {
      seen.delete(value);
      return issue(
        'malformed',
        `${path}.multipleOf`,
        'multipleOf must be greater than zero',
        'multipleOf',
      );
    }
  }

  for (const key of ['minContains', 'maxContains'] as const) {
    const keywordIssue = validateSchemaKeywordType(
      value,
      key,
      path,
      isNonNegativeInteger,
      `${key} must be a non-negative integer`,
    );
    if (keywordIssue !== undefined) {
      seen.delete(value);
      return keywordIssue;
    }
  }
  if (hasOwn(value, 'minContains') && hasOwn(value, 'maxContains')) {
    const minContains = value.minContains;
    const maxContains = value.maxContains;
    if (
      isNonNegativeInteger(minContains) &&
      isNonNegativeInteger(maxContains) &&
      minContains > maxContains
    ) {
      seen.delete(value);
      return issue('malformed', path, 'minContains must not exceed maxContains', 'minContains');
    }
  }

  for (const key of ['required', 'dependentRequired'] as const) {
    if (!hasOwn(value, key)) {
      continue;
    }
    if (key === 'required') {
      if (
        !Array.isArray(value[key]) ||
        new Set(value[key]).size !== value[key].length ||
        !value[key].every((entry) => typeof entry === 'string')
      ) {
        seen.delete(value);
        return issue(
          'malformed',
          `${path}.${key}`,
          'required must be an array of unique strings',
          key,
        );
      }
    } else {
      if (!isPlainObject(value[key])) {
        seen.delete(value);
        return issue('malformed', `${path}.${key}`, 'dependentRequired must be an object', key);
      }
      for (const [property, dependencies] of Object.entries(value[key])) {
        if (
          !Array.isArray(dependencies) ||
          new Set(dependencies).size !== dependencies.length ||
          !dependencies.every((entry) => typeof entry === 'string')
        ) {
          seen.delete(value);
          return issue(
            'malformed',
            `${path}.${key}.${property}`,
            'dependency must be an array of unique strings',
            key,
          );
        }
      }
    }
  }

  for (const key of ['minProperties', 'maxProperties'] as const) {
    if (hasOwn(value, key) && !isNonNegativeInteger(value[key])) {
      seen.delete(value);
      return issue('malformed', `${path}.${key}`, `${key} must be a non-negative integer`, key);
    }
  }

  if (hasOwn(value, 'enum') && (!Array.isArray(value.enum) || value.enum.length === 0)) {
    seen.delete(value);
    return issue('malformed', `${path}.enum`, 'enum must be a non-empty array', 'enum');
  }

  for (const key of ['allOf', 'anyOf', 'oneOf'] as const) {
    if (
      hasOwn(value, key) &&
      (!Array.isArray(value[key]) || !value[key].every((entry) => isSchemaValue(entry)))
    ) {
      seen.delete(value);
      return issue('malformed', `${path}.${key}`, `${key} must be an array of schemas`, key);
    }
  }

  for (const key of ['format', 'pattern', 'contentEncoding', 'contentMediaType'] as const) {
    if (hasOwn(value, key) && typeof value[key] !== 'string') {
      seen.delete(value);
      return issue('malformed', `${path}.${key}`, `${key} must be a string`, key);
    }
  }
  if (hasOwn(value, 'pattern')) {
    const pattern = value.pattern;
    if (typeof pattern !== 'string') {
      seen.delete(value);
      return issue('malformed', `${path}.pattern`, 'pattern must be a string', 'pattern');
    }
    const patternIssue = validateRegexPattern(pattern, `${path}.pattern`, 'pattern');
    if (patternIssue !== undefined) {
      seen.delete(value);
      return patternIssue;
    }
  }

  if (hasOwn(value, 'uniqueItems') && typeof value.uniqueItems !== 'boolean') {
    seen.delete(value);
    return issue('malformed', `${path}.uniqueItems`, 'uniqueItems must be boolean', 'uniqueItems');
  }
  for (const key of ['unevaluatedItems', 'unevaluatedProperties'] as const) {
    if (hasOwn(value, key)) {
      seen.delete(value);
      return issue('incompatible', `${path}.${key}`, `${key} is not supported`, key);
    }
  }
  if (hasOwn(value, 'contains') && !isSchemaValue(value.contains)) {
    seen.delete(value);
    return issue('malformed', `${path}.contains`, 'contains must be a schema', 'contains');
  }

  const schemaChildren: [string, unknown][] = [];
  for (const key of [
    'additionalProperties',
    'contains',
    'else',
    'if',
    'items',
    'not',
    'propertyNames',
    'then',
  ] as const) {
    if (hasOwn(value, key)) {
      schemaChildren.push([key, value[key]]);
    }
  }
  for (const key of [
    '$defs',
    'definitions',
    'dependentSchemas',
    'patternProperties',
    'properties',
  ] as const) {
    if (!hasOwn(value, key)) {
      continue;
    }
    if (!isPlainObject(value[key])) {
      seen.delete(value);
      return issue('malformed', `${path}.${key}`, `${key} must be an object of schemas`, key);
    }
    for (const [name, child] of Object.entries(value[key])) {
      if (key === 'patternProperties') {
        const patternIssue = validateRegexPattern(name, `${path}.${key}.${name}`, key);
        if (patternIssue !== undefined) {
          seen.delete(value);
          return patternIssue;
        }
      }
      schemaChildren.push([`${key}.${name}`, child]);
    }
  }
  if (hasOwn(value, 'prefixItems')) {
    if (!Array.isArray(value.prefixItems)) {
      seen.delete(value);
      return issue(
        'malformed',
        `${path}.prefixItems`,
        'prefixItems must be an array of schemas',
        'prefixItems',
      );
    }
    value.prefixItems.forEach((child, index) =>
      schemaChildren.push([`prefixItems.${index}`, child]),
    );
  }

  for (const [childPathPart, child] of schemaChildren) {
    if (!isSchemaValue(child)) {
      seen.delete(value);
      return issue(
        'malformed',
        `${path}.${childPathPart}`,
        'keyword value must be a schema',
        childPathPart,
      );
    }
    const childIssue = validateSchemaShape(child, `${path}.${childPathPart}`, seen, references);
    if (childIssue !== undefined) {
      seen.delete(value);
      return childIssue;
    }
  }

  for (const key of ['allOf', 'anyOf', 'oneOf'] as const) {
    if (Array.isArray(value[key])) {
      for (const [index, child] of value[key].entries()) {
        const childIssue = validateSchemaShape(child, `${path}.${key}[${index}]`, seen, references);
        if (childIssue !== undefined) {
          seen.delete(value);
          return childIssue;
        }
      }
    }
  }

  seen.delete(value);
  return undefined;
}

function pointerDecode(value: string): string[] | undefined {
  if (value === '' || value === '#') {
    return [];
  }
  if (!value.startsWith('#/')) {
    return undefined;
  }

  let fragment: string;
  try {
    fragment = decodeURIComponent(value.slice(1));
  } catch {
    return undefined;
  }
  return fragment
    .slice(1)
    .split('/')
    .map((token) => token.replace(/~1/g, '/').replace(/~0/g, '~'));
}

function resolveSchemaReference(index: SchemaIndex, reference: string): JsonSchema | undefined {
  if (reference === '' || reference.startsWith('#')) {
    const pointer = pointerDecode(reference);
    if (pointer !== undefined) {
      let current: unknown = index.root;
      for (const token of pointer) {
        if (isPlainObject(current) && hasOwn(current, token)) {
          current = current[token];
        } else if (Array.isArray(current) && /^(?:0|[1-9]\d*)$/u.test(token)) {
          current = current[Number(token)];
        } else {
          return undefined;
        }
      }
      return isSchemaValue(current) ? current : undefined;
    }

    if (reference.length > 1) {
      const anchor = reference.slice(1);
      return index.anchors.get(anchor);
    }
  }
  return undefined;
}

function collectSchemaIndex(root: JsonSchema): SchemaIndex {
  const refs = new Map<string, JsonSchema>();
  const anchors = new Map<string, JsonSchema>();
  const references: { readonly ref: string; readonly path: string }[] = [];
  const seen = new Set<object>();

  const collect = (value: JsonSchema, path: string): void => {
    refs.set(path, value);
    if (typeof value === 'boolean') {
      return;
    }
    if (!isPlainObject(value) || seen.has(value)) {
      return;
    }
    seen.add(value);
    if (typeof value.$anchor === 'string') {
      anchors.set(value.$anchor, value);
    }
    if (typeof value.$dynamicAnchor === 'string') {
      anchors.set(value.$dynamicAnchor, value);
    }

    const schemaChild = (key: string, child: unknown): void => {
      if (isSchemaValue(child)) {
        collect(child, `${path}.${key}`);
      }
    };
    for (const key of [
      '$defs',
      'definitions',
      'dependentSchemas',
      'patternProperties',
      'properties',
    ] as const) {
      if (isPlainObject(value[key])) {
        for (const [name, child] of Object.entries(value[key])) {
          schemaChild(`${key}.${name}`, child);
        }
      }
    }
    for (const key of [
      'additionalProperties',
      'contains',
      'else',
      'if',
      'items',
      'not',
      'propertyNames',
      'then',
      'unevaluatedItems',
      'unevaluatedProperties',
    ] as const) {
      if (hasOwn(value, key)) {
        schemaChild(key, value[key]);
      }
    }
    if (Array.isArray(value.prefixItems)) {
      value.prefixItems.forEach((child, index) => schemaChild(`prefixItems.${index}`, child));
    }
    for (const key of ['allOf', 'anyOf', 'oneOf'] as const) {
      if (Array.isArray(value[key])) {
        value[key].forEach((child, index) => schemaChild(`${key}[${index}]`, child));
      }
    }
  };

  collect(root, '$');
  return { root, refs, anchors, references };
}

function validateSchemaReferences(index: SchemaIndex): InternalIssue | undefined {
  for (const reference of index.references) {
    if (resolveSchemaReference(index, reference.ref) === undefined) {
      return issue(
        'malformed',
        reference.path,
        'schema reference does not resolve locally',
        '$ref',
      );
    }
  }
  return undefined;
}

/** Validate a Draft 2020-12 schema without resolving remote references. */
export function validateJsonSchema(
  schema: unknown,
  options: ValidationOptions = {},
): ValidationResult<JsonSchema> {
  const limits = resolveLimits(options);
  const measured = measureJsonBytes(schema, limits.maxSchemaBytes, options);
  if (measured.kind === 'too_large') {
    return validationFailure(
      'oversized',
      'response schema exceeds the size limit',
      '$',
      'schema exceeds maxSchemaBytes',
    );
  }
  if (measured.kind === 'invalid') {
    return validationFailure(
      'malformed',
      'response schema is malformed',
      measured.path,
      measured.reason,
    );
  }
  if (!isSchemaValue(schema)) {
    return validationFailure(
      'malformed',
      'response schema is malformed',
      '$',
      'schema must be an object or boolean',
    );
  }

  const references: { readonly ref: string; readonly path: string }[] = [];
  const shapeIssue = validateSchemaShape(schema, '$', new Set<object>(), references);
  if (shapeIssue !== undefined) {
    return internalIssueFailure(shapeIssue);
  }

  const index = collectSchemaIndex(schema);
  const referenceIssue = validateSchemaReferences({ ...index, references });
  if (referenceIssue !== undefined) {
    return internalIssueFailure(referenceIssue);
  }
  if (compileDraft2020Schema(schema) === undefined) {
    return validationFailure(
      'malformed',
      'response schema is not supported by Draft 2020-12 validation',
      '$',
      'schema compilation failed',
    );
  }
  return success(schema);
}

export const validateSchema = validateJsonSchema;
export const validateExpectedResponseSchema = validateJsonSchema;

function validateExpectedResponseInternal(
  value: unknown,
  path: string,
  options: ValidationOptions,
): InternalIssue | undefined {
  if (!isPlainObject(value)) {
    return issue('malformed', path, 'expected response must be an object');
  }
  if (!hasOwn(value, 'contentType') || value.contentType !== 'json') {
    return issue(
      'incompatible',
      `${path}.contentType`,
      'expected responses must use JSON content',
      'contentType',
    );
  }
  if (!hasOwn(value, 'schema')) {
    return issue('malformed', `${path}.schema`, 'expected response schema is required', 'schema');
  }
  const result = validateJsonSchema(value.schema, options);
  if (result.ok) {
    return undefined;
  }
  const code: InternalCode =
    result.error.code === 'incompatible' ||
    result.error.code === 'expired' ||
    result.error.code === 'oversized' ||
    result.error.code === 'invalid_content' ||
    result.error.code === 'invalid_reply'
      ? result.error.code
      : 'malformed';
  return {
    code,
    path:
      typeof result.error.details?.path === 'string' ? result.error.details.path : `${path}.schema`,
    reason: result.error.message,
    ...(typeof result.error.details?.keyword === 'string'
      ? { keyword: result.error.details.keyword }
      : {}),
  };
}

/** Validate expected JSON response metadata and its bounded local schema. */
export function validateExpectedResponse(
  value: unknown,
  options: ValidationOptions = {},
): ValidationResult<ExpectedResponse> {
  const responseIssue = validateExpectedResponseInternal(value, '$', options);
  if (responseIssue !== undefined) {
    const code: ValidationErrorCode = responseIssue.code;
    return validationFailure(
      code,
      code === 'incompatible'
        ? 'expected response schema is incompatible'
        : 'expected response schema is invalid',
      responseIssue.path,
      responseIssue.reason,
      responseIssue.keyword,
    );
  }
  return success(value as ExpectedResponse);
}

export const validateExpectedResponseMetadata = validateExpectedResponse;

function validateProtocolErrorValue(
  value: unknown,
  path: string,
  options: ValidationOptions,
): InternalIssue | undefined {
  if (!isPlainObject(value)) {
    return issue('malformed', path, 'error must be an object');
  }
  if (
    !hasOwn(value, 'code') ||
    typeof value.code !== 'string' ||
    !PROTOCOL_ERROR_CODES.includes(value.code as ProtocolErrorCode)
  ) {
    return issue('malformed', `${path}.code`, 'error code is not recognized', 'code');
  }
  if (!hasOwn(value, 'message') || !isSafeHumanReadableMessage(value.message)) {
    return issue(
      'malformed',
      `${path}.message`,
      'error message must be a concise safe human-readable string',
      'message',
    );
  }
  if (!hasOwn(value, 'retryable') || typeof value.retryable !== 'boolean') {
    return issue('malformed', `${path}.retryable`, 'retryable must be boolean', 'retryable');
  }
  const code = value.code as ProtocolErrorCode;
  if (value.retryable !== isRetryableErrorCode(code)) {
    return issue(
      'malformed',
      `${path}.retryable`,
      'retryable does not match the error code',
      'retryable',
    );
  }
  if (
    hasOwn(value, 'retryAfterMs') &&
    (typeof value.retryAfterMs !== 'number' ||
      !Number.isFinite(value.retryAfterMs) ||
      value.retryAfterMs <= 0 ||
      !value.retryable)
  ) {
    return issue(
      'malformed',
      `${path}.retryAfterMs`,
      'retryAfterMs is invalid for this error',
      'retryAfterMs',
    );
  }
  if (hasOwn(value, 'details')) {
    const detailsIssue = validateJsonValueInternal(value.details, `${path}.details`, options);
    if (detailsIssue !== undefined) {
      return detailsIssue.code === 'oversized'
        ? issue('oversized', detailsIssue.path, detailsIssue.reason, 'details')
        : issue('malformed', detailsIssue.path, 'error details must be a JSON object', 'details');
    }
    if (!isJsonObject(value.details)) {
      return issue(
        'malformed',
        `${path}.details`,
        'error details must be a JSON object',
        'details',
      );
    }
  }
  return undefined;
}

function validatePayloadInternal(
  operation: OperationName,
  payload: unknown,
  options: ValidationOptions,
): InternalIssue | undefined {
  const path = '$.payload';
  if (!isPlainObject(payload)) {
    return issue('malformed', path, 'operation payload must be an object');
  }

  switch (operation) {
    case 'peer.describe':
      if (hasOwn(payload, 'requestedProtocolVersion')) {
        if (typeof payload.requestedProtocolVersion !== 'string') {
          return issue(
            'malformed',
            `${path}.requestedProtocolVersion`,
            'requested protocol version must be a string',
          );
        }
        if (payload.requestedProtocolVersion !== PROTOCOL_VERSION) {
          return issue(
            'incompatible',
            `${path}.requestedProtocolVersion`,
            'requested protocol version is unsupported',
          );
        }
      }
      return undefined;
    case 'message.request': {
      if (!hasOwn(payload, 'content')) {
        return issue('invalid_content', `${path}.content`, 'message.request content is required');
      }
      const contentIssue = validateTypedContentInternal(
        payload.content,
        `${path}.content`,
        options,
      );
      if (contentIssue !== undefined) {
        return contentIssue;
      }
      if (hasOwn(payload, 'expectedResponse')) {
        const expectedIssue = validateExpectedResponseInternal(
          payload.expectedResponse,
          `${path}.expectedResponse`,
          options,
        );
        if (expectedIssue !== undefined) {
          return expectedIssue;
        }
      }
      if (hasOwn(payload, 'metadata')) {
        return validateMetadataInternal(payload.metadata, `${path}.metadata`, options);
      }
      return undefined;
    }
    case 'message.notify': {
      if (!hasOwn(payload, 'content')) {
        return issue('invalid_content', `${path}.content`, 'message.notify content is required');
      }
      const contentIssue = validateTypedContentInternal(
        payload.content,
        `${path}.content`,
        options,
      );
      if (contentIssue !== undefined) {
        return contentIssue;
      }
      if (hasOwn(payload, 'metadata')) {
        return validateMetadataInternal(payload.metadata, `${path}.metadata`, options);
      }
      return undefined;
    }
    case 'message.reply': {
      if (
        !hasOwn(payload, 'outcome') ||
        typeof payload.outcome !== 'string' ||
        !isTerminalOutcome(payload.outcome)
      ) {
        return issue('malformed', `${path}.outcome`, 'reply outcome is unsupported', 'outcome');
      }
      const outcome = payload.outcome as MessageReplyPayload['outcome'];
      if (outcome === 'completed') {
        if (!hasOwn(payload, 'content')) {
          return issue('invalid_content', `${path}.content`, 'completed replies require content');
        }
        const contentIssue = validateTypedContentInternal(
          payload.content,
          `${path}.content`,
          options,
        );
        if (contentIssue !== undefined) {
          return contentIssue;
        }
        if (hasOwn(payload, 'error')) {
          return issue('malformed', `${path}.error`, 'completed replies cannot include an error');
        }
        return undefined;
      }
      if (hasOwn(payload, 'content')) {
        return issue('malformed', `${path}.content`, `${outcome} replies cannot include content`);
      }
      if (!hasOwn(payload, 'error')) {
        return outcome === 'failed' || outcome === 'rejected'
          ? issue('malformed', `${path}.error`, `${outcome} replies require an error`)
          : undefined;
      }
      return validateProtocolErrorValue(payload.error, `${path}.error`, options);
    }
    case 'task.status':
      if (
        hasOwn(payload, 'includeTerminalResponse') &&
        typeof payload.includeTerminalResponse !== 'boolean'
      ) {
        return issue(
          'malformed',
          `${path}.includeTerminalResponse`,
          'includeTerminalResponse must be boolean',
        );
      }
      return undefined;
    case 'task.cancel':
      if (hasOwn(payload, 'reason') && typeof payload.reason !== 'string') {
        return issue('malformed', `${path}.reason`, 'cancellation reason must be a string');
      }
      return undefined;
    default:
      return issue('incompatible', '$.operation', 'operation is unsupported');
  }
}

function validateEnvelopeRequiredFields(value: UnknownRecord): InternalIssue | undefined {
  for (const field of REQUIRED_ENVELOPE_FIELDS) {
    if (!hasOwn(value, field) || value[field] === undefined) {
      return issue('malformed', `$.${field}`, 'required envelope field is missing');
    }
  }
  return undefined;
}

function validateEnvelopeOperationIds(
  envelope: UnknownRecord,
  operation: OperationName,
): InternalIssue | undefined {
  const operationId = envelope.operationId;
  if (!isUuidV4Value(operationId)) {
    return issue('malformed', '$.operationId', 'operationId must be a UUIDv4', 'operationId');
  }

  const hasRequestId = hasOwn(envelope, 'requestId');
  if (operation === 'message.request') {
    if (!hasRequestId || !isUuidV4Value(envelope.requestId)) {
      return issue(
        'malformed',
        '$.requestId',
        'message.request requires a UUIDv4 requestId',
        'requestId',
      );
    }
    if (envelope.requestId !== operationId) {
      return issue(
        'malformed',
        '$.requestId',
        'message.request requestId must equal operationId',
        'requestId',
      );
    }
    return undefined;
  }

  if (operation === 'message.reply' || operation === 'task.status' || operation === 'task.cancel') {
    if (!hasRequestId || !isUuidV4Value(envelope.requestId)) {
      return issue(
        'malformed',
        '$.requestId',
        `${operation} requires a UUIDv4 target requestId`,
        'requestId',
      );
    }
    if (envelope.requestId === operationId) {
      return issue(
        'malformed',
        '$.requestId',
        `${operation} requires a new operationId`,
        'requestId',
      );
    }
    return undefined;
  }

  if (hasRequestId) {
    return issue('malformed', '$.requestId', `${operation} must omit requestId`, 'requestId');
  }
  return undefined;
}

/** Validate the common v1 JSON envelope and all operation discriminants. */
export function validateEnvelope(
  value: unknown,
  options: ValidationOptions = {},
): ValidationResult<ProtocolEnvelope> {
  const limits = resolveLimits(options);
  const measured = measureJsonBytes(value, limits.maxEnvelopeBytes, options);
  if (measured.kind === 'too_large') {
    return validationFailure(
      'oversized',
      'protocol envelope exceeds the size limit',
      '$',
      'envelope exceeds maxEnvelopeBytes',
    );
  }
  if (measured.kind === 'invalid') {
    return validationFailure(
      'malformed',
      'protocol envelope is malformed',
      measured.path,
      measured.reason,
    );
  }
  if (!isPlainObject(value)) {
    return validationFailure(
      'malformed',
      'protocol envelope is malformed',
      '$',
      'envelope must be an object',
    );
  }

  const requiredIssue = validateEnvelopeRequiredFields(value);
  if (requiredIssue !== undefined) {
    return internalIssueFailure(requiredIssue);
  }

  if (typeof value.protocolVersion !== 'string') {
    return validationFailure(
      'malformed',
      'protocol envelope is malformed',
      '$.protocolVersion',
      'protocolVersion must be a string',
    );
  }
  if (value.protocolVersion !== PROTOCOL_VERSION) {
    return validationFailure(
      'incompatible',
      'protocol version is unsupported',
      '$.protocolVersion',
      'unsupported protocol version',
    );
  }

  if (typeof value.operation !== 'string') {
    return validationFailure(
      'malformed',
      'protocol envelope is malformed',
      '$.operation',
      'operation must be a string',
    );
  }
  if (!OPERATION_NAMES.includes(value.operation as OperationName)) {
    return validationFailure(
      'incompatible',
      'operation is unsupported',
      '$.operation',
      'unsupported operation',
    );
  }
  const operation = value.operation as OperationName;

  const idsIssue = validateEnvelopeOperationIds(value, operation);
  if (idsIssue !== undefined) {
    return internalIssueFailure(idsIssue);
  }
  if (hasOwn(value, 'parentOperationId') && !isUuidV4Value(value.parentOperationId)) {
    return validationFailure(
      'malformed',
      'protocol envelope is malformed',
      '$.parentOperationId',
      'parentOperationId must be a UUIDv4',
    );
  }

  if (!isPlainObject(value.sender)) {
    return validationFailure(
      'malformed',
      'protocol envelope is malformed',
      '$.sender',
      'sender must be an object',
    );
  }
  if (!hasOwn(value.sender, 'sessionId') || !isSafeIdentifier(value.sender.sessionId)) {
    return validationFailure(
      'malformed',
      'protocol envelope is malformed',
      '$.sender.sessionId',
      'sessionId must be a non-empty safe string',
    );
  }
  if (!hasOwn(value.sender, 'runtimeId') || !isSafeIdentifier(value.sender.runtimeId)) {
    return validationFailure(
      'malformed',
      'protocol envelope is malformed',
      '$.sender.runtimeId',
      'runtimeId must be a non-empty safe string',
    );
  }
  if (!isSafeIdentifier(value.recipientRuntimeId)) {
    return validationFailure(
      'malformed',
      'protocol envelope is malformed',
      '$.recipientRuntimeId',
      'recipientRuntimeId must be a non-empty safe string',
    );
  }
  if (!isRoomId(value.roomId)) {
    return validationFailure(
      'malformed',
      'protocol envelope is malformed',
      '$.roomId',
      'roomId must be a canonical r1 room ID',
    );
  }
  if (typeof value.traceId !== 'string' || !TRACE_ID_PATTERN.test(value.traceId)) {
    return validationFailure(
      'malformed',
      'protocol envelope is malformed',
      '$.traceId',
      'traceId must be 32 lowercase hexadecimal characters',
    );
  }

  const createdAt = parseUtcTimestamp(value.createdAt);
  const expiresAt = parseUtcTimestamp(value.expiresAt);
  if (createdAt === undefined) {
    return validationFailure(
      'malformed',
      'protocol envelope is malformed',
      '$.createdAt',
      'createdAt must be an RFC 3339 UTC timestamp',
    );
  }
  if (expiresAt === undefined) {
    return validationFailure(
      'malformed',
      'protocol envelope is malformed',
      '$.expiresAt',
      'expiresAt must be an RFC 3339 UTC timestamp',
    );
  }
  if (expiresAt <= createdAt) {
    return validationFailure(
      'malformed',
      'protocol envelope is malformed',
      '$.expiresAt',
      'expiresAt must be later than createdAt',
    );
  }

  const deadlineLimit =
    operation === 'peer.describe' || operation === 'task.status' || operation === 'task.cancel'
      ? limits.maxControlTtlMs
      : limits.maxRequestTtlMs;
  if (expiresAt - createdAt > deadlineLimit) {
    return validationFailure(
      'malformed',
      'protocol envelope is malformed',
      '$.expiresAt',
      'operation deadline exceeds the configured v1 limit',
    );
  }

  const now = resolveNow(options.now);
  if (createdAt > now + MAX_CLOCK_SKEW_MS) {
    return validationFailure(
      'malformed',
      'protocol envelope is malformed',
      '$.createdAt',
      'createdAt is too far in the future',
    );
  }
  if (expiresAt <= now) {
    return validationFailure(
      'expired',
      'protocol operation has expired',
      '$.expiresAt',
      'expiresAt is at or before now',
    );
  }

  const payloadIssue = validatePayloadInternal(operation, value.payload, options);
  if (payloadIssue !== undefined) {
    if (payloadIssue.code === 'invalid_content') {
      return validationFailure(
        'invalid_content',
        'operation content is invalid',
        payloadIssue.path,
        payloadIssue.reason,
        payloadIssue.keyword,
      );
    }
    return internalIssueFailure(payloadIssue);
  }

  return success(value as unknown as ProtocolEnvelope);
}

export const validateProtocolEnvelope = validateEnvelope;
export const validateOperationEnvelope = validateEnvelope;
export const validateMessageEnvelope = validateEnvelope;

/** Validate serialized JSON with the byte limit enforced before JSON.parse. */
export function validateSerializedEnvelope(
  source: unknown,
  options: ValidationOptions = {},
): ValidationResult<ProtocolEnvelope> {
  if (typeof source !== 'string') {
    return validationFailure(
      'malformed',
      'protocol envelope is malformed',
      '$',
      'serialized envelope must be a string',
    );
  }
  const limits = resolveLimits(options);
  if (Buffer.byteLength(source, 'utf8') > limits.maxEnvelopeBytes) {
    return validationFailure(
      'oversized',
      'protocol envelope exceeds the size limit',
      '$',
      'serialized envelope exceeds maxEnvelopeBytes',
    );
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(source) as unknown;
  } catch {
    return validationFailure(
      'malformed',
      'protocol envelope is malformed',
      '$',
      'serialized envelope is not valid JSON',
    );
  }
  return validateEnvelope(decoded, options);
}

export const parseProtocolEnvelopeJson = validateSerializedEnvelope;
export const validateWireEnvelope = validateSerializedEnvelope;
function validateAgentCardInternal(value: unknown, path: string): InternalIssue | undefined {
  if (!isPlainObject(value)) {
    return issue('malformed', path, 'agent card must be an object');
  }

  // Discovery cards use a separate numeric schema and are accepted here only as
  // the peer.describe result's discovery-card member.
  if (hasOwn(value, 'protocolVersion') && hasOwn(value, 'runtimeInstanceId')) {
    const discoveryResult = validateDiscoveryAgentCard(value);
    if (discoveryResult.valid) {
      return undefined;
    }
    const firstIssue = discoveryResult.errors[0];
    return issue(
      'malformed',
      firstIssue === undefined || firstIssue.path === '$'
        ? path
        : `${path}.${firstIssue.path.replace(/^\.??/u, '')}`,
      'discovery agent card is invalid',
    );
  }
  if (!hasOwn(value, 'name') || !isSafeIdentifier(value.name) || value.name.length > 256) {
    return issue('malformed', `${path}.name`, 'agent card name is invalid', 'name');
  }
  if (
    hasOwn(value, 'description') &&
    (typeof value.description !== 'string' ||
      value.description.length > 1024 ||
      hasControlCharacters(value.description))
  ) {
    return issue(
      'malformed',
      `${path}.description`,
      'agent card description is invalid',
      'description',
    );
  }
  if (!hasOwn(value, 'sessionId') || !isSafeIdentifier(value.sessionId)) {
    return issue('malformed', `${path}.sessionId`, 'agent card sessionId is invalid', 'sessionId');
  }
  if (!hasOwn(value, 'runtimeId') || !isSafeIdentifier(value.runtimeId)) {
    return issue('malformed', `${path}.runtimeId`, 'agent card runtimeId is invalid', 'runtimeId');
  }
  if (
    !hasOwn(value, 'supportedProtocolVersions') ||
    !Array.isArray(value.supportedProtocolVersions) ||
    value.supportedProtocolVersions.length === 0 ||
    !value.supportedProtocolVersions.includes(PROTOCOL_VERSION) ||
    !value.supportedProtocolVersions.every((version) => version === PROTOCOL_VERSION)
  ) {
    return issue(
      'incompatible',
      `${path}.supportedProtocolVersions`,
      'agent card must advertise exactly supported protocol versions',
      'supportedProtocolVersions',
    );
  }
  if (new Set(value.supportedProtocolVersions).size !== value.supportedProtocolVersions.length) {
    return issue(
      'malformed',
      `${path}.supportedProtocolVersions`,
      'supportedProtocolVersions must not contain duplicates',
      'supportedProtocolVersions',
    );
  }
  if (
    !hasOwn(value, 'operations') ||
    !Array.isArray(value.operations) ||
    value.operations.length === 0
  ) {
    return issue(
      'malformed',
      `${path}.operations`,
      'agent card operations are required',
      'operations',
    );
  }
  const seenOperations = new Set<string>();
  for (const [index, operation] of value.operations.entries()) {
    const operationPath = `${path}.operations[${index}]`;
    if (
      !isPlainObject(operation) ||
      !hasOwn(operation, 'operation') ||
      typeof operation.operation !== 'string'
    ) {
      return issue('malformed', operationPath, 'operation capability is invalid', 'operation');
    }
    if (!OPERATION_NAMES.includes(operation.operation as OperationName)) {
      return issue(
        'incompatible',
        `${operationPath}.operation`,
        'operation is unsupported',
        'operation',
      );
    }
    if (seenOperations.has(operation.operation)) {
      return issue(
        'malformed',
        `${operationPath}.operation`,
        'operation capability is duplicated',
        'operation',
      );
    }
    seenOperations.add(operation.operation);
    if (hasOwn(operation, 'description') && !isSafeIdentifier(operation.description)) {
      return issue(
        'malformed',
        `${operationPath}.description`,
        'operation description is invalid',
        'description',
      );
    }
  }
  if (
    !hasOwn(value, 'contentCapabilities') ||
    !Array.isArray(value.contentCapabilities) ||
    value.contentCapabilities.length === 0
  ) {
    return issue(
      'malformed',
      `${path}.contentCapabilities`,
      'content capabilities are required',
      'contentCapabilities',
    );
  }
  const seenContentTypes = new Set<string>();
  for (const [index, capability] of value.contentCapabilities.entries()) {
    const capabilityPath = `${path}.contentCapabilities[${index}]`;
    if (
      !isPlainObject(capability) ||
      !hasOwn(capability, 'type') ||
      (capability.type !== 'text' && capability.type !== 'json')
    ) {
      return issue('malformed', capabilityPath, 'content capability type is invalid', 'type');
    }
    if (seenContentTypes.has(capability.type)) {
      return issue(
        'malformed',
        `${capabilityPath}.type`,
        'content capability is duplicated',
        'type',
      );
    }
    seenContentTypes.add(capability.type);
    if (hasOwn(capability, 'supportsSchema') && typeof capability.supportsSchema !== 'boolean') {
      return issue(
        'malformed',
        `${capabilityPath}.supportsSchema`,
        'supportsSchema must be boolean',
        'supportsSchema',
      );
    }
  }
  if (!hasOwn(value, 'capabilities') || !isPlainObject(value.capabilities)) {
    return issue(
      'malformed',
      `${path}.capabilities`,
      'agent capabilities are required',
      'capabilities',
    );
  }
  for (const capabilityName of ['supportsCancellation', 'supportsNotifications'] as const) {
    if (
      !hasOwn(value.capabilities, capabilityName) ||
      typeof value.capabilities[capabilityName] !== 'boolean'
    ) {
      return issue(
        'malformed',
        `${path}.capabilities.${capabilityName}`,
        `${capabilityName} must be boolean`,
        capabilityName,
      );
    }
  }
  if (!hasOwn(value, 'limits') || !isPlainObject(value.limits)) {
    return issue('malformed', `${path}.limits`, 'protocol limits are required', 'limits');
  }
  const limitCeilings: Record<string, number> = {
    requestTtlMs: MAX_REQUEST_TTL_MS,
    maxRequestTtlMs: MAX_REQUEST_TTL_MS,
    maxControlTtlMs: MAX_CONTROL_TTL_MS,
    maxEnvelopeBytes: MAX_ENVELOPE_BYTES,
    maxSchemaBytes: MAX_SCHEMA_BYTES,
    maxQueueEntries: DEFAULT_QUEUE_LIMIT,
  };
  for (const [name, ceiling] of Object.entries(limitCeilings)) {
    const limit = value.limits[name];
    if (
      !hasOwn(value.limits, name) ||
      typeof limit !== 'number' ||
      !Number.isSafeInteger(limit) ||
      limit <= 0 ||
      limit > ceiling
    ) {
      return issue(
        'malformed',
        `${path}.limits.${name}`,
        `${name} must be a positive value within the v1 ceiling`,
        name,
      );
    }
  }
  const requestTtlMs = value.limits.requestTtlMs;
  const maxRequestTtlMs = value.limits.maxRequestTtlMs;
  if (
    typeof requestTtlMs !== 'number' ||
    typeof maxRequestTtlMs !== 'number' ||
    requestTtlMs > maxRequestTtlMs
  ) {
    return issue(
      'malformed',
      `${path}.limits.requestTtlMs`,
      'requestTtlMs must not exceed maxRequestTtlMs',
      'requestTtlMs',
    );
  }
  return undefined;
}

function validateTaskSnapshotInternal(
  value: unknown,
  path: string,
  options: ValidationOptions,
): InternalIssue | undefined {
  if (!isPlainObject(value)) {
    return issue('malformed', path, 'task snapshot must be an object');
  }
  if (!hasOwn(value, 'requestId') || !isUuidV4Value(value.requestId)) {
    return issue(
      'malformed',
      `${path}.requestId`,
      'task snapshot requestId must be a UUIDv4',
      'requestId',
    );
  }
  if (options.expectedRequestId !== undefined && value.requestId !== options.expectedRequestId) {
    return issue(
      'malformed',
      `${path}.requestId`,
      'task snapshot requestId does not match the expected request',
      'requestId',
    );
  }
  if (
    !hasOwn(value, 'state') ||
    typeof value.state !== 'string' ||
    !(TASK_STATES as readonly string[]).includes(value.state)
  ) {
    return issue('malformed', `${path}.state`, 'task snapshot state is invalid', 'state');
  }
  const state = value.state as TaskState;
  const timestampFields = ['createdAt', 'updatedAt', 'expiresAt'] as const;
  const timestamps = new Map<string, number>();
  for (const field of timestampFields) {
    if (!hasOwn(value, field)) {
      return issue('malformed', `${path}.${field}`, 'task snapshot timestamp is required', field);
    }
    const timestamp = parseUtcTimestamp(value[field]);
    if (timestamp === undefined) {
      return issue('malformed', `${path}.${field}`, 'task snapshot timestamp is invalid', field);
    }
    timestamps.set(field, timestamp);
  }
  if (timestamps.get('updatedAt')! < timestamps.get('createdAt')!) {
    return issue(
      'malformed',
      `${path}.updatedAt`,
      'task snapshot updatedAt must not precede createdAt',
      'updatedAt',
    );
  }
  if (timestamps.get('expiresAt')! <= timestamps.get('createdAt')!) {
    return issue(
      'malformed',
      `${path}.expiresAt`,
      'task snapshot expiry must be later than creation',
      'expiresAt',
    );
  }
  const createdAt = timestamps.get('createdAt')!;
  const updatedAt = timestamps.get('updatedAt')!;
  const expiresAt = timestamps.get('expiresAt')!;
  const limits = resolveLimits(options);
  const now = resolveNow(options.now);
  if (expiresAt - createdAt > limits.maxRequestTtlMs) {
    return issue(
      'malformed',
      `${path}.expiresAt`,
      'task snapshot lifetime exceeds the configured request limit',
      'expiresAt',
    );
  }
  if (createdAt > now + MAX_CLOCK_SKEW_MS) {
    return issue(
      'malformed',
      `${path}.createdAt`,
      'task snapshot creation time is too far in the future',
      'createdAt',
    );
  }
  if (updatedAt > now + MAX_CLOCK_SKEW_MS) {
    return issue(
      'malformed',
      `${path}.updatedAt`,
      'task snapshot update time is too far in the future',
      'updatedAt',
    );
  }
  if (expiresAt <= now) {
    return issue('expired', `${path}.expiresAt`, 'task snapshot deadline has passed', 'expiresAt');
  }
  if (updatedAt > expiresAt && state !== 'expired') {
    return issue(
      'malformed',
      `${path}.updatedAt`,
      'task snapshot update time must not exceed its deadline',
      'updatedAt',
    );
  }
  if (!hasOwn(value, 'cancellationRequested') || typeof value.cancellationRequested !== 'boolean') {
    return issue(
      'malformed',
      `${path}.cancellationRequested`,
      'cancellationRequested must be boolean',
      'cancellationRequested',
    );
  }
  if (hasOwn(value, 'cancellation')) {
    if (
      !isPlainObject(value.cancellation) ||
      !hasOwn(value.cancellation, 'state') ||
      (value.cancellation.state !== 'not_requested' && value.cancellation.state !== 'requested')
    ) {
      return issue(
        'malformed',
        `${path}.cancellation`,
        'cancellation snapshot is invalid',
        'cancellation',
      );
    }
    const requested = value.cancellation.state === 'requested';
    if (requested !== value.cancellationRequested) {
      return issue(
        'malformed',
        `${path}.cancellation.state`,
        'cancellation state does not match cancellationRequested',
        'state',
      );
    }
    if (
      hasOwn(value.cancellation, 'requestedAt') &&
      parseUtcTimestamp(value.cancellation.requestedAt) === undefined
    ) {
      return issue(
        'malformed',
        `${path}.cancellation.requestedAt`,
        'cancellation requestedAt must be a valid timestamp',
        'requestedAt',
      );
    }
    const requestedAt = hasOwn(value.cancellation, 'requestedAt')
      ? parseUtcTimestamp(value.cancellation.requestedAt)
      : undefined;
    if (
      requestedAt !== undefined &&
      (requestedAt < createdAt || requestedAt > now + MAX_CLOCK_SKEW_MS || requestedAt > expiresAt)
    ) {
      return issue(
        'malformed',
        `${path}.cancellation.requestedAt`,
        'cancellation requestedAt is outside the task lifetime',
        'requestedAt',
      );
    }
  }
  const terminal = isTerminalTaskState(state);
  if (terminal) {
    if (
      !hasOwn(value, 'terminalOutcome') ||
      typeof value.terminalOutcome !== 'string' ||
      !isTerminalOutcome(value.terminalOutcome)
    ) {
      return issue(
        'malformed',
        `${path}.terminalOutcome`,
        'terminal task state requires a matching outcome',
        'terminalOutcome',
      );
    }
    if (value.terminalOutcome !== state) {
      return issue(
        'malformed',
        `${path}.terminalOutcome`,
        'terminal outcome must match task state',
        'terminalOutcome',
      );
    }
  } else if (hasOwn(value, 'terminalOutcome')) {
    return issue(
      'malformed',
      `${path}.terminalOutcome`,
      'nonterminal task cannot include terminalOutcome',
      'terminalOutcome',
    );
  }
  if (hasOwn(value, 'content')) {
    const contentIssue = validateTypedContentInternal(value.content, `${path}.content`, options);
    if (contentIssue !== undefined) {
      return contentIssue;
    }
  }
  if (hasOwn(value, 'error')) {
    const errorIssue = validateProtocolErrorValue(value.error, `${path}.error`, options);
    if (errorIssue !== undefined) {
      return errorIssue;
    }
  }
  if (hasOwn(value, 'content') && hasOwn(value, 'error')) {
    return issue('malformed', path, 'task snapshot cannot contain both content and error');
  }
  return undefined;
}

function validateResultForOperation(
  operation: OperationName,
  result: unknown,
  path: string,
  responseOperationId: unknown,
  options: ValidationOptions,
): InternalIssue | undefined {
  if (!isPlainObject(result)) {
    return issue('malformed', path, 'operation result must be an object');
  }
  switch (operation) {
    case 'peer.describe': {
      if (!hasOwn(result, 'agentCard')) {
        return issue(
          'malformed',
          `${path}.agentCard`,
          'peer.describe result requires an agent card',
          'agentCard',
        );
      }
      return validateAgentCardInternal(result.agentCard, `${path}.agentCard`);
    }
    case 'message.request':
      if (!hasOwn(result, 'requestId') || !isUuidV4Value(result.requestId)) {
        return issue('malformed', `${path}.requestId`, 'requestId must be a UUIDv4', 'requestId');
      }
      if (result.requestId !== responseOperationId) {
        return issue(
          'malformed',
          `${path}.requestId`,
          'request result requestId must match response operationId',
          'requestId',
        );
      }
      if (
        options.expectedRequestId !== undefined &&
        result.requestId !== options.expectedRequestId
      ) {
        return issue(
          'malformed',
          `${path}.requestId`,
          'request result requestId does not match the expected request',
          'requestId',
        );
      }
      if (
        !hasOwn(result, 'state') ||
        typeof result.state !== 'string' ||
        !ADMISSION_STATES.has(result.state)
      ) {
        return issue(
          'malformed',
          `${path}.state`,
          'request result state must be accepted or queued',
          'state',
        );
      }
      return undefined;
    case 'message.reply':
      if (!hasOwn(result, 'requestId') || !isUuidV4Value(result.requestId)) {
        return issue('malformed', `${path}.requestId`, 'requestId must be a UUIDv4', 'requestId');
      }
      if (
        options.expectedRequestId !== undefined &&
        result.requestId !== options.expectedRequestId
      ) {
        return issue(
          'malformed',
          `${path}.requestId`,
          'reply result requestId does not match the expected request',
          'requestId',
        );
      }
      if (
        !hasOwn(result, 'outcome') ||
        typeof result.outcome !== 'string' ||
        !isTerminalOutcome(result.outcome)
      ) {
        return issue('malformed', `${path}.outcome`, 'reply result outcome is invalid', 'outcome');
      }
      return hasOwn(result, 'delivered') && result.delivered === true
        ? undefined
        : issue(
            'malformed',
            `${path}.delivered`,
            'reply result must acknowledge delivery',
            'delivered',
          );
    case 'message.notify':
      return hasOwn(result, 'delivered') && result.delivered === true
        ? undefined
        : issue(
            'malformed',
            `${path}.delivered`,
            'notification result must acknowledge delivery',
            'delivered',
          );
    case 'task.status':
    case 'task.cancel':
      if (!hasOwn(result, 'snapshot')) {
        return issue(
          'malformed',
          `${path}.snapshot`,
          'task result must include a snapshot',
          'snapshot',
        );
      }
      return validateTaskSnapshotInternal(result.snapshot, `${path}.snapshot`, options);
    default:
      return issue('incompatible', '$.operation', 'operation is unsupported');
  }
}

/** Validate operation responses and enforce the exactly-one result/error rule. */
export function validateOperationResponse(
  value: unknown,
  options: ValidationOptions = {},
): ValidationResult<OperationResponse> {
  const limits = resolveLimits(options);
  const measured = measureJsonBytes(value, limits.maxEnvelopeBytes, options);
  if (measured.kind === 'too_large') {
    return validationFailure(
      'oversized',
      'operation response exceeds the size limit',
      '$',
      'response exceeds maxEnvelopeBytes',
    );
  }
  if (measured.kind === 'invalid') {
    return validationFailure(
      'malformed',
      'operation response is malformed',
      measured.path,
      measured.reason,
    );
  }
  if (!isPlainObject(value)) {
    return validationFailure(
      'malformed',
      'operation response is malformed',
      '$',
      'response must be an object',
    );
  }
  if (!hasOwn(value, 'protocolVersion') || typeof value.protocolVersion !== 'string') {
    return validationFailure(
      'malformed',
      'operation response is malformed',
      '$.protocolVersion',
      'protocolVersion must be a string',
    );
  }
  if (value.protocolVersion !== PROTOCOL_VERSION) {
    return validationFailure(
      'incompatible',
      'protocol version is unsupported',
      '$.protocolVersion',
      'unsupported protocol version',
    );
  }
  if (!hasOwn(value, 'operation') || typeof value.operation !== 'string') {
    return validationFailure(
      'malformed',
      'operation response is malformed',
      '$.operation',
      'operation must be a string',
    );
  }
  if (!OPERATION_NAMES.includes(value.operation as OperationName)) {
    return validationFailure(
      'incompatible',
      'operation is unsupported',
      '$.operation',
      'unsupported operation',
    );
  }
  if (!hasOwn(value, 'operationId') || !isUuidV4Value(value.operationId)) {
    return validationFailure(
      'malformed',
      'operation response is malformed',
      '$.operationId',
      'operationId must be a UUIDv4',
    );
  }
  if (
    !hasOwn(value, 'traceId') ||
    typeof value.traceId !== 'string' ||
    !TRACE_ID_PATTERN.test(value.traceId)
  ) {
    return validationFailure(
      'malformed',
      'operation response is malformed',
      '$.traceId',
      'traceId must be 32 lowercase hexadecimal characters',
    );
  }

  const hasResult = hasOwn(value, 'result');
  const hasError = hasOwn(value, 'error');
  if (
    hasResult === hasError ||
    (hasResult && value.result === undefined) ||
    (hasError && value.error === undefined)
  ) {
    return validationFailure(
      'malformed',
      'operation response is malformed',
      '$',
      'response must contain exactly one result or error',
    );
  }

  const operation = value.operation as OperationName;
  if (hasError) {
    const errorIssue = validateProtocolErrorValue(value.error, '$.error', options);
    if (errorIssue !== undefined) {
      return internalIssueFailure(errorIssue);
    }
  } else {
    const resultIssue = validateResultForOperation(
      operation,
      value.result,
      '$.result',
      value.operationId,
      options,
    );
    if (resultIssue !== undefined) {
      return internalIssueFailure(resultIssue);
    }
  }

  return success(value as unknown as OperationResponse);
}

export const validateProtocolOperationResponse = validateOperationResponse;
export const validateResponse = validateOperationResponse;

function deepEqualJson(left: JsonValue, right: JsonValue, budget?: EvaluationBudget): boolean {
  if (budget !== undefined && !consumeEvaluationBudget(budget)) {
    return false;
  }
  if (typeof left === 'number' && typeof right === 'number') {
    return left === right;
  }
  if (Object.is(left, right)) {
    return true;
  }
  if (typeof left !== typeof right || left === null || right === null) {
    return false;
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
      return false;
    }
    for (let index = 0; index < left.length; index += 1) {
      if (!deepEqualJson(left[index], right[index], budget)) {
        return false;
      }
    }
    return true;
  }
  if (isPlainObject(left) && isPlainObject(right)) {
    const leftKeys = Object.keys(left).sort();
    const rightKeys = Object.keys(right).sort();
    if (
      leftKeys.length !== rightKeys.length ||
      leftKeys.some((key, index) => key !== rightKeys[index])
    ) {
      return false;
    }
    for (const key of leftKeys) {
      if (!deepEqualJson(left[key] as JsonValue, right[key] as JsonValue, budget)) {
        return false;
      }
    }
    return true;
  }
  return false;
}

function schemaTypeMatches(value: JsonValue, type: string): boolean {
  switch (type) {
    case 'null':
      return value === null;
    case 'boolean':
      return typeof value === 'boolean';
    case 'object':
      return isPlainObject(value);
    case 'array':
      return Array.isArray(value);
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'integer':
      return typeof value === 'number' && Number.isSafeInteger(value);
    case 'string':
      return typeof value === 'string';
    default:
      return false;
  }
}
function schemaReference(value: UnknownRecord): string | undefined {
  if (hasOwn(value, '$ref') && typeof value.$ref === 'string') {
    return value.$ref;
  }
  return undefined;
}

function matchesSchema(
  value: JsonValue,
  schema: JsonSchema,
  context: SchemaContext,
  path: string,
  depth: number,
  activeRefs: ReadonlyMap<string, number>,
): SchemaValidationResult {
  if (!consumeEvaluationBudget(context.budget)) {
    return budgetFailure(path);
  }
  if (depth > context.maxDepth) {
    return { valid: false, path, reason: 'maximum schema evaluation depth exceeded' };
  }
  if (typeof schema === 'boolean') {
    return schema ? { valid: true } : { valid: false, path, reason: 'boolean schema is false' };
  }

  const reference = schemaReference(schema);
  if (reference !== undefined) {
    const referenceDepth = activeRefs.get(reference) ?? 0;
    if (referenceDepth >= context.maxDepth) {
      return { valid: false, path, reason: 'maximum schema reference depth exceeded' };
    }
    const target = resolveSchemaReference(context, reference);
    if (target === undefined) {
      return { valid: false, path, reason: 'schema reference does not resolve locally' };
    }
    const nextRefs = new Map(activeRefs);
    nextRefs.set(reference, referenceDepth + 1);
    const referencedResult = matchesSchema(value, target, context, path, depth + 1, nextRefs);
    if (!referencedResult.valid) {
      return referencedResult;
    }
  }

  if (hasOwn(schema, 'type')) {
    const types = typeof schema.type === 'string' ? [schema.type] : (schema.type as unknown[]);
    if (!types.some((type) => typeof type === 'string' && schemaTypeMatches(value, type))) {
      return { valid: false, path, reason: 'value does not match schema type' };
    }
  }
  if (hasOwn(schema, 'const') && !deepEqualJson(value, schema.const as JsonValue, context.budget)) {
    if (context.budget.exhausted) {
      return budgetFailure(path);
    }
    return { valid: false, path, reason: 'value does not match const' };
  }
  if (hasOwn(schema, 'enum') && Array.isArray(schema.enum)) {
    let matched = false;
    for (const entry of schema.enum) {
      if (deepEqualJson(value, entry as JsonValue, context.budget)) {
        matched = true;
        break;
      }
      if (context.budget.exhausted) {
        return budgetFailure(path);
      }
    }
    if (!matched) {
      return { valid: false, path, reason: 'value is not in enum' };
    }
  }

  if (typeof value === 'number') {
    if (hasOwn(schema, 'multipleOf') && isFiniteNumber(schema.multipleOf)) {
      const quotient = value / schema.multipleOf;
      if (Math.abs(quotient - Math.round(quotient)) > 1e-12) {
        return { valid: false, path, reason: 'number is not a multipleOf value' };
      }
    }
    if (hasOwn(schema, 'minimum') && isFiniteNumber(schema.minimum) && value < schema.minimum) {
      return { valid: false, path, reason: 'number is below minimum' };
    }
    if (hasOwn(schema, 'maximum') && isFiniteNumber(schema.maximum) && value > schema.maximum) {
      return { valid: false, path, reason: 'number is above maximum' };
    }
    if (
      hasOwn(schema, 'exclusiveMinimum') &&
      isFiniteNumber(schema.exclusiveMinimum) &&
      value <= schema.exclusiveMinimum
    ) {
      return { valid: false, path, reason: 'number is not above exclusiveMinimum' };
    }
    if (
      hasOwn(schema, 'exclusiveMaximum') &&
      isFiniteNumber(schema.exclusiveMaximum) &&
      value >= schema.exclusiveMaximum
    ) {
      return { valid: false, path, reason: 'number is not below exclusiveMaximum' };
    }
  }

  if (typeof value === 'string') {
    const length = Array.from(value).length;
    if (
      hasOwn(schema, 'minLength') &&
      isNonNegativeInteger(schema.minLength) &&
      length < schema.minLength
    ) {
      return { valid: false, path, reason: 'string is shorter than minLength' };
    }
    if (
      hasOwn(schema, 'maxLength') &&
      isNonNegativeInteger(schema.maxLength) &&
      length > schema.maxLength
    ) {
      return { valid: false, path, reason: 'string is longer than maxLength' };
    }
    if (hasOwn(schema, 'pattern') && typeof schema.pattern === 'string') {
      const patternResult = testSchemaRegex(context, schema.pattern, value);
      if (patternResult.exhausted) {
        return budgetFailure(path);
      }
      if (!patternResult.matched) {
        return { valid: false, path, reason: 'string does not match pattern' };
      }
    }
    // `format` is deliberately annotation-only in the default v1 contract.
  }

  if (Array.isArray(value)) {
    if (
      hasOwn(schema, 'minItems') &&
      isNonNegativeInteger(schema.minItems) &&
      value.length < schema.minItems
    ) {
      return { valid: false, path, reason: 'array is shorter than minItems' };
    }
    if (
      hasOwn(schema, 'maxItems') &&
      isNonNegativeInteger(schema.maxItems) &&
      value.length > schema.maxItems
    ) {
      return { valid: false, path, reason: 'array is longer than maxItems' };
    }
    if (hasOwn(schema, 'uniqueItems') && schema.uniqueItems === true) {
      const itemSignatures = new Set<string>();
      for (const item of value) {
        if (!consumeEvaluationBudget(context.budget)) {
          return budgetFailure(path);
        }
        let signature: string;
        try {
          signature = canonicalizeJsonWithinBudget(item, context.budget);
        } catch {
          if (context.budget.exhausted) {
            return budgetFailure(path);
          }
          return { valid: false, path, reason: 'array items are not valid JSON' };
        }
        if (itemSignatures.has(signature)) {
          return { valid: false, path, reason: 'array items are not unique' };
        }
        itemSignatures.add(signature);
      }
    }
    if (hasOwn(schema, 'prefixItems') && Array.isArray(schema.prefixItems)) {
      for (let index = 0; index < schema.prefixItems.length && index < value.length; index += 1) {
        const childResult = matchesSchema(
          value[index],
          schema.prefixItems[index],
          context,
          `${path}[${index}]`,
          depth + 1,
          new Map(activeRefs),
        );
        if (!childResult.valid) {
          return childResult;
        }
      }
    }
    const prefixLength =
      hasOwn(schema, 'prefixItems') && Array.isArray(schema.prefixItems)
        ? schema.prefixItems.length
        : 0;
    if (hasOwn(schema, 'items')) {
      for (let index = prefixLength; index < value.length; index += 1) {
        const childResult = matchesSchema(
          value[index],
          schema.items as JsonSchema,
          context,
          `${path}[${index}]`,
          depth + 1,
          new Map(activeRefs),
        );
        if (!childResult.valid) {
          return childResult;
        }
      }
    }
    if (hasOwn(schema, 'contains')) {
      let matching = 0;
      for (let index = 0; index < value.length; index += 1) {
        const childResult = matchesSchema(
          value[index],
          schema.contains as JsonSchema,
          context,
          `${path}[${index}]`,
          depth + 1,
          new Map(activeRefs),
        );
        if (childResult.valid) {
          matching += 1;
        }
        if (context.budget.exhausted) {
          return budgetFailure(path);
        }
      }
      const minimum =
        hasOwn(schema, 'minContains') && isNonNegativeInteger(schema.minContains)
          ? schema.minContains
          : 1;
      const maximum =
        hasOwn(schema, 'maxContains') && isNonNegativeInteger(schema.maxContains)
          ? schema.maxContains
          : Number.POSITIVE_INFINITY;
      if (matching < minimum || matching > maximum) {
        return { valid: false, path, reason: 'array does not satisfy contains' };
      }
    }
  }

  if (isPlainObject(value)) {
    if (
      hasOwn(schema, 'minProperties') &&
      isNonNegativeInteger(schema.minProperties) &&
      Object.keys(value).length < schema.minProperties
    ) {
      return { valid: false, path, reason: 'object has fewer than minProperties' };
    }
    if (
      hasOwn(schema, 'maxProperties') &&
      isNonNegativeInteger(schema.maxProperties) &&
      Object.keys(value).length > schema.maxProperties
    ) {
      return { valid: false, path, reason: 'object has more than maxProperties' };
    }
    if (hasOwn(schema, 'required') && Array.isArray(schema.required)) {
      for (const required of schema.required) {
        if (typeof required === 'string' && !hasOwn(value, required)) {
          return {
            valid: false,
            path: `${path}.${required}`,
            reason: 'required property is missing',
          };
        }
      }
    }
    if (hasOwn(schema, 'properties') && isPlainObject(schema.properties)) {
      for (const [property, childSchema] of Object.entries(schema.properties)) {
        if (hasOwn(value, property)) {
          const childResult = matchesSchema(
            value[property] as JsonValue,
            childSchema as JsonSchema,
            context,
            `${path}.${property}`,
            depth + 1,
            new Map(activeRefs),
          );
          if (!childResult.valid) {
            return childResult;
          }
        }
      }
    }
    if (hasOwn(schema, 'patternProperties') && isPlainObject(schema.patternProperties)) {
      for (const [pattern, childSchema] of Object.entries(schema.patternProperties)) {
        for (const property of Object.keys(value)) {
          const patternResult = testSchemaRegex(context, pattern, property);
          if (patternResult.exhausted) {
            return budgetFailure(path);
          }
          if (patternResult.matched) {
            const childResult = matchesSchema(
              value[property] as JsonValue,
              childSchema as JsonSchema,
              context,
              `${path}.${property}`,
              depth + 1,
              new Map(activeRefs),
            );
            if (!childResult.valid) {
              return childResult;
            }
          }
        }
      }
    }
    if (hasOwn(schema, 'additionalProperties')) {
      const known = new Set<string>(
        hasOwn(schema, 'properties') && isPlainObject(schema.properties)
          ? Object.keys(schema.properties)
          : [],
      );
      for (const property of Object.keys(value)) {
        if (known.has(property)) {
          continue;
        }
        let matchedPattern = false;
        if (hasOwn(schema, 'patternProperties') && isPlainObject(schema.patternProperties)) {
          for (const pattern of Object.keys(schema.patternProperties)) {
            const patternResult = testSchemaRegex(context, pattern, property);
            if (patternResult.exhausted) {
              return budgetFailure(path);
            }
            if (patternResult.matched) {
              matchedPattern = true;
              break;
            }
          }
        }
        if (matchedPattern) {
          continue;
        }
        if (schema.additionalProperties === false) {
          return {
            valid: false,
            path: `${path}.${property}`,
            reason: 'additional property is not allowed',
          };
        }
        const childResult = matchesSchema(
          value[property] as JsonValue,
          schema.additionalProperties as JsonSchema,
          context,
          `${path}.${property}`,
          depth + 1,
          new Map(activeRefs),
        );
        if (!childResult.valid) {
          return childResult;
        }
      }
    }
    if (hasOwn(schema, 'dependentRequired') && isPlainObject(schema.dependentRequired)) {
      for (const [property, dependencies] of Object.entries(schema.dependentRequired)) {
        if (hasOwn(value, property) && Array.isArray(dependencies)) {
          for (const dependency of dependencies) {
            if (typeof dependency === 'string' && !hasOwn(value, dependency)) {
              return {
                valid: false,
                path: `${path}.${dependency}`,
                reason: 'dependent property is missing',
              };
            }
          }
        }
      }
    }
    if (hasOwn(schema, 'dependentSchemas') && isPlainObject(schema.dependentSchemas)) {
      for (const [property, dependentSchema] of Object.entries(schema.dependentSchemas)) {
        if (hasOwn(value, property)) {
          const dependentResult = matchesSchema(
            value,
            dependentSchema as JsonSchema,
            context,
            path,
            depth + 1,
            new Map(activeRefs),
          );
          if (!dependentResult.valid) {
            return dependentResult;
          }
        }
      }
    }
    if (hasOwn(schema, 'propertyNames')) {
      for (const property of Object.keys(value)) {
        const propertyResult = matchesSchema(
          property,
          schema.propertyNames as JsonSchema,
          context,
          `${path}.${property}`,
          depth + 1,
          new Map(activeRefs),
        );
        if (!propertyResult.valid) {
          return propertyResult;
        }
      }
    }
  }

  if (hasOwn(schema, 'allOf') && Array.isArray(schema.allOf)) {
    for (const childSchema of schema.allOf) {
      const childResult = matchesSchema(
        value,
        childSchema as JsonSchema,
        context,
        path,
        depth + 1,
        new Map(activeRefs),
      );
      if (!childResult.valid) {
        return childResult;
      }
    }
  }
  if (hasOwn(schema, 'anyOf') && Array.isArray(schema.anyOf)) {
    let matched = false;
    for (const childSchema of schema.anyOf) {
      const childResult = matchesSchema(
        value,
        childSchema as JsonSchema,
        context,
        path,
        depth + 1,
        new Map(activeRefs),
      );
      if (childResult.valid) {
        matched = true;
        break;
      }
      if (context.budget.exhausted) {
        return budgetFailure(path);
      }
    }
    if (!matched) {
      return { valid: false, path, reason: 'value does not match anyOf' };
    }
  }
  if (hasOwn(schema, 'oneOf') && Array.isArray(schema.oneOf)) {
    let matches = 0;
    for (const childSchema of schema.oneOf) {
      const childResult = matchesSchema(
        value,
        childSchema as JsonSchema,
        context,
        path,
        depth + 1,
        new Map(activeRefs),
      );
      if (childResult.valid) {
        matches += 1;
      }
      if (context.budget.exhausted) {
        return budgetFailure(path);
      }
    }
    if (matches !== 1) {
      return { valid: false, path, reason: 'value does not match exactly one oneOf schema' };
    }
  }
  if (hasOwn(schema, 'not')) {
    const notResult = matchesSchema(
      value,
      schema.not as JsonSchema,
      context,
      path,
      depth + 1,
      new Map(activeRefs),
    );
    if (context.budget.exhausted) {
      return budgetFailure(path);
    }
    if (notResult.valid) {
      return { valid: false, path, reason: 'value matches a disallowed not schema' };
    }
  }
  if (hasOwn(schema, 'if')) {
    const conditionResult = matchesSchema(
      value,
      schema.if as JsonSchema,
      context,
      path,
      depth + 1,
      new Map(activeRefs),
    );
    if (context.budget.exhausted) {
      return budgetFailure(path);
    }
    const conditionalSchema = conditionResult.valid
      ? hasOwn(schema, 'then')
        ? schema.then
        : undefined
      : hasOwn(schema, 'else')
        ? schema.else
        : undefined;
    if (conditionalSchema !== undefined) {
      const conditionalResult = matchesSchema(
        value,
        conditionalSchema as JsonSchema,
        context,
        path,
        depth + 1,
        new Map(activeRefs),
      );
      if (!conditionalResult.valid) {
        return conditionalResult;
      }
    }
  }

  return { valid: true };
}

/** Validate a JSON value against a local Draft 2020-12 schema. */
export function validateJsonValueAgainstSchema(
  value: unknown,
  schema: unknown,
  options: ValidationOptions = {},
): ValidationResult<JsonValue> {
  const schemaResult = validateJsonSchema(schema, options);
  if (!schemaResult.ok) {
    return schemaResult as ValidationResult<JsonValue>;
  }
  const valueIssue = validateJsonValueInternal(value, '$', options);
  if (valueIssue !== undefined) {
    const code: ValidationErrorCode =
      valueIssue.code === 'oversized' ? 'oversized' : 'invalid_content';
    return validationFailure(
      code,
      code === 'oversized'
        ? 'JSON response content exceeds a configured limit'
        : 'JSON response content is invalid',
      valueIssue.path,
      valueIssue.reason,
    );
  }
  const limits = resolveLimits(options);
  const compiled = compileDraft2020Schema(schemaResult.value);
  if (compiled === undefined || !compiled(value)) {
    return validationFailure(
      'invalid_content',
      'JSON response content does not satisfy its schema',
      '$',
      'schema validation failed',
    );
  }
  const index = collectSchemaIndex(schemaResult.value);
  const context: SchemaContext = {
    ...index,
    maxDepth: limits.maxDepth,
    budget: createEvaluationBudget(limits.maxNodes),
    regexCache: new Map<string, RegExp>(),
  };
  const match = matchesSchema(
    value as JsonValue,
    schemaResult.value,
    context,
    '$',
    0,
    new Map<string, number>(),
  );
  if (!match.valid) {
    return validationFailure(
      'invalid_content',
      'JSON response content does not satisfy its schema',
      match.path ?? '$',
      match.reason ?? 'schema validation failed',
    );
  }
  return success(value as JsonValue);
}

export const validateJsonSchemaValue = validateJsonValueAgainstSchema;
export const validateAgainstSchema = validateJsonValueAgainstSchema;
export const validateContentAgainstSchema = validateJsonValueAgainstSchema;

/** Boolean convenience form for schema checks. */
export function matchesJsonSchema(
  value: unknown,
  schema: unknown,
  options: ValidationOptions = {},
): boolean {
  return validateJsonValueAgainstSchema(value, schema, options).ok;
}

/**
 * Project only immutable wire fields. Binding credentials are transport
 * metadata and are not envelope fields; application payload/content/metadata is
 * retained verbatim, including credential-looking names such as `token`.
 */
function fingerprintData(envelope: ProtocolEnvelope): UnknownRecord {
  const candidate = envelope as unknown as UnknownRecord;
  const data: UnknownRecord = Object.create(null) as UnknownRecord;
  for (const key of [
    'protocolVersion',
    'operation',
    'operationId',
    'requestId',
    'sender',
    'recipientRuntimeId',
    'roomId',
    'createdAt',
    'expiresAt',
    'traceId',
    'parentOperationId',
    'payload',
  ]) {
    if (!hasOwn(candidate, key)) {
      continue;
    }
    if (key === 'sender') {
      const sender = candidate.sender as UnknownRecord;
      const senderProjection: UnknownRecord = Object.create(null) as UnknownRecord;
      if (hasOwn(sender, 'sessionId')) {
        senderProjection.sessionId = sender.sessionId;
      }
      if (hasOwn(sender, 'runtimeId')) {
        senderProjection.runtimeId = sender.runtimeId;
      }
      data.sender = senderProjection;
    } else {
      data[key] = candidate[key];
    }
  }
  return data;
}

function canonicalizeValue(value: unknown, seen: Set<object>, budget?: EvaluationBudget): string {
  if (budget !== undefined && !consumeEvaluationBudget(budget)) {
    throw new TypeError('canonical JSON evaluation budget exceeded');
  }
  if (value === null) {
    return 'null';
  }
  if (typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'boolean') {
    return value ? 'true' : 'false';
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError('canonical JSON numbers must be finite');
    }
    const serialized = JSON.stringify(value);
    if (serialized === undefined) {
      throw new TypeError('value is not canonical JSON');
    }
    return serialized;
  }
  if (typeof value !== 'object' || value === null) {
    throw new TypeError('value is not canonical JSON');
  }
  if (seen.has(value)) {
    throw new TypeError('cyclic canonical JSON values are not permitted');
  }
  seen.add(value);

  let result: string;
  if (Array.isArray(value)) {
    result = `[${value.map((entry) => canonicalizeValue(entry, seen, budget)).join(',')}]`;
  } else if (isPlainObject(value)) {
    if (Object.getOwnPropertySymbols(value).length > 0) {
      seen.delete(value);
      throw new TypeError('symbol properties are not canonical JSON');
    }
    const members = Object.keys(value)
      .sort()
      .map(
        (key) =>
          `${canonicalizeValue(key, seen, budget)}:${canonicalizeValue(value[key], seen, budget)}`,
      );
    result = `{${members.join(',')}}`;
  } else {
    seen.delete(value);
    throw new TypeError('objects must be plain canonical JSON objects');
  }

  seen.delete(value);
  return result;
}

/** RFC 8785-style deterministic JSON serialization for protocol values. */
export function canonicalizeJson(value: unknown): string {
  return canonicalizeValue(value, new Set<object>());
}

function canonicalizeJsonWithinBudget(value: unknown, budget: EvaluationBudget): string {
  return canonicalizeValue(value, new Set<object>(), budget);
}

export const canonicalizeJSON = canonicalizeJson;
export const canonicalJson = canonicalizeJson;

export interface CanonicalRequestProjection {
  readonly envelope: ProtocolEnvelope;
  readonly canonical: string;
  readonly fingerprint: string;
}

/** Validate once, then derive the sole canonical request projection/fingerprint. */
export function validatedRequestProjection(
  value: unknown,
  options: ValidationOptions = {},
): ValidationResult<CanonicalRequestProjection> {
  const envelopeResult = validateEnvelope(value, options);
  if (!envelopeResult.ok) {
    return envelopeResult as ValidationFailure;
  }
  try {
    const canonical = canonicalizeJson(fingerprintData(envelopeResult.value));
    const fingerprint = createHash('sha256').update(canonical, 'utf8').digest('hex');
    return success({ envelope: envelopeResult.value, canonical, fingerprint });
  } catch (error) {
    return validationFailure(
      'malformed',
      'request fingerprint cannot be computed',
      '$',
      error instanceof Error ? error.message : 'canonical JSON failure',
    );
  }
}

export const validateAndFingerprintRequest = validatedRequestProjection;
export const validateCanonicalRequest = validatedRequestProjection;

/** Return the canonical immutable operation data used by request fingerprinting. */
export function canonicalRequestData(value: unknown, options: ValidationOptions = {}): string {
  const projection = validatedRequestProjection(value, options);
  if (!projection.ok) {
    throw new ProtocolValidationError(projection.error);
  }
  return projection.value.canonical;
}

/** Hash immutable operation data with SHA-256, excluding binding credentials. */
export function canonicalRequestFingerprint(
  value: unknown,
  options: ValidationOptions = {},
): string {
  const projection = validatedRequestProjection(value, options);
  if (!projection.ok) {
    throw new ProtocolValidationError(projection.error);
  }
  return projection.value.fingerprint;
}

export const requestFingerprint = canonicalRequestFingerprint;
export const fingerprintRequest = canonicalRequestFingerprint;
export const computeRequestFingerprint = canonicalRequestFingerprint;

/** Result form of fingerprinting for callers that do not want exceptions. */
export function tryRequestFingerprint(
  value: unknown,
  options: ValidationOptions = {},
): ValidationResult<string> {
  const projection = validatedRequestProjection(value, options);
  return projection.ok ? success(projection.value.fingerprint) : (projection as ValidationFailure);
}

export class ProtocolValidationError extends TypeError {
  readonly code: ProtocolErrorCode;
  readonly details: JsonObject | undefined;
  readonly protocolError: ProtocolError;

  constructor(error: ProtocolError) {
    super(error.message);
    this.name = 'ProtocolValidationError';
    this.code = error.code;
    this.details = error.details;
    this.protocolError = error;
  }
}

/** Throwing convenience form for code that has already chosen an exception boundary. */
export function assertValidEnvelope(
  value: unknown,
  options: ValidationOptions = {},
): ProtocolEnvelope {
  const result = validateEnvelope(value, options);
  if (!result.ok) {
    throw new ProtocolValidationError(result.error);
  }
  return result.value;
}

export const validateEnvelopeOrThrow = assertValidEnvelope;

/** Validate a reply's typed JSON content against stored expected-response metadata. */
export function validateReplyContent(
  content: unknown,
  expectedResponse: unknown,
  options: ValidationOptions = {},
): ValidationResult<Content> {
  const contentResult = validateContent(content, options);
  if (!contentResult.ok) {
    return contentResult;
  }
  const expectedResult = validateExpectedResponse(expectedResponse, options);
  if (!expectedResult.ok) {
    return expectedResult as ValidationResult<Content>;
  }
  if (contentResult.value.type !== 'json') {
    return validationFailure(
      'invalid_reply',
      'reply content must be JSON',
      '$',
      'expected response requires JSON content',
    );
  }
  const valueResult = validateJsonValueAgainstSchema(
    contentResult.value.value,
    expectedResult.value.schema,
    options,
  );
  if (!valueResult.ok) {
    if (valueResult.error.code === 'oversized') {
      return valueResult as ValidationResult<Content>;
    }
    return {
      ok: false,
      error: createProtocolError(
        'invalid_reply',
        'reply content does not satisfy the expected schema',
        {
          details: valueResult.error.details,
        },
      ),
    };
  }
  return success(contentResult.value);
}

export const validateResponseContent = validateReplyContent;
export const validateReplyAgainstExpectedResponse = validateReplyContent;

/** Validate a candidate envelope and return only its structured protocol error. */
export function validationError(
  value: unknown,
  options: ValidationOptions = {},
): ProtocolError | undefined {
  const result = validateEnvelope(value, options);
  return result.ok ? undefined : result.error;
}

/** Predicate helper for result-oriented callers. */
export function isValidationSuccess<Value>(
  result: ValidationResult<Value>,
): result is ValidationSuccess<Value> {
  return result.ok;
}

export function isValidationFailure<Value>(
  result: ValidationResult<Value>,
): result is ValidationFailure {
  return !result.ok;
}

// Keep this import-visible alias for consumers that use the transport-neutral name.
export type ProtocolResponse = ProtocolOperationResponse;
