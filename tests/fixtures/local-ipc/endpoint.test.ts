import { describe, expect, it } from 'vitest';

import {
  assertPosixEndpointLength,
  createIpcEndpoint,
  DEFAULT_POSIX_ENDPOINT_MAX_BYTES,
  DEFAULT_POSIX_ENDPOINT_ROOT,
  generateRuntimeId,
  POSIX_ENDPOINT_PREFIX,
  POSIX_ENDPOINT_SUFFIX,
  utf8ByteLength,
  WINDOWS_PIPE_NAMESPACE,
} from './endpoint.js';

describe('local IPC endpoint fixture', () => {
  it.each(['linux', 'darwin'] as const)('generates a short %s socket path', (platform) => {
    const endpoint = createIpcEndpoint({ platform });

    expect(endpoint.startsWith(`${DEFAULT_POSIX_ENDPOINT_ROOT}/`)).toBe(true);
    expect(endpoint).toMatch(
      new RegExp(
        `^${DEFAULT_POSIX_ENDPOINT_ROOT}/p2p-[a-f0-9]{24}${POSIX_ENDPOINT_SUFFIX.replace('.', '\\.')}$`,
      ),
    );
    expect(utf8ByteLength(endpoint)).toBeLessThanOrEqual(DEFAULT_POSIX_ENDPOINT_MAX_BYTES);
    expect(endpoint).not.toContain(process.cwd());
  });

  it('generates a named-pipe namespace value on Windows', () => {
    const endpoint = createIpcEndpoint({ platform: 'win32' });
    const name = endpoint.slice(WINDOWS_PIPE_NAMESPACE.length);

    expect(endpoint.startsWith(WINDOWS_PIPE_NAMESPACE)).toBe(true);
    expect(name).toMatch(/^p2p-[a-f0-9]{24}$/);
    expect(endpoint).not.toContain('/');
  });

  it('generates distinct endpoint values for concurrent runtimes', () => {
    const endpoints = Array.from({ length: 256 }, () => createIpcEndpoint({ platform: 'linux' }));

    expect(new Set(endpoints).size).toBe(endpoints.length);
  });

  it('uses collision-resistant, short runtime identifiers', () => {
    const first = generateRuntimeId();
    const second = generateRuntimeId();

    expect(first).toMatch(/^[a-f0-9]{24}$/);
    expect(first).not.toBe(second);
  });

  it('enforces POSIX endpoint limits by UTF-8 byte length', () => {
    const endpoint = '/tmp/é';
    const byteLength = utf8ByteLength(endpoint);

    expect(byteLength).toBeGreaterThan(endpoint.length);
    expect(assertPosixEndpointLength(endpoint, byteLength)).toBe(byteLength);
    expect(() => assertPosixEndpointLength(endpoint, byteLength - 1)).toThrow(
      /UTF-8 bytes; maximum/,
    );
  });

  it('accepts the exact configured boundary and rejects one byte over it', () => {
    const runtimeId = 'a'.repeat(24);
    const basename = `${POSIX_ENDPOINT_PREFIX}${runtimeId}${POSIX_ENDPOINT_SUFFIX}`;
    const root = `/${'r'.repeat(DEFAULT_POSIX_ENDPOINT_MAX_BYTES - basename.length - 2)}`;

    const endpoint = createIpcEndpoint({ platform: 'linux', posixRoot: root, runtimeId });
    expect(utf8ByteLength(endpoint)).toBe(DEFAULT_POSIX_ENDPOINT_MAX_BYTES);

    expect(() =>
      createIpcEndpoint({
        platform: 'linux',
        posixRoot: `${root}r`,
        runtimeId,
      }),
    ).toThrow(/UTF-8 bytes; maximum/);
  });

  it('rejects an endpoint root that makes the POSIX path too long', () => {
    expect(() =>
      createIpcEndpoint({
        platform: 'linux',
        posixRoot: `/${'深'.repeat(40)}`,
        runtimeId: 'fixture',
      }),
    ).toThrow(/UTF-8 bytes; maximum/);
  });

  it('rejects unsafe runtime identifiers rather than creating path traversal values', () => {
    expect(() =>
      createIpcEndpoint({
        platform: 'linux',
        runtimeId: '../outside-fixture',
      }),
    ).toThrow(/runtime identifier/);
  });
});
