import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { isAbsolute, resolve } from 'node:path';
import { realpathSync } from 'node:fs';

import { asRoomId, type RoomId } from './protocol/messages.js';

export type { RoomId } from './protocol/messages.js';

/** Room derivation sources are part of the hash domain and must not be mixed. */
export type RoomSource = 'explicit' | 'git' | 'cwd';

/** Compatibility input accepted by derivation helpers; `project` maps to `explicit`. */
export type RoomSourceInput = RoomSource | 'project';

/** A room storage key is the validated opaque room ID used as its registry path component. */
export type RoomStorageKey = RoomId;

/** A room identity plus the canonical value from which it was derived. */
export interface RoomIdentity {
  readonly roomId: RoomId;
  readonly source: RoomSource;
  readonly value: string;
  /** Safe registry path component; it is deliberately the validated opaque room ID. */
  readonly storageKey: RoomStorageKey;
}

/** Local room-resolution options; no discovery, registry, or transport dependency is required. */
export interface RoomResolutionOptions {
  /** Explicit `--p2p-project` label. Empty labels are rejected rather than falling back. */
  readonly project?: string | null;
  /** Working directory used for Git discovery and fallback. */
  readonly workingDirectory?: string;
  /** Optional test/adapter override. `null` explicitly means Git discovery failed. */
  readonly gitCommonDirectory?: string | null;
  /** Optional injectable Git resolver for deterministic tests. */
  readonly gitCommonDirectoryResolver?: (workingDirectory: string) => string | undefined;
}

/** Error raised for malformed room labels, paths, or room IDs. */
export class RoomInputError extends TypeError {
  constructor(message: string) {
    super(message);
    this.name = 'RoomInputError';
  }
}

/** Error used by routing/discovery callers when two room IDs differ exactly. */
export class CrossRoomError extends Error {
  readonly code = 'cross_room' as const;
  readonly expectedRoomId: RoomId;
  readonly actualRoomId: RoomId;

  constructor(expectedRoomId: RoomId, actualRoomId: RoomId) {
    super('room identity does not match');
    this.name = 'CrossRoomError';
    this.expectedRoomId = expectedRoomId;
    this.actualRoomId = actualRoomId;
  }
}

export const ROOM_ID_PREFIX = 'r1-';
export const ROOM_ID_HEX_LENGTH = 32;
export const ROOM_ID_PATTERN = new RegExp(`^${ROOM_ID_PREFIX}[0-9a-f]{${ROOM_ID_HEX_LENGTH}}$`);

const CONTROL_CHARACTER_PATTERN = /\p{C}/u;
const ROOM_LABEL_CHARACTER_PATTERN = /[\p{L}\p{N}\p{M}]/u;
const ROOM_SOURCES: readonly RoomSource[] = ['explicit', 'git', 'cwd'];

function requireString(value: string, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new RoomInputError(`${field} must be a non-empty string`);
  }

  if (CONTROL_CHARACTER_PATTERN.test(value)) {
    throw new RoomInputError(`${field} must not contain control characters`);
  }

  return value;
}

function canonicalSource(source: RoomSourceInput): RoomSource {
  if (source === 'project') {
    return 'explicit';
  }

  if (!ROOM_SOURCES.includes(source)) {
    throw new RoomInputError(`unsupported room source: ${String(source)}`);
  }

  return source;
}

/**
 * Normalize a project label into the stable room-label representation.
 *
 * NFKC and lowercase make equivalent labels converge. Unicode letters,
 * numbers, and combining marks are retained; whitespace, punctuation, and
 * symbols become a single separator. Control characters and empty results are
 * rejected so an explicit invalid project never selects a default room.
 */
export function normalizeRoomLabel(label: string): string {
  requireString(label, 'project');
  const normalized = label.normalize('NFKC').toLowerCase();
  const result: string[] = [];
  let separatorPending = false;

  for (const character of normalized) {
    if (CONTROL_CHARACTER_PATTERN.test(character)) {
      throw new RoomInputError('project must not contain control characters');
    }

    if (ROOM_LABEL_CHARACTER_PATTERN.test(character)) {
      if (separatorPending && result.length > 0) {
        result.push('-');
      }
      result.push(character);
      separatorPending = false;
    } else {
      separatorPending = result.length > 0;
    }
  }

  const value = result.join('');
  if (value.length === 0) {
    throw new RoomInputError('project must contain at least one letter or number');
  }

  return value;
}

