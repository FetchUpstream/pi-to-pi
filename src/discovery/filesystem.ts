import { randomBytes } from 'node:crypto';
import { chmod, lstat, mkdir, open, opendir, readFile, rename, unlink } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import nodePath from 'node:path';
import { PRIVATE_DIRECTORY_MODE, protectWindowsPathSync, resolveRuntimeRoot } from '../config.js';
import type { RuntimeRootOptions, RuntimeRootSelection } from '../config.js';
import { MAX_AGENT_CARD_SIZE_BYTES } from '../protocol/agent-card.js';
import { isSafeRuntimeInstanceId, validateAgentCard } from '../protocol/validation.js';
/** Card files are deliberately bounded before they reach the filesystem. */
export const DEFAULT_MAX_CARD_BYTES = 1024 * 1024;
/** A temp file older than two lease TTLs is safe to consider abandoned. */
export const DEFAULT_ABANDONED_TEMP_AGE_MS = 2 * 90_000;
export const DEFAULT_ABANDONED_TEMP_MAX_ENTRIES = 128;
export const DEFAULT_ABANDONED_TEMP_TIME_BUDGET_MS = 250;
export const PRIVATE_FILE_MODE = 0o600;

export interface RoomStorageIdentity {
  /** Canonical identity supplied by the room derivation module (not derived here). */
  readonly roomId: string;
  /** Safe, already-derived filesystem component supplied by the room module. */
  readonly storageKey: string;
}

export interface RegistryPaths extends RoomStorageIdentity {
  readonly rootDirectory: string;
  readonly roomsDirectory: string;
  readonly roomDirectory: string;
  readonly agentsDirectory: string;
}

export interface RuntimeTree extends RegistryPaths {
  readonly runtimeRoot: RuntimeRootSelection | undefined;
}

/** Identity fields used by the cross-process compare-and-delete primitive. */
export interface FileStatSnapshot {
  readonly device: number;
  readonly inode: number;
  readonly size: number;
  readonly modifiedAt: number;
}

export type WindowsAclProtector = (
  target: string,
  kind: 'directory' | 'file',
) => void | Promise<void>;

export interface PrivateFilesystemOptions {
  readonly platform?: NodeJS.Platform;
  readonly uid?: number;
  /** Override the platform ACL operation in tests or an embedding host. */
  readonly windowsAcl?: WindowsAclProtector;
  /** Absolute wall-clock deadline for bounded lock/cleanup operations. */
  readonly deadlineMs?: number;
}

export interface RuntimeTreeOptions extends PrivateFilesystemOptions {
  readonly runtimeRoot?: string | RuntimeRootSelection;
  readonly rootOptions?: RuntimeRootOptions;
}

export interface AtomicCardWriteOptions extends PrivateFilesystemOptions {
  readonly maxCardBytes?: number;
}

export interface AbandonedTempCleanupOptions extends PrivateFilesystemOptions {
  readonly minAgeMs?: number;
  readonly now?: number;
  readonly runtimeInstanceId?: string;
  /** Maximum number of directory entries inspected in one pass. */
  readonly maxEntries?: number;
  /** Maximum wall-clock time spent inspecting temporary entries. */
  readonly maxDurationMs?: number;
}

export class PrivateFilesystemError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'PrivateFilesystemError';
  }
}

const safeComponentPattern = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}$/u;
function containsControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) {
      return true;
    }
  }
  return false;
}
const windowsReservedNamePattern = /^(?:CON|PRN|AUX|NUL|COM[0-9]|LPT[0-9])(?:\.|$)/iu;
const tempFilePattern =
  /^\.([A-Za-z0-9_-][A-Za-z0-9._-]{0,127})\.json\.tmp-([0-9]+)-([a-z0-9]+)-([0-9a-f]+)$/u;
const CARD_LOCK_RETRY_DELAY_MS = 10;
const CARD_LOCK_STALE_AFTER_MS = 2 * 60_000;
const writeLocks = new Map<string, Promise<unknown>>();
const DEADLINE_EXCEEDED = Symbol('deadline exceeded');
const MAX_TIMER_DELAY_MS = 2_147_483_647;
type DeadlineResult<T> = T | typeof DEADLINE_EXCEEDED;

function deadlineExpired(deadlineMs: number | undefined): boolean {
  return deadlineMs !== undefined && (!Number.isFinite(deadlineMs) || Date.now() >= deadlineMs);
}

