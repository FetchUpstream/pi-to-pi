import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { createHash } from 'node:crypto';

/** The room-id format version. A future incompatible contract must use another prefix. */
export const ROOM_ID_VERSION = 'r1';

/** Prefix applied to every room id. */
export const ROOM_ID_PREFIX = `${ROOM_ID_VERSION}-`;

/** Maximum number of Unicode code points in a normalized explicit project label. */
export const MAX_PROJECT_LABEL_CODE_POINTS = 48;

/** Alias retained for callers that use length terminology for the code-point bound. */
export const MAX_PROJECT_LABEL_LENGTH = MAX_PROJECT_LABEL_CODE_POINTS;

const ROOM_ID_HEX_LENGTH = 32;
const ROOM_ID_PATTERN = new RegExp(`^${ROOM_ID_PREFIX}[0-9a-f]{${ROOM_ID_HEX_LENGTH}}$`, 'u');
const CONTROL_CHARACTER_PATTERN = /[\p{Cc}\p{Cf}]/u;
const LETTER_OR_NUMBER_PATTERN = /[\p{L}\p{N}]/u;
const SAFE_STORAGE_KEY_PATTERN = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}$/u;
const WINDOWS_RESERVED_STORAGE_KEY_PATTERN = /^(?:CON|PRN|AUX|NUL|COM[0-9]|LPT[0-9])(?:\.|$)/iu;

/** Canonical discriminators used in room hashing and automatic resolution. */
export type CanonicalRoomSource = 'explicit' | 'git' | 'cwd';

/** Legacy source names retained for the identity foundation compatibility seam. */
export type LegacyRoomSource = 'explicit-project' | 'git-common-directory' | 'working-directory';

/** Source used to derive a room; legacy names are accepted only by compatibility models. */
export type RoomSource = CanonicalRoomSource | LegacyRoomSource;
/** A normalized project label is safe to use as a logical value, not as a path. */
export type NormalizedProjectLabel = string & {
  readonly __normalizedProjectLabel: unique symbol;
};

/** A validated, opaque room identifier. */
export type RoomId = string & {
  readonly __roomId: unique symbol;
};

/** A canonical directory resolver, injectable for deterministic unit tests. */
export type RealpathResolver = (path: string) => string;

/**
 * A Git runner receives a canonical cwd and the exact argument vector used by the
 * implementation. It may throw when Git is unavailable or the cwd is not a repo;
 * callers then receive the cwd fallback.
 */
export type GitCommonDirectoryRunner = (cwd: string, args: readonly string[]) => string;

/** Options for automatic and explicit room resolution. */
export interface RoomDerivationOptions {
  /** Explicit `--p2p-project` label. It takes precedence over all path discovery. */
  readonly project?: string;
  /** Verbose alias for `project`, useful at integration boundaries. */
  readonly explicitProject?: string;
  /** Working directory to resolve; defaults to `process.cwd()`. */
  readonly cwd?: string;
  /** Override Git invocation for tests or an embedding runtime. */
  readonly gitRunner?: GitCommonDirectoryRunner;
  /** Alias for `gitRunner` retained for integration callers. */
  readonly runGit?: GitCommonDirectoryRunner;
  /** Override realpath canonicalization for tests or an embedding runtime. */
  readonly realpath?: RealpathResolver;
}

/** Options specific to Git common-directory discovery. */
export interface GitCommonDirectoryOptions {
  readonly gitRunner?: GitCommonDirectoryRunner;
  readonly runGit?: GitCommonDirectoryRunner;
  readonly realpath?: RealpathResolver;
}

/** Metadata returned by automatic room resolution in addition to the opaque room id. */
export interface ResolvedRoom {
  readonly roomId: RoomId;
  readonly source: CanonicalRoomSource;
  /** Normalized project label for `explicit`, canonical absolute path otherwise. */
  readonly value: string;
}

