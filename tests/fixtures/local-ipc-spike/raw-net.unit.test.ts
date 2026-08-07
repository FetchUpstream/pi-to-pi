import { promises as fs } from 'node:fs';
import { createConnection, createServer } from 'node:net';
import type { Server } from 'node:net';

import { describe, expect, it } from 'vitest';

import { AbortError, MAX_TIMER_DELAY_MS, PhaseDeadlineExceededError } from './test-helpers.js';
import {
  DEFAULT_RAW_NET_READ_TIMEOUT_MS,
  DEFAULT_RAW_NET_WRITE_TIMEOUT_MS,
  RawNetError,
  RawNetTransport,
  restoreQuarantinedSocketForTest,
  validateUtf8JsonPayload,
} from './raw-net.js';

async function listenUnitServer(server: Server, endpoint: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off('error', onError);
      reject(error);
    };
    server.once('error', onError);
    server.listen(endpoint, () => {
      server.off('error', onError);
      resolve();
    });
  });
}

async function closeUnitServer(server: Server): Promise<void> {
  if (!server.listening) {
    return;
  }
  await new Promise<void>((resolve, reject) => {
    server.close((error?: Error) => {
      if (error === undefined) {
        resolve();
      } else {
        reject(error);
      }
    });
  });
}

async function assertUnitEndpointConnectable(endpoint: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const socket = createConnection(endpoint);
    socket.once('connect', () => {
      socket.destroy();
      resolve();
    });
    socket.once('error', reject);
  });
}

async function unlinkUnitPath(path: string): Promise<void> {
  try {
    await fs.unlink(path);
  } catch (error: unknown) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return;
    }
    throw error;
  }
}
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
  it('removes a quarantined socket when a replacement owns the endpoint', async () => {
    if (process.platform === 'win32') {
      return;
    }
    const endpoint = `/tmp/raw-net-replacement-${process.pid}-${Date.now()}.sock`;
    const quarantine = `${endpoint}.cleanup-test`;
    const replacement = createServer((socket) => socket.resume());
    const quarantined = createServer((socket) => socket.resume());

    await listenUnitServer(replacement, endpoint);
    await listenUnitServer(quarantined, quarantine);
    try {
      restoreQuarantinedSocketForTest(endpoint, quarantine);
      await expect(fs.lstat(quarantine)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(replacement.listening).toBe(true);
      await expect(assertUnitEndpointConnectable(endpoint)).resolves.toBeUndefined();
    } finally {
      await closeUnitServer(quarantined);
      await closeUnitServer(replacement);
      await unlinkUnitPath(endpoint);
      await unlinkUnitPath(quarantine);
    }
  });
});