async function awaitBeforeDeadline<T>(
  pending: Promise<T>,
  deadlineMs: number | undefined,
): Promise<DeadlineResult<T>> {
  if (deadlineMs === undefined) {
    return pending;
  }
  if (deadlineExpired(deadlineMs)) {
    return DEADLINE_EXCEEDED;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<typeof DEADLINE_EXCEEDED>((resolve) => {
    const delay = Math.min(Math.max(0, deadlineMs - Date.now()), MAX_TIMER_DELAY_MS);
    timer = setTimeout(() => resolve(DEADLINE_EXCEEDED), delay);
  });
  try {
    return await Promise.race([pending, timeout]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String(error.code)
    : undefined;
}

function isMissing(error: unknown): boolean {
  return errorCode(error) === 'ENOENT';
}

function currentUid(options: PrivateFilesystemOptions): number | undefined {
  if (options.uid !== undefined) {
    return options.uid;
  }
  return typeof process.getuid === 'function' ? process.getuid() : undefined;
}

function absolutePath(value: string, label: string): string {
  if (!nodePath.isAbsolute(value)) {
    throw new PrivateFilesystemError(`${label} must be absolute: ${value}`);
  }
  return nodePath.normalize(value);
}

function safeComponent(value: string, label: string): string {
  if (
    value.length === 0 ||
    value === '.' ||
    value === '..' ||
    value.length > 128 ||
    !safeComponentPattern.test(value) ||
    containsControlCharacter(value) ||
    value.includes('/') ||
    value.includes('\\') ||
    value.endsWith('.') ||
    value.endsWith(' ') ||
    windowsReservedNamePattern.test(value)
  ) {
    throw new PrivateFilesystemError(`${label} is not a safe filesystem component: ${value}`);
  }
  return value;
}

function validateRoomIdentity(identity: RoomStorageIdentity): void {
  if (
    typeof identity.roomId !== 'string' ||
    identity.roomId.length === 0 ||
    identity.roomId.length > 1024
  ) {
    throw new PrivateFilesystemError('roomId must be a non-empty canonical identity');
  }
  if (containsControlCharacter(identity.roomId)) {
    throw new PrivateFilesystemError('roomId contains a control character');
  }
  safeComponent(identity.storageKey, 'storageKey');
}

function runtimeRootPath(root: string | RuntimeRootSelection): string {
  return typeof root === 'string'
    ? absolutePath(root, 'runtime root')
    : absolutePath(root.path, 'runtime root');
}

function pathWithin(parent: string, child: string): boolean {
  const relative = nodePath.relative(parent, child);
  return (
    relative.length > 0 &&
    relative !== '..' &&
    !relative.startsWith(`..${nodePath.sep}`) &&
    !nodePath.isAbsolute(relative)
  );
}

function assertPathWithin(parent: string, child: string, label: string): void {
  if (!pathWithin(parent, child)) {
    throw new PrivateFilesystemError(`${label} escapes the runtime root: ${child}`);
  }
}

function defaultWindowsAcl(target: string, kind: 'directory' | 'file'): void {
  // The sync helper is a no-op off Windows and uses icacls on Windows.
  protectWindowsPathSync(target, kind);
}

async function protectWindowsTarget(
  target: string,
  kind: 'directory' | 'file',
  options: PrivateFilesystemOptions,
): Promise<void> {
  if ((options.platform ?? process.platform) !== 'win32') {
    return;
  }
  await (options.windowsAcl ?? defaultWindowsAcl)(target, kind);
}

function privateMode(mode: number, expected: number): boolean {
  return (mode & 0o777) === expected;
}

/** Ensure a directory exists, is not a symlink, and is private to this user. */
export async function ensurePrivateDirectory(
  directory: string,
  options: PrivateFilesystemOptions = {},
): Promise<string> {
  const target = absolutePath(directory, 'directory');
  const platform = options.platform ?? process.platform;
  const uid = currentUid(options);
  let existed = true;

  try {
    const existing = await lstat(target);
    if (!existing.isDirectory() || existing.isSymbolicLink()) {
      throw new PrivateFilesystemError(`Not a real directory: ${target}`);
    }
  } catch (error) {
    if (!isMissing(error)) {
      throw error;
    }
    existed = false;
    await mkdir(target, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  }

  const stats = await lstat(target);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new PrivateFilesystemError(`Not a real directory: ${target}`);
  }

  if (platform === 'win32') {
    await protectWindowsTarget(target, 'directory', options);
    return target;
  }

  if (uid === undefined || stats.uid !== uid) {
    throw new PrivateFilesystemError(`Directory is not owned by the current user: ${target}`);
  }
  if (!privateMode(stats.mode, PRIVATE_DIRECTORY_MODE)) {
    if (existed) {
      throw new PrivateFilesystemError(`Directory is not private (expected 0700): ${target}`);
    }
    // An unusual umask can affect owner bits on a just-created directory.
    await chmod(target, PRIVATE_DIRECTORY_MODE);
    const tightened = await lstat(target);
    if (!privateMode(tightened.mode, PRIVATE_DIRECTORY_MODE)) {
      throw new PrivateFilesystemError(`Cannot establish private directory permissions: ${target}`);
    }
  }

  return target;
}

/** Ensure an existing regular file has private 0600 POSIX permissions. */
export async function ensurePrivateFile(
  file: string,
  options: PrivateFilesystemOptions = {},
): Promise<string> {
  const target = absolutePath(file, 'file');
  const platform = options.platform ?? process.platform;
  const uid = currentUid(options);
  const stats = await lstat(target);

  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new PrivateFilesystemError(`Not a real regular file: ${target}`);
  }

  if (platform === 'win32') {
    await protectWindowsTarget(target, 'file', options);
    return target;
  }

  if (uid === undefined || stats.uid !== uid) {
    throw new PrivateFilesystemError(`File is not owned by the current user: ${target}`);
  }
  await chmod(target, PRIVATE_FILE_MODE);
  const tightened = await lstat(target);
  if (!privateMode(tightened.mode, PRIVATE_FILE_MODE)) {
    throw new PrivateFilesystemError(`Cannot establish private file permissions: ${target}`);
  }
  return target;
}

export function buildRoomDirectoryPath(
  runtimeRoot: string | RuntimeRootSelection,
  storageKey: string,
): string {
  const root = runtimeRootPath(runtimeRoot);
  const key = safeComponent(storageKey, 'storageKey');
  const rooms = nodePath.join(root, 'rooms');
  const room = nodePath.join(rooms, key);
  assertPathWithin(root, rooms, 'rooms directory');
  assertPathWithin(root, room, 'room directory');
  return room;
}

export function buildAgentDirectoryPath(
  runtimeRoot: string | RuntimeRootSelection,
  storageKey: string,
): string {
  const root = runtimeRootPath(runtimeRoot);
  const room = buildRoomDirectoryPath(root, storageKey);
  const agents = nodePath.join(room, 'agents');
  assertPathWithin(root, agents, 'agents directory');
  return agents;
}

export function buildAgentCardPath(
  runtimeRoot: string | RuntimeRootSelection,
  storageKey: string,
  runtimeInstanceId: string,
): string {
  const root = runtimeRootPath(runtimeRoot);
  const agents = buildAgentDirectoryPath(root, storageKey);
  if (!isSafeRuntimeInstanceId(runtimeInstanceId)) {
    throw new PrivateFilesystemError(
      `runtimeInstanceId is not a safe cross-platform identity: ${runtimeInstanceId}`,
    );
  }
  const identity = runtimeInstanceId;
  const card = nodePath.join(agents, `${identity}.json`);
  assertPathWithin(root, card, 'agent card path');
  if (nodePath.basename(card) !== `${identity}.json`) {
    throw new PrivateFilesystemError('Runtime identity does not match the card filename');
  }
  return card;
}

/** Construct all room paths without deriving or hashing the supplied room ID. */
export function buildRegistryPaths(
  runtimeRoot: string | RuntimeRootSelection,
  identity: RoomStorageIdentity,
): RegistryPaths {
  validateRoomIdentity(identity);
  const root = runtimeRootPath(runtimeRoot);
  const roomsDirectory = nodePath.join(root, 'rooms');
  const roomDirectory = buildRoomDirectoryPath(root, identity.storageKey);
  const agentsDirectory = buildAgentDirectoryPath(root, identity.storageKey);
  assertPathWithin(root, roomsDirectory, 'rooms directory');
  assertPathWithin(root, roomDirectory, 'room directory');
  assertPathWithin(root, agentsDirectory, 'agents directory');
  return {
    rootDirectory: root,
    roomsDirectory,
    roomDirectory,
    agentsDirectory,
    roomId: identity.roomId,
    storageKey: identity.storageKey,
  };
}

/** Create `<root>/rooms/<storageKey>/agents` with private permissions. */
export async function createPrivateRuntimeTree(
  runtimeRoot: string | RuntimeRootSelection,
  identity: RoomStorageIdentity,
  options: PrivateFilesystemOptions = {},
): Promise<RuntimeTree> {
  const paths = buildRegistryPaths(runtimeRoot, identity);
  await ensurePrivateDirectory(paths.rootDirectory, options);
  await ensurePrivateDirectory(paths.roomsDirectory, options);
  await ensurePrivateDirectory(paths.roomDirectory, options);
  await ensurePrivateDirectory(paths.agentsDirectory, options);
  return { ...paths, runtimeRoot: typeof runtimeRoot === 'string' ? undefined : runtimeRoot };
}

/** Resolve and secure the runtime root before a registry worker creates rooms. */
export async function ensureRuntimeRoot(
  options: RuntimeRootOptions & PrivateFilesystemOptions = {},
): Promise<RuntimeRootSelection> {
  const selection = resolveRuntimeRoot(options);
  await ensurePrivateDirectory(selection.path, options);
  return selection;
}

/** Resolve a root and create a complete private room tree in one operation. */
export async function ensurePrivateRuntimeTree(
  identity: RoomStorageIdentity,
  options: RuntimeTreeOptions = {},
): Promise<RuntimeTree> {
  const runtimeRoot = options.runtimeRoot ?? resolveRuntimeRoot(options.rootOptions);
  return createPrivateRuntimeTree(runtimeRoot, identity, options);
}

/** Getter-style alias for registry workers. */
export const ensureRuntimeTree = ensurePrivateRuntimeTree;

function isRegistryPaths(value: string | RegistryPaths): value is RegistryPaths {
  return typeof value !== 'string';
}

function cardRecord(card: unknown): Record<string, unknown> {
  if (typeof card !== 'object' || card === null || Array.isArray(card)) {
    throw new PrivateFilesystemError('Agent Card payload must be an object');
  }
  return card as Record<string, unknown>;
}

function destinationFor(
  destination: string | RegistryPaths,
  runtimeInstanceId: string,
): { agentsDirectory: string; finalPath: string; roomId?: string } {
  if (isRegistryPaths(destination)) {
    const agentsDirectory = absolutePath(destination.agentsDirectory, 'agents directory');
    const finalPath = buildAgentCardPath(
      destination.rootDirectory,
      destination.storageKey,
      runtimeInstanceId,
    );
    if (finalPath !== nodePath.join(agentsDirectory, `${runtimeInstanceId}.json`)) {
      throw new PrivateFilesystemError('Runtime identity does not match the destination card path');
    }
    return { agentsDirectory, finalPath, roomId: destination.roomId };
  }

  const agentsDirectory = absolutePath(destination, 'agents directory');
  const finalPath = nodePath.join(agentsDirectory, `${runtimeInstanceId}.json`);
  assertPathWithin(agentsDirectory, finalPath, 'agent card path');
  return { agentsDirectory, finalPath };
}

async function openUniqueTemporaryCard(
  agentsDirectory: string,
  runtimeInstanceId: string,
): Promise<{ readonly path: string; readonly handle: FileHandle }> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const suffix = `${process.pid}-${Date.now().toString(36)}-${randomBytes(16).toString('hex')}`;
    const name = `.${runtimeInstanceId}.json.tmp-${suffix}`;
    const path = nodePath.join(agentsDirectory, name);
    try {
      const handle = await open(path, 'wx', PRIVATE_FILE_MODE);
      return { path, handle };
    } catch (error) {
      if (errorCode(error) !== 'EEXIST') {
        throw error;
      }
    }
  }
  throw new PrivateFilesystemError('Unable to allocate a unique temporary card file');
}