/** Legacy resolved-room model retained for the identity foundation compatibility seam. */
export interface LegacyResolvedRoom {
  readonly id: RoomId;
  readonly source: RoomSource;
  readonly input: string;
}
/** A room id or an object carrying one, accepted by exact-room helpers. */
export type RoomLike =
  RoomId | string | { readonly roomId: RoomId | string } | { readonly id: RoomId | string };
export interface RoomIdentity {
  readonly roomId: RoomId;
  readonly storageKey: string;
}

export interface RoomIdentityValidationIssue {
  readonly field: 'roomId' | 'storageKey' | '$';
  readonly message: string;
}

export interface RoomIdentityValidationResult {
  readonly valid: boolean;
  readonly value?: RoomIdentity;
  readonly errors: readonly RoomIdentityValidationIssue[];
}

/** Thrown when a canonical room/storage identity is malformed. */
export class InvalidRoomIdentityError extends TypeError {
  public readonly errors: readonly RoomIdentityValidationIssue[];

  public constructor(errors: readonly RoomIdentityValidationIssue[]) {
    super(errors.map((error) => `${error.field}: ${error.message}`).join('; '));
    this.name = 'InvalidRoomIdentityError';
    this.errors = errors;
  }
}

/** Thrown when an explicit project label cannot become a valid normalized label. */
export class InvalidProjectLabelError extends TypeError {
  public constructor(message: string) {
    super(message);
    this.name = 'InvalidProjectLabelError';
  }
}

/** Thrown when a value does not satisfy the opaque room-id contract. */
export class InvalidRoomIdError extends TypeError {
  public constructor(value: unknown) {
    super(`Invalid room ID: ${String(value)}`);
    this.name = 'InvalidRoomIdError';
  }
}

/** Thrown when a target belongs to a different room than the current runtime. */
export class RoomIsolationError extends Error {
  public readonly currentRoom: string;
  public readonly targetRoom: string;

  public constructor(currentRoom: string, targetRoom: string) {
    super(`Cross-room target rejected: ${targetRoom} (current room: ${currentRoom})`);
    this.name = 'RoomIsolationError';
    this.currentRoom = currentRoom;
    this.targetRoom = targetRoom;
  }
}

/** Compatibility name for integrations that call a cross-room failure a mismatch. */
export { RoomIsolationError as CrossRoomError };

/** The exact, immutable argument vector used by the non-shell Git invocation. */
export const GIT_COMMON_DIRECTORY_ARGS = Object.freeze([
  'rev-parse',
  '--path-format=absolute',
  '--git-common-dir',
] as const);
function defaultRealpath(path: string): string {
  return realpathSync(path);
}

function defaultGitRunner(cwd: string, args: readonly string[]): string {
  const output = execFileSync('git', [...args], {
    cwd,
    encoding: 'utf8',
    shell: false,
    stdio: ['ignore', 'pipe', 'ignore'],
  });

  return output;
}

function getRealpathResolver(resolver?: RealpathResolver): RealpathResolver {
  return resolver ?? defaultRealpath;
}

function getGitRunner(options: GitCommonDirectoryOptions): GitCommonDirectoryRunner {
  return options.gitRunner ?? options.runGit ?? defaultGitRunner;
}

function getExplicitProject(options: RoomDerivationOptions): string | undefined {
  if (
    options.project !== undefined &&
    options.explicitProject !== undefined &&
    options.project !== options.explicitProject
  ) {
    throw new InvalidProjectLabelError(
      'project and explicitProject were both supplied with different values',
    );
  }

  return options.explicitProject ?? options.project;
}

/**
 * Normalize an explicit project label according to the room contract.
 *
 * NFKC and lowercase are applied first. Unicode letters and numbers are kept;
 * every other non-control code point becomes one separator hyphen. Separators
 * collapse and are trimmed, and the result is bounded by Unicode code points.
 */
