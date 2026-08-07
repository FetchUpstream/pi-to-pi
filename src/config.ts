import type { ProtocolLimits } from './protocol/agent-card.js';

/** v1 protocol defaults and hard maxima, expressed in milliseconds/bytes. */
export const DEFAULT_REQUEST_TTL_MS = 10 * 60 * 1000;
export const MAX_REQUEST_TTL_MS = 60 * 60 * 1000;
export const MAX_CONTROL_TTL_MS = 30 * 1000;
export const MAX_ENVELOPE_BYTES = 1024 * 1024;
export const MAX_SCHEMA_BYTES = 64 * 1024;
export const DEFAULT_QUEUE_LIMIT = 32;

/** Dedupe records remain useful for one additional request-TTL window. */
export const DEDUPE_RETENTION_GRACE_MS = 10 * 60 * 1000;

export type ProtocolConfig = ProtocolLimits;
export type PiToPiConfig = ProtocolConfig;

type ProtocolLimitName = keyof ProtocolLimits;

/**
 * Every effective/advertised limit may be made stricter, but never looser
 * than the v1 ceiling for that limit.
 */
const V1_LIMIT_CEILINGS: Readonly<ProtocolLimits> = Object.freeze({
  requestTtlMs: DEFAULT_REQUEST_TTL_MS,
  maxRequestTtlMs: MAX_REQUEST_TTL_MS,
  maxControlTtlMs: MAX_CONTROL_TTL_MS,
  maxEnvelopeBytes: MAX_ENVELOPE_BYTES,
  maxSchemaBytes: MAX_SCHEMA_BYTES,
  maxQueueEntries: DEFAULT_QUEUE_LIMIT,
});

export const DEFAULT_PROTOCOL_LIMITS: Readonly<ProtocolLimits> = Object.freeze({
  requestTtlMs: DEFAULT_REQUEST_TTL_MS,
  maxRequestTtlMs: MAX_REQUEST_TTL_MS,
  maxControlTtlMs: MAX_CONTROL_TTL_MS,
  maxEnvelopeBytes: MAX_ENVELOPE_BYTES,
  maxSchemaBytes: MAX_SCHEMA_BYTES,
  maxQueueEntries: DEFAULT_QUEUE_LIMIT,
});

export const DEFAULT_PROTOCOL_CONFIG: Readonly<ProtocolConfig> = DEFAULT_PROTOCOL_LIMITS;
export const DEFAULT_CONFIG: Readonly<ProtocolConfig> = DEFAULT_PROTOCOL_CONFIG;

function validateProtocolConfig(config: ProtocolConfig): ProtocolConfig {
  const limitNames = Object.keys(V1_LIMIT_CEILINGS) as ProtocolLimitName[];

  for (const name of limitNames) {
    const value = config[name];
    const ceiling = V1_LIMIT_CEILINGS[name];

    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new RangeError(`${name} must be a positive safe integer`);
    }

    if (value > ceiling) {
      throw new RangeError(`${name} must not exceed the v1 ceiling of ${ceiling}`);
    }
  }

  if (config.requestTtlMs > config.maxRequestTtlMs) {
    throw new RangeError('requestTtlMs must not exceed maxRequestTtlMs');
  }

  return config;
}

/**
 * Merge runtime configuration while retaining every v1 default. Overrides
 * can only tighten the advertised/effective ceilings and invalid combinations
 * are rejected instead of being silently normalized.
 */
export function createProtocolConfig(overrides: Partial<ProtocolConfig> = {}): ProtocolConfig {
  const config = { ...DEFAULT_PROTOCOL_LIMITS, ...overrides };
  return validateProtocolConfig(config);
}

export const resolveProtocolLimits = createProtocolConfig;