async function withWriteLock<T>(
  key: string,
  operation: () => Promise<T>,
  deadlineMs?: number,
): Promise<T | undefined> {
  const previous = writeLocks.get(key) ?? Promise.resolve();
  const current = previous.then(operation, operation);
  writeLocks.set(key, current);
  try {
    const result = await awaitBeforeDeadline(current, deadlineMs);
    return result === DEADLINE_EXCEEDED ? undefined : result;
  } finally {
    if (writeLocks.get(key) === current) {
      writeLocks.delete(key);
    }
  }
}

interface CardLockOwner {
  readonly pid: number;
  readonly token: string;
  readonly acquiredAt: number;
}

function isRecordValue(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseCardLockOwner(source: string): CardLockOwner | undefined {
  try {
    const value = JSON.parse(source) as unknown;
    if (!isRecordValue(value)) {
      return undefined;
    }
    const pid = value.pid;
    const token = value.token;
    const acquiredAt = value.acquiredAt;
    if (
      typeof pid !== 'number' ||
      !Number.isSafeInteger(pid) ||
      pid <= 0 ||
      typeof token !== 'string' ||
      token.length === 0 ||
      typeof acquiredAt !== 'number' ||
      !Number.isFinite(acquiredAt)
    ) {
      return undefined;
    }
    return {
      pid,
      token,
      acquiredAt,
    };
  } catch {
    return undefined;
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) === 'EPERM';
  }
}

