import type { JsonObject } from './messages.js';

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

export interface ProtocolError extends RetryMetadata {
  readonly code: ProtocolErrorCode;
  readonly message: string;
  readonly retryable: boolean;
  /** Safe, structured diagnostic data; credentials and secrets are excluded. */
  readonly details?: JsonObject;
}

export type ProtocolErrorPayload = ProtocolError;
export type OperationError = ProtocolError;

export function isRetryableErrorCode(code: ProtocolErrorCode): code is RetryableErrorCode {
  return RETRYABLE_ERROR_CODES.some((candidate) => candidate === code);
}

export const isRetryableCode = isRetryableErrorCode;

export interface ProtocolErrorOptions extends RetryMetadata {
  readonly details?: JsonObject;
  readonly retryable?: boolean;
}

/**
 * Create a stable error payload with the v1 default retry classification.
 * Callers may override retryability only for a binding-specific condition.
 */
export function createProtocolError(
  code: ProtocolErrorCode,
  message: string,
  options: ProtocolErrorOptions = {},
): ProtocolError {
  const retryable = options.retryable ?? isRetryableErrorCode(code);
  return {
    code,
    message,
    retryable,
    ...(options.retryAfterMs === undefined ? {} : { retryAfterMs: options.retryAfterMs }),
    ...(options.details === undefined ? {} : { details: options.details }),
  };
}