export function normalizeProjectLabel(value: string): NormalizedProjectLabel {
  if (typeof value !== 'string') {
    throw new InvalidProjectLabelError('project label must be a string');
  }

  let normalized: string;
  try {
    normalized = value.normalize('NFKC').toLowerCase();
  } catch {
    throw new InvalidProjectLabelError('project label is not valid Unicode text');
  }

  if (CONTROL_CHARACTER_PATTERN.test(value) || CONTROL_CHARACTER_PATTERN.test(normalized)) {
    throw new InvalidProjectLabelError('project label contains a control character');
  }

  const output: string[] = [];
  let pendingSeparator = false;

  for (const codePoint of normalized) {
    if (LETTER_OR_NUMBER_PATTERN.test(codePoint)) {
      if (pendingSeparator && output.length > 0) {
        output.push('-');
      }
      output.push(codePoint);
      pendingSeparator = false;
    } else if (output.length > 0) {
      pendingSeparator = true;
    }
  }

  const bounded = output.slice(0, MAX_PROJECT_LABEL_CODE_POINTS);
  while (bounded.at(-1) === '-') {
    bounded.pop();
  }

  if (bounded.length === 0) {
    throw new InvalidProjectLabelError('project label is empty after normalization');
  }

  return bounded.join('') as NormalizedProjectLabel;
}

/** Alias for callers that use the shorter project terminology. */
export const normalizeProject = normalizeProjectLabel;

/** Alias for callers that use name terminology at a configuration boundary. */
export const normalizeProjectName = normalizeProjectLabel;

/** Return whether a value is a valid filesystem-safe opaque room id. */
export function isValidRoomId(value: unknown): value is RoomId {
  return typeof value === 'string' && ROOM_ID_PATTERN.test(value);
}

/** Descriptive alias for callers that distinguish canonical from legacy ids. */
export function isCanonicalRoomId(value: unknown): value is RoomId {
  return isValidRoomId(value);
}

/** Return whether a value is safe as one cross-platform room directory component. */
export function isSafeStorageKey(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    SAFE_STORAGE_KEY_PATTERN.test(value) &&
    !value.endsWith('.') &&
    !value.endsWith(' ') &&
    !WINDOWS_RESERVED_STORAGE_KEY_PATTERN.test(value) &&
    !CONTROL_CHARACTER_PATTERN.test(value)
  );
}

/** Validate a canonical room id and its already-derived filesystem key. */
export function validateRoomIdentity(value: unknown): RoomIdentityValidationResult {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return {
      valid: false,
      errors: [{ field: '$', message: 'room identity must be an object' }],
    };
  }

  const candidate = value as { readonly roomId?: unknown; readonly storageKey?: unknown };
  const errors: RoomIdentityValidationIssue[] = [];
  if (!isCanonicalRoomId(candidate.roomId)) {
    errors.push({ field: 'roomId', message: 'must be a canonical r1 room id' });
  }
  if (!isSafeStorageKey(candidate.storageKey)) {
    errors.push({ field: 'storageKey', message: 'must be a safe filesystem component' });
  }
  if (errors.length > 0) {
    return { valid: false, errors };
  }

  return {
    valid: true,
    value: value as RoomIdentity,
    errors: [],
  };
}

/** Return whether a value carries a valid canonical room/storage identity. */
export function isRoomIdentity(value: unknown): value is RoomIdentity {
  return validateRoomIdentity(value).valid;
}

/** Assert and return a canonical room/storage identity. */
export function assertRoomIdentity(value: unknown): RoomIdentity {
  const result = validateRoomIdentity(value);
  if (!result.valid || result.value === undefined) {
    throw new InvalidRoomIdentityError(result.errors);
  }
  return result.value;
}

/** Validate and brand a room id before it is used for lookup or path construction. */
export function assertValidRoomId(value: string): RoomId {
  if (!isValidRoomId(value)) {
    throw new InvalidRoomIdError(value);
  }

  return value;
}

/** Compatibility alias for validation-oriented callers. */
export const validateRoomId = assertValidRoomId;

/** Return whether a value satisfies the legacy room-id model. */
export function isRoomId(value: unknown): value is RoomId {
  return isValidRoomId(value);
}

/** Brand a room id for identity and protocol-address boundaries. */
export function asRoomId(value: string): RoomId {
  return assertValidRoomId(value);
}