function fileSnapshot(stats: {
  readonly dev: number;
  readonly ino: number;
  readonly size: number;
  readonly mtimeMs: number;
}): FileStatSnapshot {
  return {
    device: stats.dev,
    inode: stats.ino,
    size: stats.size,
    modifiedAt: stats.mtimeMs,
  };
}

function sameFileSnapshot(left: FileStatSnapshot, right: FileStatSnapshot): boolean {
  return (
    left.device === right.device &&
    left.inode === right.inode &&
    left.size === right.size &&
    left.modifiedAt === right.modifiedAt
  );
}

function waitForCardLock(deadlineMs: number | undefined): Promise<boolean> {
  if (deadlineExpired(deadlineMs)) {
    return Promise.resolve(false);
  }
  const delay =
    deadlineMs === undefined
      ? CARD_LOCK_RETRY_DELAY_MS
      : Math.min(CARD_LOCK_RETRY_DELAY_MS, Math.max(0, deadlineMs - Date.now()));
  return new Promise((resolve) => {
    setTimeout(() => resolve(!deadlineExpired(deadlineMs)), delay);
  });
}

type CardLockReclaimResult = 'retry' | 'wait' | 'stop';

async function reclaimStaleCardLock(
  lockPath: string,
  deadlineMs: number | undefined,
): Promise<CardLockReclaimResult> {
  let firstStats;
  try {
    const result = await awaitBeforeDeadline(lstat(lockPath), deadlineMs);
    if (result === DEADLINE_EXCEEDED) {
      return 'stop';
    }
    firstStats = result;
  } catch (error) {
    if (isMissing(error)) {
      return 'retry';
    }
    throw error;
  }
  if (!firstStats.isFile() || firstStats.isSymbolicLink()) {
    return 'stop';
  }
  if (Date.now() - firstStats.mtimeMs < CARD_LOCK_STALE_AFTER_MS) {
    return 'wait';
  }

  let owner: CardLockOwner | undefined;
  try {
    const result = await awaitBeforeDeadline(readFile(lockPath, 'utf8'), deadlineMs);
    if (result === DEADLINE_EXCEEDED) {
      return 'stop';
    }
    owner = parseCardLockOwner(result);
  } catch (error) {
    if (!isMissing(error)) {
      throw error;
    }
    return 'retry';
  }
  if (owner && processIsAlive(owner.pid)) {
    return 'wait';
  }

  let secondStats;
  try {
    const result = await awaitBeforeDeadline(lstat(lockPath), deadlineMs);
    if (result === DEADLINE_EXCEEDED) {
      return 'stop';
    }
    secondStats = result;
  } catch (error) {
    if (isMissing(error)) {
      return 'retry';
    }
    throw error;
  }
  if (!secondStats.isFile() || secondStats.isSymbolicLink()) {
    return 'stop';
  }
  if (!sameFileSnapshot(fileSnapshot(firstStats), fileSnapshot(secondStats))) {
    return 'wait';
  }
  if (deadlineExpired(deadlineMs)) {
    return 'stop';
  }
  await unlink(lockPath).catch((error: unknown) => {
    if (!isMissing(error)) {
      throw error;
    }
  });
  return 'retry';
}

