import { describe, expect, it } from 'vitest';

import {
  DEFAULT_POSIX_ENDPOINT_MAX_BYTES,
  DEFAULT_POSIX_ENDPOINT_ROOT,
  POSIX_ENDPOINT_PREFIX,
  POSIX_ENDPOINT_SUFFIX,
  WINDOWS_PIPE_NAMESPACE,
  assertIpcEndpoint,
  assertPosixEndpointLength,
  createIpcEndpoint,
  generateRuntimeId,
  utf8ByteLength,
} from '../../src/transport/endpoint.js';

describe('production local IPC endpoints', () => {
  it.each(['linux', 'darwin'] as const)('generates a short %s endpoint', (platform) => {
    const endpoint = createIpcEndpoint({ platform });

    expect(endpoint.startsWith(`${DEFAULT_POSIX_ENDPOINT_ROOT}/`)).toBe(true);
    expect(endpoint).toMatch(
      new RegExp(
        `^${DEFAULT_POSIX_ENDPOINT_ROOT}/p2p-[a-f0-9]{24}${POSIX_ENDPOINT_SUFFIX.replace('.', '\\.')}$`,
      ),
    );
    expect(utf8ByteLength(endpoint)).toBeLessThanOrEqual(DEFAULT_POSIX_ENDPOINT_MAX_BYTES);
  });

  it('uses an opaque named-pipe namespace on Windows', () => {
    const endpoint = createIpcEndpoint({ platform: 'win32' });
    expect(endpoint.startsWith(WINDOWS_PIPE_NAMESPACE)).toBe(true);
    expect(endpoint).not.toContain('/');
    expect(assertIpcEndpoint(endpoint, { platform: 'win32' })).toBe(endpoint);
  });

  it('generates distinct short runtime identifiers concurrently', () => {
    const ids = Array.from({ length: 256 }, () => generateRuntimeId());
    const endpoints = ids.map((runtimeId) => createIpcEndpoint({ platform: 'linux', runtimeId }));

    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(endpoints).size).toBe(endpoints.length);
    expect(ids.every((id) => /^[a-f0-9]{24}$/u.test(id))).toBe(true);
  });

  it('uses UTF-8 byte length at the exact POSIX boundary', () => {
    const endpoint = '/tmp/é';
    const byteLength = utf8ByteLength(endpoint);

    expect(byteLength).toBeGreaterThan(endpoint.length);
    expect(assertPosixEndpointLength(endpoint, byteLength)).toBe(byteLength);
    expect(() => assertPosixEndpointLength(endpoint, byteLength - 1)).toThrow(
      /UTF-8 bytes; maximum/,
    );

    const runtimeId = 'a'.repeat(24);
    const basename = `${POSIX_ENDPOINT_PREFIX}${runtimeId}${POSIX_ENDPOINT_SUFFIX}`;
    const root = `/${'r'.repeat(DEFAULT_POSIX_ENDPOINT_MAX_BYTES - basename.length - 2)}`;
    const exact = createIpcEndpoint({ platform: 'linux', posixRoot: root, runtimeId });
    expect(utf8ByteLength(exact)).toBe(DEFAULT_POSIX_ENDPOINT_MAX_BYTES);
    expect(() =>
      createIpcEndpoint({ platform: 'linux', posixRoot: `${root}r`, runtimeId }),
    ).toThrow(/UTF-8 bytes; maximum/);
  });

  it('does not accept unsafe identifiers or overlong generated roots', () => {
    expect(() =>
      createIpcEndpoint({ platform: 'linux', runtimeId: '../outside-working-directory' }),
    ).toThrow(/runtime identifier/);
    expect(() =>
      createIpcEndpoint({
        platform: 'linux',
        posixRoot: `/${'深'.repeat(40)}`,
        runtimeId: 'fixture',
      }),
    ).toThrow(/UTF-8 bytes/);
  });
});
