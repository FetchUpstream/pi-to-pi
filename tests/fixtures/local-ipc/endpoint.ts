/**
 * Endpoint helpers for the throwaway local-IPC spike.
 *
 * This module deliberately lives under tests/fixtures. It must stay independent
 * of the production transport boundary and of Pi message/task semantics.
 */
import { randomBytes } from 'node:crypto';
import { posix as posixPath } from 'node:path';

/** Keep generated POSIX socket names below the shortest documented desktop limit. */
export const DEFAULT_POSIX_ENDPOINT_MAX_BYTES = 100;

/** Use a fixed, short runtime root instead of inheriting the working directory. */
export const DEFAULT_POSIX_ENDPOINT_ROOT = '/tmp';

/** Windows' path-based named-pipe namespace. */
export const WINDOWS_PIPE_NAMESPACE = '\\\\?\\pipe\\';

export const POSIX_ENDPOINT_PREFIX = 'p2p-';
export const POSIX_ENDPOINT_SUFFIX = '.sock';
export const WINDOWS_ENDPOINT_PREFIX = 'p2p-';

const RUNTIME_ID_BYTES = 12;
const SAFE_RUNTIME_ID = /^[a-z0-9_-]+$/;

type SupportedPlatform = 'linux' | 'darwin' | 'win32';

export interface IpcEndpointOptions {
  /** Override the host platform in tests; defaults to the current Node platform. */
  readonly platform?: NodeJS.Platform;
  /** POSIX-only root used to exercise path-length boundaries in the spike. */
  readonly posixRoot?: string;
  /** Optional deterministic identifier for boundary tests; production calls omit it. */
  readonly runtimeId?: string;
  /** Override the conservative POSIX limit for boundary tests. */
  readonly maxPosixBytes?: number;
}

/** Generate a short, high-entropy identifier for one runtime endpoint. */
export function generateRuntimeId(): string {
  return randomBytes(RUNTIME_ID_BYTES).toString('hex');
}

/** Return the number of bytes a Node IPC path occupies when encoded as UTF-8. */
export function utf8ByteLength(value: string): number {
  if (typeof value !== 'string') {
    throw new TypeError('POSIX IPC endpoint must be a string');
  }

  return Buffer.byteLength(value, 'utf8');
}

/**
 * Reject a POSIX endpoint that cannot fit within the configured conservative limit.
 *
 * The check is intentionally byte-based rather than JavaScript string-length-based;
 * a path containing non-ASCII characters can occupy more bytes than code units.
 */
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
  if (platform === 'win32') {
    return platform;
  }

  if (platform === 'linux' || platform === 'darwin') {
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

/**
 * Generate the opaque path value accepted by Node's `net.Server.listen` and
 * `net.createConnection` APIs for the current platform.
 */
export function createIpcEndpoint(options: IpcEndpointOptions = {}): string {
  const platform = normalizePlatform(options.platform ?? process.platform);
  const runtimeId = options.runtimeId ?? generateRuntimeId();

  validateRuntimeId(runtimeId);

  if (platform === 'win32') {
    return `${WINDOWS_PIPE_NAMESPACE}${WINDOWS_ENDPOINT_PREFIX}${runtimeId}`;
  }

  const root = options.posixRoot ?? DEFAULT_POSIX_ENDPOINT_ROOT;
  if (root.length === 0) {
    throw new TypeError('POSIX IPC endpoint root must not be empty');
  }

  const endpoint = posixPath.join(
    root,
    `${POSIX_ENDPOINT_PREFIX}${runtimeId}${POSIX_ENDPOINT_SUFFIX}`,
  );
  assertPosixEndpointLength(endpoint, options.maxPosixBytes);
  return endpoint;
}
