import { access, mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

export const DEFAULT_WORKSPACE_CLEANUP_RETRIES = 5;
export const DEFAULT_WORKSPACE_CLEANUP_RETRY_DELAY_MS = 50;
const RETRYABLE_CLEANUP_ERROR_CODES = new Set([
  'EACCES',
  'EBUSY',
  'EMFILE',
  'ENFILE',
  'ENOTEMPTY',
  'EPERM',
]);

export interface TestWorkspaceOptions {
  /** Prefix used for the directory created below `tempDirectory`. */
  readonly prefix?: string;
  /** Parent directory for the isolated workspace. Defaults to the OS temp directory. */
  readonly tempDirectory?: string;
  /** Number of additional attempts after the initial cleanup attempt. */
  readonly cleanupRetries?: number;
  /** Delay between cleanup attempts in milliseconds. */
  readonly cleanupRetryDelayMs?: number;
}

/** Owner-provided cleanup work, such as terminating managed child processes. */
export type WorkspaceCleanupHook = () => void | Promise<void>;

export interface TestWorkspacePaths {
  readonly root: string;
  readonly runtime: string;
  readonly room: string;
}

export interface TestWorkspace {
  /** Stable unique identifier derived from the temporary workspace name. */
  readonly id: string;
  readonly rootPath: string;
  readonly runtimePath: string;
  readonly roomPath: string;
  readonly runtimeId: string;
  readonly roomId: string;
  readonly paths: TestWorkspacePaths;
  /** Values that can be merged into a child process environment without mutating `process.env`. */
  readonly env: Readonly<Record<string, string>>;
  /** Alias for callers that prefer the longer name. */
  readonly environment: Readonly<Record<string, string>>;
  /** Registers a hook that MUST release child resources before workspace removal. */
  readonly registerBeforeCleanup: (hook: WorkspaceCleanupHook) => () => void;
  /** Idempotently removes the complete workspace with bounded retries. */
  readonly cleanup: () => Promise<void>;
}

export interface RemoveTestWorkspaceOptions {
  /** Number of additional attempts after the initial removal attempt. */
  readonly retries?: number;
  /** Delay between removal attempts in milliseconds. */
  readonly retryDelayMs?: number;
}

/**
 * Creates a unique workspace and the runtime/room directories owned by it.
 *
 * The helper only returns environment values; it deliberately never writes to
 * `process.env` or changes any other process-global state.
 */
export async function createTestWorkspace(
  options: TestWorkspaceOptions = {},
): Promise<TestWorkspace> {
  const prefix = options.prefix ?? 'pi-to-pi-test-';
  const tempDirectory = options.tempDirectory ?? tmpdir();
  const rootPath = await mkdtemp(join(tempDirectory, prefix));
  const runtimePath = join(rootPath, 'runtime');
  const roomPath = join(rootPath, 'room');

  try {
    await mkdir(runtimePath);
    await mkdir(roomPath);
  } catch (error) {
    try {
      await removeTestWorkspace(rootPath, {
        retries: options.cleanupRetries,
        retryDelayMs: options.cleanupRetryDelayMs,
      });
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        `Unable to create test workspace "${rootPath}" and clean up after the creation failure`,
      );
    }
    throw error;
  }

  const id = basename(rootPath);
  const runtimeId = `${id}-runtime`;
  const roomId = `${id}-room`;
  const env = Object.freeze({
    TEST_WORKSPACE_PATH: rootPath,
    TEST_RUNTIME_PATH: runtimePath,
    TEST_ROOM_PATH: roomPath,
    TEST_RUNTIME_ID: runtimeId,
    TEST_ROOM_ID: roomId,
  });
  const paths = Object.freeze({
    root: rootPath,
    runtime: runtimePath,
    room: roomPath,
  });
  const cleanupOptions = {
    retries: options.cleanupRetries ?? DEFAULT_WORKSPACE_CLEANUP_RETRIES,
    retryDelayMs: options.cleanupRetryDelayMs ?? DEFAULT_WORKSPACE_CLEANUP_RETRY_DELAY_MS,
  };

  let cleanupPromise: Promise<void> | undefined;
  let cleanupStarted = false;
  const cleanupHooks = new Set<WorkspaceCleanupHook>();
  const registerBeforeCleanup = (hook: WorkspaceCleanupHook): (() => void) => {
    if (typeof hook !== 'function') {
      throw new TypeError('workspace cleanup hook must be a function');
    }
    if (cleanupStarted) {
      throw new Error('Cannot register a workspace cleanup hook after cleanup has started');
    }
    cleanupHooks.add(hook);
    return () => {
      cleanupHooks.delete(hook);
    };
  };
  const runCleanup = async (): Promise<void> => {
    cleanupStarted = true;
    const errors: unknown[] = [];
    for (const hook of cleanupHooks) {
      try {
        await hook();
      } catch (error) {
        errors.push(error);
      }
    }
    cleanupHooks.clear();
    try {
      await removeTestWorkspace(rootPath, cleanupOptions);
    } catch (error) {
      errors.push(error);
    }
    if (errors.length === 1) {
      throw errors[0];
    }
    if (errors.length > 1) {
      throw new AggregateError(
        errors,
        `Unable to clean up test workspace "${rootPath}"; ${errors
          .map((error) => (error instanceof Error ? error.message : String(error)))
          .join('; ')}`,
      );
    }
  };
  const cleanup = (): Promise<void> => {
    cleanupPromise ??= runCleanup();
    return cleanupPromise;
  };
  return Object.freeze({
    id,
    rootPath,
    runtimePath,
    roomPath,
    runtimeId,
    roomId,
    paths,
    env,
    environment: env,
    registerBeforeCleanup,
    cleanup,
  });
}

