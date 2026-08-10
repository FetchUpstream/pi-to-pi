/** Platform-specific endpoint generation and validation for local IPC. */

import { randomBytes } from 'node:crypto';
import { posix as posixPath } from 'node:path';

export const DEFAULT_POSIX_ENDPOINT_MAX_BYTES = 100;
export const DEFAULT_POSIX_ENDPOINT_ROOT = '/tmp';
export const WINDOWS_PIPE_NAMESPACE = '\\\\?\\pipe\\';
export const WINDOWS_DOT_PIPE_NAMESPACE = '\\\\.\\pipe\\';
export const POSIX_ENDPOINT_PREFIX = 'p2p-';
export const POSIX_ENDPOINT_SUFFIX = '.sock';
export const WINDOWS_ENDPOINT_PREFIX = 'p2p-';

const RUNTIME_ID_BYTES = 12;
const SAFE_RUNTIME_ID = /^[a-z0-9_-]+$/u;
const GENERATED_RUNTIME_ID = /^[a-f0-9]{24}$/u;

type SupportedPlatform = 'linux' | 'darwin' | 'win32';

export interface IpcEndpointOptions {
  readonly platform?: NodeJS.Platform;
  readonly posixRoot?: string;
  readonly runtimeId?: string;
  readonly maxPosixBytes?: number;
}

export interface EndpointValidationOptions {
  readonly platform?: NodeJS.Platform;
  readonly maxPosixBytes?: number;
}

export function generateRuntimeId(): string {
  return randomBytes(RUNTIME_ID_BYTES).toString('hex');
}

export function utf8ByteLength(value: string): number {
  if (typeof value !== 'string') {
    throw new TypeError('POSIX IPC endpoint must be a string');
  }
  return Buffer.byteLength(value, 'utf8');
}

export function assertPosixEndpointLength(
  endpoint: string,
  maxBytes = DEFAULT_POSIX_ENDPOINT_MAX_BYTES,
): number {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new RangeError('POSIX IPC endpoint maximum must be a positive safe integer');
  }

  const byteLength = utf8ByteLength(endpoint);
  if (byteLength > maxBytes) {
    throw new RangeError(`POSIX IPC endpoint is ${byteLength} UTF-8 bytes; maximum is ${maxBytes}`);
  }
  return byteLength;
}

function normalizePlatform(platform: NodeJS.Platform): SupportedPlatform {
  if (platform === 'linux' || platform === 'darwin' || platform === 'win32') {
    return platform;
  }
  throw new Error(`Unsupported local IPC platform: ${platform}`);
}

function validateRuntimeId(runtimeId: string): void {
  if (!SAFE_RUNTIME_ID.test(runtimeId)) {
    throw new TypeError(
      'IPC runtime identifier must contain only lowercase letters, digits, _ or -',
    );
  }
}

export function isWindowsPipeEndpoint(endpoint: string): boolean {
  return (
    endpoint.startsWith(WINDOWS_PIPE_NAMESPACE) || endpoint.startsWith(WINDOWS_DOT_PIPE_NAMESPACE)
  );
}

/** Validate the opaque path value accepted by Node's local IPC APIs. */
export function assertIpcEndpoint(
  endpoint: string,
  options: EndpointValidationOptions = {},
): string {
  if (typeof endpoint !== 'string' || endpoint.length === 0) {
    throw new TypeError('IPC endpoint must be a non-empty string');
  }

  const platform = normalizePlatform(options.platform ?? process.platform);
  if (platform === 'win32') {
    if (!isWindowsPipeEndpoint(endpoint)) {
      throw new TypeError('Windows IPC endpoints must use a named-pipe namespace');
    }
    return endpoint;
  }

  assertPosixEndpointLength(endpoint, options.maxPosixBytes);
  return endpoint;
}

/** Generate a short endpoint that never inherits the process working directory. */
export function createIpcEndpoint(options: IpcEndpointOptions = {}): string {
  const platform = normalizePlatform(options.platform ?? process.platform);
  const runtimeId = options.runtimeId ?? generateRuntimeId();
  validateRuntimeId(runtimeId);

  if (platform === 'win32') {
    return `${WINDOWS_PIPE_NAMESPACE}${WINDOWS_ENDPOINT_PREFIX}${runtimeId}`;
  }

  const root = options.posixRoot ?? DEFAULT_POSIX_ENDPOINT_ROOT;
  if (typeof root !== 'string' || root.length === 0 || !posixPath.isAbsolute(root)) {
    throw new TypeError('POSIX IPC endpoint root must be a non-empty absolute path');
  }

  const endpoint = posixPath.join(
    root,
    `${POSIX_ENDPOINT_PREFIX}${runtimeId}${POSIX_ENDPOINT_SUFFIX}`,
  );
  assertPosixEndpointLength(endpoint, options.maxPosixBytes);
  return endpoint;
}

export function isGeneratedPosixEndpoint(endpoint: string): boolean {
  if (!posixPath.isAbsolute(endpoint)) {
    return false;
  }
  const name = posixPath.basename(endpoint);
  if (!name.startsWith(POSIX_ENDPOINT_PREFIX) || !name.endsWith(POSIX_ENDPOINT_SUFFIX)) {
    return false;
  }
  const runtimeId = name.slice(
    POSIX_ENDPOINT_PREFIX.length,
    name.length - POSIX_ENDPOINT_SUFFIX.length,
  );
  if (!GENERATED_RUNTIME_ID.test(runtimeId)) {
    return false;
  }
  return createIpcEndpoint({ runtimeId }) === endpoint;
}
