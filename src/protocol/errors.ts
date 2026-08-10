import type { JsonObject, JsonValue } from './messages.js';

/** Stable operation error codes in the v1 wire taxonomy. */
export const PROTOCOL_ERROR_CODES = [
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
] as const;

export type ProtocolErrorCode = (typeof PROTOCOL_ERROR_CODES)[number];
export type ErrorCode = ProtocolErrorCode;

export const RETRYABLE_ERROR_CODES = ['busy', 'unreachable'] as const;
export type RetryableErrorCode = (typeof RETRYABLE_ERROR_CODES)[number];
export type NonRetryableErrorCode = Exclude<ProtocolErrorCode, RetryableErrorCode>;

export interface RetryMetadata {
  /** Suggested delay before a retry, in milliseconds. */
  readonly retryAfterMs?: number;
}

interface ProtocolErrorCommon {
  readonly message: string;
  /** Safe, structured diagnostic data; credentials and secrets are excluded. */
  readonly details?: JsonObject;
}

/** A retryable error can only use one of the v1 transient error codes. */
export type RetryableProtocolError = ProtocolErrorCommon &
  RetryMetadata & {
    readonly code: RetryableErrorCode;
    readonly retryable: true;
  };

/** Permanent errors cannot advertise retryability or a retry delay. */
export type NonRetryableProtocolError = ProtocolErrorCommon & {
  readonly code: NonRetryableErrorCode;
  readonly retryable: false;
};

export type ProtocolError = RetryableProtocolError | NonRetryableProtocolError;
export type ProtocolErrorPayload = ProtocolError;
export type OperationError = ProtocolError;

export function isRetryableErrorCode(code: ProtocolErrorCode): code is RetryableErrorCode {
  return RETRYABLE_ERROR_CODES.some((candidate) => candidate === code);
}

export const isRetryableCode = isRetryableErrorCode;

/** Maximum wire-safe error message length. */
export const MAX_PROTOCOL_ERROR_MESSAGE_LENGTH = 512;
/** Maximum encoded size retained for optional safe error details. */
export const MAX_PROTOCOL_ERROR_DETAILS_BYTES = 4 * 1024;

const SECRET_DETAIL_KEY = /(?:credential|password|secret|token|api.?key|authorization)/iu;

function boundedMessage(value: string): string {
  let normalized = '';
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    normalized +=
      codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f) ? ' ' : character;
  }
  normalized = normalized.trim();
  const safe = normalized.length === 0 ? 'protocol error' : normalized;
  return safe.length <= MAX_PROTOCOL_ERROR_MESSAGE_LENGTH
    ? safe
    : `${safe.slice(0, MAX_PROTOCOL_ERROR_MESSAGE_LENGTH - 1)}…`;
}

function sanitizeJsonValue(value: unknown, depth: number): JsonValue | undefined {
  if (depth > 8 || value === undefined) {
    return undefined;
  }
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (Array.isArray(value)) {
    const result: JsonValue[] = [];
    for (const item of value.slice(0, 64)) {
      const safe = sanitizeJsonValue(item, depth + 1);
      if (safe !== undefined) {
        result.push(safe);
      }
    }
    return result;
  }
  if (typeof value !== 'object') {
    return undefined;
  }

  const result: Record<string, JsonValue> = {};
  for (const [key, item] of Object.entries(value).slice(0, 64)) {
    if (SECRET_DETAIL_KEY.test(key)) {
      continue;
    }
    const safe = sanitizeJsonValue(item, depth + 1);
    if (safe !== undefined) {
      result[key] = safe;
    }
  }
  return result;
}

function boundedDetails(details: JsonObject | undefined): JsonObject | undefined {
  if (details === undefined) {
    return undefined;
  }
  const safe = sanitizeJsonValue(details, 0);
  if (safe === undefined || safe === null || Array.isArray(safe) || typeof safe !== 'object') {
    return { truncated: true };
  }
  try {
    if (Buffer.byteLength(JSON.stringify(safe), 'utf8') <= MAX_PROTOCOL_ERROR_DETAILS_BYTES) {
      return safe as JsonObject;
    }
  } catch {
    // Fall through to the bounded marker.
  }
  return { truncated: true };
}
export interface ProtocolErrorOptions extends RetryMetadata {
  readonly details?: JsonObject;
  /**
   * Kept for source compatibility, but it must agree with the stable code
   * classification. The returned payload always derives this value from code.
   */
  readonly retryable?: boolean;
}

type ProtocolErrorForCode<Code extends ProtocolErrorCode> = Code extends RetryableErrorCode
  ? RetryableProtocolError
  : NonRetryableProtocolError;

function validateRetryMetadata(
  code: ProtocolErrorCode,
  retryable: boolean,
  retryAfterMs: number | undefined,
): void {
  if (retryAfterMs === undefined) {
    return;
  }

  if (!Number.isFinite(retryAfterMs) || retryAfterMs <= 0) {
    throw new RangeError('retryAfterMs must be a finite positive number');
  }

  if (!retryable) {
    throw new RangeError(`retryAfterMs is not valid for non-retryable error code ${code}`);
  }
}

/**
 * Create a stable error payload with retryability derived from the v1 code.
 * A caller-supplied classification is accepted only when it agrees with that
 * code, so permanent errors cannot become retryable and transient errors
 * cannot become permanent.
 */
export function createProtocolError<Code extends ProtocolErrorCode>(
  code: Code,
  message: string,
  options: ProtocolErrorOptions = {},
): ProtocolErrorForCode<Code> {
  const retryable = isRetryableErrorCode(code);

  if (options.retryable !== undefined && options.retryable !== retryable) {
    throw new RangeError(`retryable must be ${retryable} for error code ${code}`);
  }

  validateRetryMetadata(code, retryable, options.retryAfterMs);

  return {
    code,
    message: boundedMessage(message),
    retryable,
    ...(options.retryAfterMs === undefined ? {} : { retryAfterMs: options.retryAfterMs }),
    ...(options.details === undefined ? {} : { details: boundedDetails(options.details) }),
  } as ProtocolErrorForCode<Code>;
}
