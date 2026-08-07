import { randomBytes } from 'node:crypto';
import { chmod, lstat, mkdir, open, readdir, rename, unlink } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import nodePath from 'node:path';

import { PRIVATE_DIRECTORY_MODE, protectWindowsPathSync, resolveRuntimeRoot } from '../config.js';
import type { RuntimeRootOptions, RuntimeRootSelection } from '../config.js';

/** Card files are deliberately bounded before they reach the filesystem. */
export const DEFAULT_MAX_CARD_BYTES = 1024 * 1024;

/** A temp file older than two lease TTLs is safe to consider abandoned. */
export const DEFAULT_ABANDONED_TEMP_AGE_MS = 2 * 90_000;

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

export type WindowsAclProtector = (
  target: string,
  kind: 'directory' | 'file',
) => void | Promise<void>;

export interface PrivateFilesystemOptions {
  readonly platform?: NodeJS.Platform;
  readonly uid?: number;
  /** Override the platform ACL operation in tests or an embedding host. */
  readonly windowsAcl?: WindowsAclProtector;
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
const writeLocks = new Map<string, Promise<unknown>>();

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
  const identity = safeComponent(runtimeInstanceId, 'runtimeInstanceId');
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

async function withWriteLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = writeLocks.get(key) ?? Promise.resolve();
  const current = previous.then(operation, operation);
  writeLocks.set(key, current);
  try {
    return await current;
  } finally {
    if (writeLocks.get(key) === current) {
      writeLocks.delete(key);
    }
  }
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
  const identity = safeComponent(runtimeInstanceId, 'runtimeInstanceId');
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

  return withWriteLock(target.finalPath, async () => {
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
  });
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
  const runtimeIdentity =
    options.runtimeInstanceId === undefined
      ? undefined
      : safeComponent(options.runtimeInstanceId, 'runtimeInstanceId');

  let directoryStats;
  try {
    directoryStats = await lstat(directory);
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

  const names = await readdir(directory);
  let removed = 0;
  for (const name of names) {
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
      first = await lstat(path);
    } catch (error) {
      if (isMissing(error)) {
        continue;
      }
      throw error;
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
      second = await lstat(path);
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

    try {
      await unlink(path);
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