/**
 * Removes a workspace using a bounded retry loop for transient filesystem
 * errors such as Windows `EPERM`, `EBUSY`, and `ENOTEMPTY` failures.
 */
export async function removeTestWorkspace(
  rootPath: string,
  options: RemoveTestWorkspaceOptions = {},
): Promise<void> {
  const retries = validateNonNegativeInteger(
    options.retries ?? DEFAULT_WORKSPACE_CLEANUP_RETRIES,
    'cleanup retries',
  );
  const retryDelayMs = validateNonNegativeInteger(
    options.retryDelayMs ?? DEFAULT_WORKSPACE_CLEANUP_RETRY_DELAY_MS,
    'cleanup retry delay',
  );
  let lastError: unknown;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      await rm(rootPath, {
        force: true,
        maxRetries: 0,
        recursive: true,
      });
      return;
    } catch (error) {
      lastError = error;
      if (!isRetryableRemovalError(error) || attempt === retries) {
        throw createCleanupError(rootPath, attempt + 1, error);
      }
      if (retryDelayMs > 0) {
        await delay(retryDelayMs);
      }
    }
  }

  throw createCleanupError(rootPath, retries + 1, lastError);
}

/**
 * Runs a callback with an isolated workspace and always attempts cleanup.
 * If both the callback and cleanup fail, the returned AggregateError contains both failures.
 */
export async function withTestWorkspace<T>(
  callback: (workspace: TestWorkspace) => T | Promise<T>,
  options: TestWorkspaceOptions = {},
): Promise<T> {
  const workspace = await createTestWorkspace(options);
  let callbackFailed = false;
  let callbackResult!: T;
  let callbackError: unknown;
  try {
    callbackResult = await callback(workspace);
  } catch (error) {
    callbackFailed = true;
    callbackError = error;
  }

  let cleanupFailed = false;
  let cleanupError: unknown;
  try {
    await workspace.cleanup();
  } catch (error) {
    cleanupFailed = true;
    cleanupError = error;
  }

  if (callbackFailed && cleanupFailed) {
    throw new AggregateError(
      [callbackError, cleanupError],
      `Test workspace callback and cleanup failed for "${workspace.rootPath}"`,
    );
  }
  if (callbackFailed) {
    throw callbackError;
  }
  if (cleanupFailed) {
    throw cleanupError;
  }
  return callbackResult;
}

function validateNonNegativeInteger(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative integer; received ${value}`);
  }
  return value;
}

function isRetryableRemovalError(error: unknown): boolean {
  if (!isNodeError(error)) {
    return false;
  }
  const code = error.code;
  return typeof code === 'string' && RETRYABLE_CLEANUP_ERROR_CODES.has(code);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && typeof (error as NodeJS.ErrnoException).code === 'string';
}

function createCleanupError(rootPath: string, attempts: number, cause: unknown): Error {
  const message = cause instanceof Error ? cause.message : String(cause);
  return new Error(
    `Unable to remove test workspace "${rootPath}" after ${attempts} attempt${attempts === 1 ? '' : 's'}: ${message}`,
    { cause },
  );
}

async function delay(durationMs: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, durationMs);
  });
}

export async function testWorkspaceExists(rootPath: string): Promise<boolean> {
  try {
    await access(rootPath);
    return true;
  } catch {
    return false;
  }
}