/** Construct the legacy resolved-room model without deriving or allocating resources. */
export function createResolvedRoom(
  id: RoomId | string,
  source: RoomSource,
  input: string,
): LegacyResolvedRoom {
  return Object.freeze({ id: asRoomId(id), source, input });
}
function assertRoomHashInput(value: string): void {
  if (typeof value !== 'string') {
    throw new TypeError('room hash input must be a string');
  }

  if (value.length === 0) {
    throw new TypeError('room hash input must not be empty');
  }

  if (value.includes('\u0000')) {
    throw new TypeError('room hash input must not contain NUL');
  }
}

function assertRoomSource(source: CanonicalRoomSource): void {
  if (source !== 'explicit' && source !== 'git' && source !== 'cwd') {
    throw new TypeError(`unsupported room source: ${String(source)}`);
  }
}

/**
 * Hash a source discriminator and already-normalized value into a versioned
 * opaque id. The first 128 bits of SHA-256 are rendered as lowercase hex.
 */
export function hashRoomId(source: CanonicalRoomSource, normalizedValue: string): RoomId {
  assertRoomSource(source);
  assertRoomHashInput(normalizedValue);

  const digest = createHash('sha256')
    .update(`${source}\u0000${normalizedValue}`, 'utf8')
    .digest('hex')
    .slice(0, ROOM_ID_HEX_LENGTH);

  return `${ROOM_ID_PREFIX}${digest}` as RoomId;
}

/**
 * Derive a room id from a source and value.
 *
 * Explicit labels use the shared label normalizer; automatic Git and cwd inputs
 * are canonicalized through realpath before hashing so equivalent paths converge.
 */
export function deriveRoomId(source: CanonicalRoomSource, value: string): RoomId;
/** Derive the room id selected by the complete precedence chain. */
export function deriveRoomId(options?: RoomDerivationOptions): RoomId;
export function deriveRoomId(
  sourceOrOptions: CanonicalRoomSource | RoomDerivationOptions = {},
  value?: string,
): RoomId {
  if (typeof sourceOrOptions === 'string') {
    if (value === undefined) {
      throw new TypeError('room value is required when a source is provided');
    }

    const normalizedValue =
      sourceOrOptions === 'explicit' ? normalizeProjectLabel(value) : canonicalizeDirectory(value);
    return hashRoomId(sourceOrOptions, normalizedValue);
  }

  return resolveRoom(sourceOrOptions).roomId;
}

/** Derive an explicit-project room id after label normalization. */
export function deriveExplicitRoomId(project: string): RoomId {
  return hashRoomId('explicit', normalizeProjectLabel(project));
}

/** Derive a Git room id after canonicalizing the common directory. */
export function deriveGitRoomId(commonDirectory: string): RoomId {
  return hashRoomId('git', canonicalizeDirectory(commonDirectory));
}

/** Derive a working-directory room id after canonicalization. */
export function deriveWorkingDirectoryRoomId(directory: string): RoomId {
  return hashRoomId('cwd', canonicalizeDirectory(directory));
}

/** Canonicalize an existing directory path with realpath. */
export function canonicalizeDirectory(
  directory = process.cwd(),
  resolver: RealpathResolver = defaultRealpath,
): string {
  if (typeof directory !== 'string' || directory.length === 0) {
    throw new TypeError('working directory must be a non-empty string');
  }
  if (directory.includes('\u0000')) {
    throw new TypeError('working directory must not contain NUL');
  }

  const absolute = resolve(directory);
  const canonical = resolver(absolute);
  if (!isAbsolute(canonical)) {
    return resolve(canonical);
  }

  return canonical;
}

function stripGitOutputLineEnding(output: string): string {
  return output.endsWith('\n') ? output.slice(0, -1).replace(/\r$/u, '') : output;
}

/**
 * Discover and canonicalize the Git common directory for a working directory.
 * Returns undefined for unavailable Git, non-repositories, malformed output, or
 * an unresolvable common directory; callers then use canonical cwd.
 */