/** Explicit name for callers handling `--p2p-project`. */
export const normalizeProjectLabel = normalizeRoomLabel;

/** Return whether a value is a valid opaque room ID and safe registry key. */
export function isRoomId(value: unknown): value is RoomId {
  return typeof value === 'string' && ROOM_ID_PATTERN.test(value);
}

function requireValidRoomId(value: unknown): RoomId {
  if (!isRoomId(value)) {
    throw new RoomInputError('roomId must be a valid r1 room ID');
  }

  return value;
}

function requireRoomValue(value: string, field: string): string {
  return requireString(value, field);
}

function roomIdFromSource(source: RoomSource, value: string): RoomId {
  const digest = createHash('sha256')
    .update(`${source}\0${value}`, 'utf8')
    .digest('hex')
    .slice(0, ROOM_ID_HEX_LENGTH);
  return requireValidRoomId(asRoomId(`${ROOM_ID_PREFIX}${digest}`));
}

/**
 * Derive an opaque room ID from a source discriminator and canonical value.
 *
 * The source discriminator is intentionally part of the hash domain: an
 * explicit label can never accidentally share an ID with a path having the
 * same text. Explicit labels are normalized; Git and cwd values must already
 * be canonical paths when this low-level helper is called.
 */
export function deriveRoomId(source: RoomSourceInput, value: string): RoomId;
export function deriveRoomId(input: { source: RoomSourceInput; value: string }): RoomId;
export function deriveRoomId(
  sourceOrInput: RoomSourceInput | { source: RoomSourceInput; value: string },
  value?: string,
): RoomId {
  const source =
    typeof sourceOrInput === 'string'
      ? canonicalSource(sourceOrInput)
      : canonicalSource(sourceOrInput.source);
  const rawValue = typeof sourceOrInput === 'string' ? value : sourceOrInput.value;
  if (rawValue === undefined) {
    throw new RoomInputError('room derivation value is required');
  }

  const normalizedValue =
    source === 'explicit'
      ? normalizeRoomLabel(rawValue)
      : requireRoomValue(rawValue, 'room source value');
  return roomIdFromSource(source, normalizedValue);
}

function makeRoomIdentity(source: RoomSource, value: string): RoomIdentity {
  const roomId = roomIdFromSource(source, value);
  return Object.freeze({ roomId, source, value, storageKey: roomStorageKey(roomId) });
}

/** Derive a room identity from a source and canonical value. */
export function deriveRoomIdentity(source: RoomSourceInput, value: string): RoomIdentity;
export function deriveRoomIdentity(input: { source: RoomSourceInput; value: string }): RoomIdentity;
export function deriveRoomIdentity(
  sourceOrInput: RoomSourceInput | { source: RoomSourceInput; value: string },
  value?: string,
): RoomIdentity {
  const source =
    typeof sourceOrInput === 'string'
      ? canonicalSource(sourceOrInput)
      : canonicalSource(sourceOrInput.source);
  const rawValue = typeof sourceOrInput === 'string' ? value : sourceOrInput.value;
  if (rawValue === undefined) {
    throw new RoomInputError('room derivation value is required');
  }

  const normalizedValue =
    source === 'explicit'
      ? normalizeRoomLabel(rawValue)
      : requireRoomValue(rawValue, 'room source value');
  return makeRoomIdentity(source, normalizedValue);
}

/** Derive the explicit project room; project labels are never treated as paths. */
export function deriveExplicitRoom(project: string): RoomIdentity {
  return deriveRoomIdentity('explicit', project);
}

/** Alias used by project-oriented callers. */
export const deriveProjectRoom = deriveExplicitRoom;
export const deriveRoomFromProject = deriveExplicitRoom;

function canonicalizePath(pathValue: string, baseDirectory: string): string {
  requireString(pathValue, 'path');
  requireString(baseDirectory, 'base directory');

  try {
    const absolutePath = isAbsolute(pathValue) ? pathValue : resolve(baseDirectory, pathValue);
    return realpathSync(absolutePath);
  } catch {
    throw new RoomInputError(`unable to canonicalize path: ${pathValue}`);
  }
}

/** Canonicalize an existing directory, resolving equivalent spellings and symlinks. */
export function canonicalWorkingDirectory(workingDirectory = process.cwd()): string {
  return canonicalizePath(workingDirectory, process.cwd());
}

/**
 * Discover and canonicalize Git's common directory without invoking a shell.
 * Returns undefined for a non-Git directory, unavailable Git, or an invalid
 * command result so callers can use the cwd fallback.
 */