async function acquireCardWriteLock(
  cardPath: string,
  options: PrivateFilesystemOptions,
): Promise<(() => Promise<void>) | undefined> {
  const lockPath = `${cardPath}.lock`;
  const deadlineMs = options.deadlineMs;
  const owner: CardLockOwner = {
    pid: process.pid,
    token: randomBytes(16).toString('hex'),
    acquiredAt: Date.now(),
  };
  const serializedOwner = JSON.stringify(owner);

  while (true) {
    if (deadlineExpired(deadlineMs)) {
      return undefined;
    }
    let created = false;
    let handle: FileHandle | undefined;
    try {
      handle = await open(lockPath, 'wx', PRIVATE_FILE_MODE);
      created = true;
      if (deadlineExpired(deadlineMs)) {
        await handle.close();
        handle = undefined;
        await unlink(lockPath).catch(() => undefined);
        return undefined;
      }
      await handle.writeFile(serializedOwner, 'utf8');
      if (deadlineExpired(deadlineMs)) {
        await handle.close();
        handle = undefined;
        await unlink(lockPath).catch(() => undefined);
        return undefined;
      }
      await handle.sync();
      if (deadlineExpired(deadlineMs)) {
        await handle.close();
        handle = undefined;
        await unlink(lockPath).catch(() => undefined);
        return undefined;
      }
      await handle.close();
      handle = undefined;
      if (deadlineExpired(deadlineMs)) {
        await unlink(lockPath).catch(() => undefined);
        return undefined;
      }
      await protectWindowsTarget(lockPath, 'file', options);
      const release = async (): Promise<void> => {
        let source: string;
        try {
          source = await readFile(lockPath, 'utf8');
        } catch (error) {
          if (isMissing(error)) {
            return;
          }
          throw error;
        }
        if (parseCardLockOwner(source)?.token !== owner.token) {
          return;
        }
        await unlink(lockPath).catch((error: unknown) => {
          if (!isMissing(error)) {
            throw error;
          }
        });
      };
      if (deadlineExpired(deadlineMs)) {
        await release();
        return undefined;
      }
      return release;
    } catch (error) {
      if (handle) {
        await handle.close().catch(() => undefined);
      }
      if (created) {
        await unlink(lockPath).catch(() => undefined);
      }
      if (errorCode(error) !== 'EEXIST') {
        throw error;
      }
      const reclaimResult = await reclaimStaleCardLock(lockPath, deadlineMs);
      if (reclaimResult === 'stop' || deadlineExpired(deadlineMs)) {
        return undefined;
      }
      if (reclaimResult === 'retry') {
        continue;
      }
      if (!(await waitForCardLock(deadlineMs))) {
        return undefined;
      }
    }
  }
}