export function discoverGitCommonDirectory(
  directory = process.cwd(),
  options: GitCommonDirectoryOptions = {},
): string | undefined {
  const resolver = getRealpathResolver(options.realpath);
  const canonicalCwd = canonicalizeDirectory(directory, resolver);
  const runner = getGitRunner(options);

  let output: string;
  try {
    output = runner(canonicalCwd, GIT_COMMON_DIRECTORY_ARGS);
  } catch {
    return undefined;
  }

  if (typeof output !== 'string') {
    return undefined;
  }

  const rawCommonDirectory = stripGitOutputLineEnding(output);
  if (rawCommonDirectory.length === 0 || rawCommonDirectory.includes('\u0000')) {
    return undefined;
  }

  try {
    const absoluteCommonDirectory = isAbsolute(rawCommonDirectory)
      ? rawCommonDirectory
      : resolve(canonicalCwd, rawCommonDirectory);
    return resolver(absoluteCommonDirectory);
  } catch {
    return undefined;
  }
}

/** Alias for callers that spell the Git operation as a getter. */
export const getGitCommonDirectory = discoverGitCommonDirectory;

/**
 * Resolve one room using explicit project, Git common directory, then cwd.
 * The returned source and value make precedence observable without exposing a
 * raw project label or path as a registry identifier.
 */
export function resolveRoom(options: RoomDerivationOptions = {}): ResolvedRoom {
  const explicitProject = getExplicitProject(options);
  if (explicitProject !== undefined) {
    const normalizedProject = normalizeProjectLabel(explicitProject);
    return Object.freeze({
      roomId: hashRoomId('explicit', normalizedProject),
      source: 'explicit',
      value: normalizedProject,
    });
  }

  const resolver = getRealpathResolver(options.realpath);
  const canonicalCwd = canonicalizeDirectory(options.cwd, resolver);
  const commonDirectory = discoverGitCommonDirectory(canonicalCwd, {
    gitRunner: options.gitRunner,
    runGit: options.runGit,
    realpath: resolver,
  });

  if (commonDirectory !== undefined) {
    return Object.freeze({
      roomId: hashRoomId('git', commonDirectory),
      source: 'git',
      value: commonDirectory,
    });
  }

  return Object.freeze({
    roomId: hashRoomId('cwd', canonicalCwd),
    source: 'cwd',
    value: canonicalCwd,
  });
}

/** Resolve and return only the opaque room id. */
export function deriveRoom(options: RoomDerivationOptions = {}): RoomId {
  return resolveRoom(options).roomId;
}

/** Alias for id-only resolution at registry/discovery boundaries. */
export const resolveRoomId = deriveRoom;

function extractRoomId(room: RoomLike): string {
  if (typeof room === 'string') {
    return room;
  }

  if (room !== null && typeof room === 'object') {
    if ('roomId' in room) {
      return room.roomId;
    }
    if ('id' in room) {
      return room.id;
    }
  }
  return '';
}

/** Compare two rooms using validated, exact opaque ids. */
export function roomsEqual(left: RoomLike, right: RoomLike): boolean {
  const leftRoom = extractRoomId(left);
  const rightRoom = extractRoomId(right);
  return isValidRoomId(leftRoom) && isValidRoomId(rightRoom) && leftRoom === rightRoom;
}

/** Exact-room comparison alias used by discovery callers. */
export const isSameRoom = roomsEqual;

/** Validate that a target is in the current room; never falls back cross-room. */
export function assertExactRoom(currentRoom: RoomLike, targetRoom: RoomLike): RoomId {
  const current = assertValidRoomId(extractRoomId(currentRoom));
  const target = assertValidRoomId(extractRoomId(targetRoom));

  if (current !== target) {
    throw new RoomIsolationError(current, target);
  }

  return target;
}

/** Alias emphasizing target validation at protocol boundaries. */
export const assertSameRoom = assertExactRoom;

/** Alias for target-validation call sites. */
export const validateTargetRoom = assertExactRoom;