export function discoverGitCommonDirectory(workingDirectory = process.cwd()): string | undefined {
  const canonicalDirectory = canonicalWorkingDirectory(workingDirectory);
  let output: string;

  try {
    output = execFileSync('git', ['-C', canonicalDirectory, 'rev-parse', '--git-common-dir'], {
      cwd: canonicalDirectory,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return undefined;
  }

  const commonDirectory = output.trim();
  if (commonDirectory.length === 0) {
    return undefined;
  }

  try {
    return canonicalizePath(commonDirectory, canonicalDirectory);
  } catch {
    return undefined;
  }
}

/** Explicit alias for registry/discovery adapters. */
export const canonicalGitCommonDirectory = discoverGitCommonDirectory;

/** Derive a room from an already canonical (or canonicalizable) Git common directory. */
export function deriveGitRoom(commonDirectory: string): RoomIdentity {
  const canonicalDirectory = canonicalizePath(commonDirectory, process.cwd());
  return deriveRoomIdentity('git', canonicalDirectory);
}

/** Alias for callers that name the derivation source explicitly. */
export const deriveRoomFromGit = deriveGitRoom;

/** Derive a room from an already canonical (or canonicalizable) working directory. */
export function deriveWorkingDirectoryRoom(workingDirectory: string): RoomIdentity {
  const canonicalDirectory = canonicalWorkingDirectory(workingDirectory);
  return deriveRoomIdentity('cwd', canonicalDirectory);
}

/** Alias for callers that name the derivation source explicitly. */
export const deriveRoomFromWorkingDirectory = deriveWorkingDirectoryRoom;

/** Resolve one room using explicit project, Git common directory, then cwd fallback. */
export function resolveRoomIdentity(options: RoomResolutionOptions = {}): RoomIdentity {
  if (options.project !== undefined && options.project !== null) {
    return deriveExplicitRoom(options.project);
  }

  const workingDirectory = canonicalWorkingDirectory(options.workingDirectory ?? process.cwd());
  let commonDirectory: string | undefined;

  if (options.gitCommonDirectory !== undefined) {
    commonDirectory = options.gitCommonDirectory ?? undefined;
  } else if (options.gitCommonDirectoryResolver !== undefined) {
    try {
      commonDirectory = options.gitCommonDirectoryResolver(workingDirectory);
    } catch {
      commonDirectory = undefined;
    }
  } else {
    commonDirectory = discoverGitCommonDirectory(workingDirectory);
  }

  if (commonDirectory !== undefined && commonDirectory.length > 0) {
    try {
      return deriveRoomIdentity('git', canonicalizePath(commonDirectory, workingDirectory));
    } catch {
      // A failed Git result is equivalent to Git being unavailable.
    }
  }

  return deriveRoomIdentity('cwd', workingDirectory);
}

/** Return only the canonical room ID for callers that do not need provenance. */
export function resolveRoomId(options: RoomResolutionOptions = {}): RoomId {
  return resolveRoomIdentity(options).roomId;
}

/** Short alias for room-resolution integrations. */
export const resolveRoom = resolveRoomIdentity;

export type RoomReference = RoomId | Pick<RoomIdentity, 'roomId'>;

function roomIdOf(reference: RoomReference): RoomId {
  const candidate =
    typeof reference === 'string'
      ? reference
      : reference !== null && typeof reference === 'object'
        ? reference.roomId
        : undefined;
  return requireValidRoomId(candidate);
}

/** Exact room comparison: no normalization, prefix matching, or cross-room fallback. */
export function roomsEqual(left: RoomReference, right: RoomReference): boolean {
  return roomIdOf(left) === roomIdOf(right);
}

export const isSameRoom = roomsEqual;
export const sameRoom = roomsEqual;
export const roomsMatch = roomsEqual;

/** Assert exact room equality before a caller consults discovery, routing, or deduplication state. */
export function assertSameRoom(expected: RoomReference, actual: RoomReference): void {
  const expectedRoomId = roomIdOf(expected);
  const actualRoomId = roomIdOf(actual);
  if (expectedRoomId !== actualRoomId) {
    throw new CrossRoomError(expectedRoomId, actualRoomId);
  }
}

/** Alias emphasizing the fail-closed room boundary. */
export const requireSameRoom = assertSameRoom;

/** Validate a room ID before using it as a registry path component. */
export function roomStorageKey(roomId: RoomId): RoomStorageKey {
  return requireValidRoomId(roomId);
}
