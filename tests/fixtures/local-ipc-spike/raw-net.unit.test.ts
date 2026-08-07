import { describe, expect, it } from 'vitest';

import { AbortError, MAX_TIMER_DELAY_MS, PhaseDeadlineExceededError } from './test-helpers.js';
import {
  DEFAULT_RAW_NET_READ_TIMEOUT_MS,
  DEFAULT_RAW_NET_WRITE_TIMEOUT_MS,
  RawNetError,
  RawNetTransport,
  validateUtf8JsonPayload,
} from './raw-net.js';

describe('raw node:net candidate unit boundaries', () => {
  it('keeps the default transport payload path opaque while exposing JSON validation for the spike', () => {
    const transport = new RawNetTransport();
    expect(transport.maxPayloadBytes).toBeGreaterThan(0);
    expect(() => validateUtf8JsonPayload(Buffer.from('{"ok":true}'))).not.toThrow();
    expect(() => validateUtf8JsonPayload(Buffer.from([0xff]))).toThrowError(
      expect.objectContaining<Partial<RawNetError>>({
        code: 'malformed-payload',
      }),
    );
    expect(() => validateUtf8JsonPayload(Buffer.from('{not-json}'))).toThrowError(
      expect.objectContaining<Partial<RawNetError>>({
        code: 'malformed-payload',
      }),
    );
  });

  it('normalizes finite phase defaults and rejects invalid bounds before binding', () => {
    const transport = new RawNetTransport();
    expect(DEFAULT_RAW_NET_READ_TIMEOUT_MS).toBeGreaterThan(0);
    expect(DEFAULT_RAW_NET_WRITE_TIMEOUT_MS).toBeGreaterThan(0);
    expect(() => new RawNetTransport({ maxPayloadBytes: -1 })).toThrow();
    expect(() => new RawNetTransport({ readTimeoutMs: Number.POSITIVE_INFINITY })).toThrow();
    expect(() => new RawNetTransport({ writeTimeoutMs: Number.NaN })).toThrow();
    for (const option of [
      'connectTimeoutMs',
      'writeTimeoutMs',
      'readTimeoutMs',
      'shutdownTimeoutMs',
      'staleProbeTimeoutMs',
    ] as const) {
      expect(() => new RawNetTransport({ [option]: MAX_TIMER_DELAY_MS + 1 })).toThrow(
        /no greater than/,
      );
    }
    void transport.close();
  });

  it('exports stable cancellation and deadline error types used by request callers', () => {
    const abort = new AbortError('cancelled');
    const deadline = new PhaseDeadlineExceededError('read', Date.now());

    expect(abort).toMatchObject({ name: 'AbortError', code: 'ABORT_ERR' });
    expect(deadline).toMatchObject({
      name: 'PhaseDeadlineExceededError',
      code: 'ERR_PHASE_DEADLINE_EXCEEDED',
      phase: 'read',
    });
  });
});
