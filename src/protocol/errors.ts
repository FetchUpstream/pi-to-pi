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
    message,
    retryable,
    ...(options.retryAfterMs === undefined ? {} : { retryAfterMs: options.retryAfterMs }),
    ...(options.details === undefined ? {} : { details: options.details }),
  } as ProtocolErrorForCode<Code>;
}