/** Serialize card writes and compare/delete operations across processes. */
export function withAgentCardWriteLock<T>(
  cardPath: string,
  operation: () => Promise<T>,
  options: PrivateFilesystemOptions = {},
): Promise<T> {
  const target = absolutePath(cardPath, 'card path');
  return withWriteLock(
    target,
    async () => {
      if (deadlineExpired(options.deadlineMs)) {
        return undefined as T;
      }
      const release = await acquireCardWriteLock(target, options);
      if (!release) {
        if (options.deadlineMs !== undefined) {
          return undefined as T;
        }
        throw new PrivateFilesystemError(`Unable to acquire a safe card lock: ${target}`);
      }
      try {
        if (deadlineExpired(options.deadlineMs)) {
          return undefined as T;
        }
        return await operation();
      } finally {
        await release();
      }
    },
    options.deadlineMs,
  ) as Promise<T>;
}

/**
 * Publish a complete card through a unique same-directory temporary file and
 * atomic rename. Writes to one runtime path are serialized; different runtime
 * IDs never share a destination.
 */
export async function writeAgentCardAtomically(
  destination: string | RegistryPaths,
  runtimeInstanceId: string,
  card: unknown,
  options: AtomicCardWriteOptions = {},
): Promise<string> {
  if (!isSafeRuntimeInstanceId(runtimeInstanceId)) {
    throw new PrivateFilesystemError(
      `runtimeInstanceId is not a safe cross-platform identity: ${runtimeInstanceId}`,
    );
  }
  const identity = runtimeInstanceId;
  const target = destinationFor(destination, identity);
  const payload = cardRecord(card);
  if (payload.runtimeInstanceId !== identity) {
    throw new PrivateFilesystemError(
      'Card runtimeInstanceId does not match its destination filename',
    );
  }
  if (target.roomId !== undefined && payload.roomId !== target.roomId) {
    throw new PrivateFilesystemError('Card roomId does not match its destination room');
  }

  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(card);
  } catch (error) {
    throw new PrivateFilesystemError(
      `Cannot serialize Agent Card: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (serialized === undefined) {
    throw new PrivateFilesystemError('Agent Card payload cannot be serialized as JSON');
  }
  const maxCardBytes = options.maxCardBytes ?? DEFAULT_MAX_CARD_BYTES;
  if (!Number.isSafeInteger(maxCardBytes) || maxCardBytes <= 0) {
    throw new PrivateFilesystemError('maxCardBytes must be a positive safe integer');
  }
  if (Buffer.byteLength(serialized, 'utf8') > maxCardBytes) {
    throw new PrivateFilesystemError(`Agent Card exceeds the ${maxCardBytes}-byte limit`);
  }
  const validation = validateAgentCard(card, {
    expectedRuntimeInstanceId: identity,
    expectedRecordFileName: `${identity}.json`,
    maxCardSizeBytes: Math.min(maxCardBytes, MAX_AGENT_CARD_SIZE_BYTES),
    ...(target.roomId === undefined ? {} : { expectedRoomId: target.roomId }),
  });
  if (!validation.valid) {
    throw new PrivateFilesystemError(
      validation.errors.map((error) => `${error.path}: ${error.message}`).join('; '),
    );
  }

  await ensurePrivateDirectory(target.agentsDirectory, options);
  return withAgentCardWriteLock(
    target.finalPath,
    async () => {
      await ensurePrivateDirectory(target.agentsDirectory, options);
      let temporaryPath: string | undefined;
      let handle: FileHandle | undefined;
      try {
        const temporary = await openUniqueTemporaryCard(target.agentsDirectory, identity);
        temporaryPath = temporary.path;
        handle = temporary.handle;
        await handle.writeFile(serialized, 'utf8');
        await handle.sync();
        await handle.close();
        handle = undefined;
        await ensurePrivateFile(temporaryPath, options);
        await rename(temporaryPath, target.finalPath);
        temporaryPath = undefined;
        await ensurePrivateFile(target.finalPath, options);
        return target.finalPath;
      } catch (error) {
        if (handle) {
          await handle.close().catch(() => undefined);
        }
        if (temporaryPath) {
          await unlink(temporaryPath).catch(() => undefined);
        }
        throw error;
      }
    },
    options,
  );
}

/**
 * Delete a file only when its inode and metadata still match the observed
 * snapshot, while holding the same cross-process lock used by card writers.
 */
export async function compareAndDeleteFile(
  filePath: string,
  expected: FileStatSnapshot,
  options: PrivateFilesystemOptions = {},
): Promise<boolean> {
  const target = absolutePath(filePath, 'card path');
  let result: boolean | undefined;
  try {
    result = await withAgentCardWriteLock(
      target,
      async () => {
        if (deadlineExpired(options.deadlineMs)) {
          return false;
        }
        let stats;
        try {
          stats = await lstat(target);
        } catch (error) {
          if (isMissing(error)) {
            return false;
          }
          throw error;
        }
        if (deadlineExpired(options.deadlineMs)) {
          return false;
        }
        if (!stats.isFile() || stats.isSymbolicLink()) {
          return false;
        }
        if (!sameFileSnapshot(fileSnapshot(stats), expected)) {
          return false;
        }
        if (deadlineExpired(options.deadlineMs)) {
          return false;
        }
        try {
          await unlink(target);
          return true;
        } catch (error) {
          if (isMissing(error)) {
            return false;
          }
          throw error;
        }
      },
      options,
    );
  } catch (error) {
    if (
      error instanceof PrivateFilesystemError &&
      error.message.startsWith('Unable to acquire a safe card lock:')
    ) {
      return false;
    }
    throw error;
  }
  return result === true;
}

/** Short alias for registry publication code. */
export const atomicWriteCard = writeAgentCardAtomically;

function validateCleanupAge(value: number | undefined): number {
  const age = value ?? DEFAULT_ABANDONED_TEMP_AGE_MS;
  if (!Number.isFinite(age) || age < 0) {
    throw new PrivateFilesystemError('minAgeMs must be a finite non-negative number');
  }
  return age;
}

function validateCleanupBudget(value: number | undefined, fallback: number, label: string): number {
  const budget = value ?? fallback;
  if (!Number.isSafeInteger(budget) || budget < 0) {
    throw new PrivateFilesystemError(`${label} must be a non-negative safe integer`);
  }
  return budget;
}

/**
 * Remove only old temporary files generated by this module. Final `.json`
 * records, symlinks, directories, and files that changed during inspection are
 * never removed.
 */
export async function cleanupAbandonedTemporaryFiles(
  agentsDirectory: string,
  options: AbandonedTempCleanupOptions = {},
): Promise<number> {
  const directory = absolutePath(agentsDirectory, 'agents directory');
  const age = validateCleanupAge(options.minAgeMs);
  const now = options.now ?? Date.now();
  if (!Number.isFinite(now)) {
    throw new PrivateFilesystemError('now must be a finite timestamp');
  }
  const maxEntries = validateCleanupBudget(
    options.maxEntries,
    DEFAULT_ABANDONED_TEMP_MAX_ENTRIES,
    'maxEntries',
  );
  const maxDurationMs = validateCleanupBudget(
    options.maxDurationMs,
    DEFAULT_ABANDONED_TEMP_TIME_BUDGET_MS,
    'maxDurationMs',
  );
  const cleanupStartedAt = Date.now();
  const deadlineMs =
    options.deadlineMs ?? Math.min(Number.MAX_SAFE_INTEGER, cleanupStartedAt + maxDurationMs);
  if (deadlineExpired(deadlineMs)) {
    return 0;
  }
  const runtimeIdentity =
    options.runtimeInstanceId === undefined
      ? undefined
      : isSafeRuntimeInstanceId(options.runtimeInstanceId)
        ? options.runtimeInstanceId
        : (() => {
            throw new PrivateFilesystemError(
              `runtimeInstanceId is not a safe cross-platform identity: ${options.runtimeInstanceId}`,
            );
          })();

  let directoryStats;
  try {
    const result = await awaitBeforeDeadline(lstat(directory), deadlineMs);
    if (result === DEADLINE_EXCEEDED) {
      return 0;
    }
    directoryStats = result;
  } catch (error) {
    if (isMissing(error)) {
      return 0;
    }
    throw error;
  }
  if (!directoryStats.isDirectory() || directoryStats.isSymbolicLink()) {
    throw new PrivateFilesystemError(`Agents path is not a real directory: ${directory}`);
  }
  if ((options.platform ?? process.platform) !== 'win32') {
    const uid = currentUid(options);
    if (
      uid === undefined ||
      directoryStats.uid !== uid ||
      !privateMode(directoryStats.mode, PRIVATE_DIRECTORY_MODE)
    ) {
      throw new PrivateFilesystemError(`Agents directory is not private: ${directory}`);
    }
  }

  const namesResult = await awaitBeforeDeadline(
    (async (): Promise<string[]> => {
      let directoryHandle;
      try {
        directoryHandle = await opendir(directory);
      } catch (error) {
        if (isMissing(error)) {
          return [];
        }
        throw error;
      }
      const names: string[] = [];
      try {
        for await (const entry of directoryHandle) {
          if (names.length >= maxEntries || deadlineExpired(deadlineMs)) {
            break;
          }
          names.push(entry.name);
        }
      } finally {
        await directoryHandle.close().catch(() => undefined);
      }
      return names;
    })(),
    deadlineMs,
  );
  if (namesResult === DEADLINE_EXCEEDED) {
    return 0;
  }
  const names = namesResult;
  let removed = 0;
  let inspected = 0;
  for (const name of names) {
    if (inspected >= maxEntries || deadlineExpired(deadlineMs)) {
      break;
    }
    inspected += 1;
    const match = tempFilePattern.exec(name);
    if (!match || (runtimeIdentity !== undefined && match[1] !== runtimeIdentity)) {
      continue;
    }
    const path = nodePath.join(directory, name);
    if (!pathWithin(directory, path)) {
      continue;
    }

    let first;
    try {
      const result = await awaitBeforeDeadline(lstat(path), deadlineMs);
      if (result === DEADLINE_EXCEEDED) {
        break;
      }
      first = result;
    } catch (error) {
      if (isMissing(error)) {
        continue;
      }
      throw error;
    }
    if (deadlineExpired(deadlineMs)) {
      break;
    }
    if (
      !first.isFile() ||
      first.isSymbolicLink() ||
      now - first.mtimeMs < age ||
      first.mtimeMs > now
    ) {
      continue;
    }

    // Re-read immediately before unlinking, so a writer that replaced or
    // renewed this temp path cannot be removed based on stale metadata.
    let second;
    try {
      const result = await awaitBeforeDeadline(lstat(path), deadlineMs);
      if (result === DEADLINE_EXCEEDED) {
        break;
      }
      second = result;
    } catch (error) {
      if (isMissing(error)) {
        continue;
      }
      throw error;
    }
    if (
      !second.isFile() ||
      second.isSymbolicLink() ||
      first.dev !== second.dev ||
      first.ino !== second.ino ||
      first.size !== second.size ||
      first.mtimeMs !== second.mtimeMs
    ) {
      continue;
    }
    if (deadlineExpired(deadlineMs)) {
      break;
    }
    try {
      const result = await awaitBeforeDeadline(unlink(path), deadlineMs);
      if (result === DEADLINE_EXCEEDED) {
        return removed;
      }
      removed += 1;
    } catch (error) {
      if (!isMissing(error)) {
        throw error;
      }
    }
  }
  return removed;
}

/** Alias emphasizing that only abandoned card temps are considered. */
export const cleanupAbandonedTempFiles = cleanupAbandonedTemporaryFiles;
