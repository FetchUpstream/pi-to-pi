import { randomBytes } from 'node:crypto';
import { chmod, lstat, mkdir, open, readdir, readFile, rename, unlink } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import nodePath from 'node:path';

import {
  asNormalizedName,
  asRuntimeId,
  asSessionId,
  type NormalizedName,
  type RuntimeId,
  type RuntimeIdentity,
  type SessionId,
} from '../identity.js';
import { asRoomId, type RoomId, type RoomLike } from '../room.js';
import {
  asPublishedNetworkName,
  isPublishedNetworkName,
  runtimeNameSuffix,
  type PublishedNetworkName,
} from './naming.js';
import {
  DEFAULT_LEASE_RENEWAL_INTERVAL_MS,
  DEFAULT_LEASE_TTL_MS,
  LeaseConfigurationError,
  SerializedLease,
  type LeaseClock,
  type LeaseScheduler,
} from './lease.js';

export { DEFAULT_LEASE_RENEWAL_INTERVAL_MS, DEFAULT_LEASE_TTL_MS };

/** POSIX permissions used for every registry directory. */
export const PRIVATE_DIRECTORY_MODE = 0o700;
/** POSIX permissions used for every registry record and temporary file. */
export const PRIVATE_FILE_MODE = 0o600;
/** Maximum UTF-8 size accepted for one registry record. */
export const MAX_RUNTIME_RECORD_BYTES = 64 * 1024;
/** Registry directory name below the private per-user root. */
export const REGISTRY_ROOMS_DIRECTORY = 'rooms';
/** Runtime record directory name below one room. */
export const REGISTRY_RECORDS_DIRECTORY = 'agents';

const RECORD_FILE_SUFFIX = '.json';
const RECORD_FIELDS = new Set([
  'runtimeId',
  'sessionId',
  'roomId',
  'networkName',
  'endpoint',
  'leaseExpiresAt',
]);
function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f)) {
      return true;
    }
  }
  return false;
}
const RUNTIME_RECORD_FILE_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.json$/u;
const MAX_ENDPOINT_LENGTH = 4096;
export type RegistryClock = LeaseClock;
export type LeaseExpiryInput = number | Date | string;
export type RegistryNetworkName = NormalizedName | PublishedNetworkName;

/** The validated, machine-actionable runtime registry record. */
export interface RuntimeRecord {
  readonly runtimeId: RuntimeId;
  readonly sessionId: SessionId;
  readonly roomId: RoomId;
  /** A canonical base-only or full published network label. */
  readonly networkName: RegistryNetworkName;
  /** Opaque local transport endpoint address. */
  readonly endpoint: string;
  /** Epoch milliseconds at which this record ceases to be live. */
  readonly leaseExpiresAt: number;
}

/** Input accepted by record construction and publication helpers. */
export interface RuntimeRecordDraft {
  readonly identity?: RuntimeIdentity;
  readonly runtimeIdentity?: RuntimeIdentity;
  readonly runtimeId?: RuntimeId | string;
  readonly sessionId?: SessionId | string;
  readonly roomId?: RoomId | string;
  readonly room?: RoomLike;
  readonly networkName?: NormalizedName | string;
  readonly name?: NormalizedName | string;
  readonly endpoint: string;
  readonly leaseExpiresAt?: LeaseExpiryInput;
  readonly now?: number | Date;
  readonly ttlMs?: number;
}

export interface RuntimeRecordValidationIssue {
  readonly field: string;
  readonly message: string;
}

export interface RuntimeRecordValidationOptions {
  readonly expectedRuntimeId?: RuntimeId | string;
  readonly expectedSessionId?: SessionId | string;
  readonly expectedRoomId?: RoomId | string;
  readonly requireUnexpired?: boolean;
  readonly now?: number | Date;
  readonly maxBytes?: number;
}

export interface RuntimeRecordValidationResult {
  readonly valid: boolean;
  readonly record?: RuntimeRecord;
  readonly errors: readonly RuntimeRecordValidationIssue[];
}

/** Inputs selecting a private registry root. */
export interface RegistryRootOptions {
  /** Explicit absolute root, primarily for process tests and embedding hosts. */
  readonly rootDirectory?: string;
  /** Alias retained for callers that call the root a registry root. */
  readonly registryRoot?: string;
  /** Short alias used by focused tests. */
  readonly root?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  readonly homeDirectory?: string;
  readonly temporaryDirectory?: string;
  readonly uid?: number;
}

export interface RegistryPathOptions extends RegistryRootOptions {
  /** Injectable permission owner for deterministic tests. */
  readonly ownerUid?: number;
}

export interface RegistryPaths {
  readonly rootDirectory: string;
  readonly roomsDirectory: string;
  readonly roomDirectory: string;
  readonly recordsDirectory: string;
  /** Alias matching Agent Card terminology used by later integration layers. */
  readonly agentsDirectory: string;
  readonly roomId: RoomId;
}

export interface RuntimeRecordReadOptions extends RegistryPathOptions {
  readonly now?: number | Date;
  readonly requireUnexpired?: boolean;
  readonly maxBytes?: number;
}

export interface RuntimeRecordListOptions extends RuntimeRecordReadOptions {
  /** Remove an expired record only after validating its exact runtime ownership. */
  readonly removeExpired?: boolean;
}

export interface RuntimeRecordCleanupOptions extends RegistryPathOptions {
  readonly expectedSessionId?: SessionId | string;
  readonly expectedEndpoint?: string;
  readonly expectedNetworkName?: NormalizedName | string;
  readonly now?: number | Date;
  /** Permit cleanup of an already expired record even without a probe result. */
  readonly expiredOnly?: boolean;
}

export type EndpointFailureKind =
  | 'missing'
  | 'missing-endpoint'
  | 'not-found'
  | 'refused'
  | 'connection-refused'
  | 'unavailable'
  | 'definitive'
  | 'timeout'
  | 'timed-out';

export interface EndpointFailureOptions extends RuntimeRecordCleanupOptions {
  readonly failure?: EndpointFailureKind | { readonly code?: string; readonly name?: string };
  readonly kind?: EndpointFailureKind | { readonly code?: string; readonly name?: string };
}

export interface RuntimeRegistryOptions extends RegistryPathOptions {
  readonly identity?: RuntimeIdentity;
  readonly runtimeIdentity?: RuntimeIdentity;
  readonly runtimeId?: RuntimeId | string;
  readonly sessionId?: SessionId | string;
  readonly roomId?: RoomId | string;
  readonly room?: RoomLike;
  readonly networkName?: NormalizedName | string;
  readonly name?: NormalizedName | string;
  readonly endpoint: string;
  readonly ttlMs?: number;
  readonly renewalIntervalMs?: number;
  readonly clock?: RegistryClock;
  /** Alias for `clock`; may also be a fixed value in deterministic tests. */
  readonly now?: RegistryClock | number | Date;
  readonly scheduler?: LeaseScheduler;
  readonly onLeaseError?: (error: unknown) => void;
}

export class RuntimeRecordValidationError extends TypeError {
  public readonly errors: readonly RuntimeRecordValidationIssue[];

  public constructor(errors: readonly RuntimeRecordValidationIssue[]) {
    super(errors.map((error) => `${error.field}: ${error.message}`).join('; '));
    this.name = 'RuntimeRecordValidationError';
    this.errors = errors;
  }
}

export class RegistryPathError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'RegistryPathError';
  }
}

export class RuntimeRegistryError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'RuntimeRegistryError';
  }
}

function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String(error.code)
    : undefined;
}

function isMissing(error: unknown): boolean {
  return errorCode(error) === 'ENOENT';
}

function safeDuration(value: number | undefined, fallback: number, label: string): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result <= 0) {
    throw new RuntimeRegistryError(`${label} must be a positive safe integer`);
  }
  return result;
}

function timestamp(value: number | Date | string, field: string): number {
  const result =
    value instanceof Date ? value.getTime() : typeof value === 'string' ? Date.parse(value) : value;
  if (!Number.isFinite(result) || !Number.isSafeInteger(result) || result < 0) {
    throw new RuntimeRecordValidationError([{ field, message: 'must be a finite timestamp' }]);
  }
  return result;
}

function nowValue(value: number | Date | undefined): number {
  return timestamp(value ?? Date.now(), 'now');
}

function clockFrom(value: RegistryClock | number | Date | undefined): RegistryClock {
  if (typeof value === 'function') {
    return () => nowValue(value());
  }
  const fixed = value === undefined ? undefined : nowValue(value);
  return fixed === undefined ? () => nowValue(Date.now()) : () => fixed;
}

function assertText(value: unknown, field: string, maxLength: number): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maxLength ||
    value.trim() !== value ||
    hasControlCharacter(value)
  ) {
    throw new RuntimeRecordValidationError([
      { field, message: `must be bounded non-empty text of at most ${maxLength} characters` },
    ]);
  }
  return value;
}

function canonicalNetworkName(value: unknown, runtimeId: RuntimeId): RegistryNetworkName {
  if (typeof value !== 'string') {
    throw new TypeError('network name must be text');
  }
  if (isPublishedNetworkName(value)) {
    const published = asPublishedNetworkName(value);
    const separator = published.lastIndexOf('-');
    if (published.slice(separator + 1) !== runtimeNameSuffix(runtimeId)) {
      throw new TypeError('network name suffix must match runtime ID');
    }
    return published;
  }
  const normalized = asNormalizedName(value);
  if (normalized !== value) {
    throw new TypeError('network name must already be normalized');
  }
  return normalized;
}
function validateRecordFields(
  value: unknown,
  options: RuntimeRecordValidationOptions,
): RuntimeRecord {
  if (!isRecord(value)) {
    throw new RuntimeRecordValidationError([{ field: '$', message: 'must be a JSON object' }]);
  }

  const errors: RuntimeRecordValidationIssue[] = [];
  for (const key of Object.keys(value)) {
    if (!RECORD_FIELDS.has(key)) {
      errors.push({ field: key, message: 'unknown field' });
    }
  }
  for (const field of RECORD_FIELDS) {
    if (!hasOwn(value, field)) {
      errors.push({ field, message: 'required field is missing' });
    }
  }
  if (errors.length > 0) {
    throw new RuntimeRecordValidationError(errors);
  }

  let runtimeId: RuntimeId;
  let sessionId: SessionId;
  let roomId: RoomId;
  let networkName: RegistryNetworkName;
  let endpoint = '';
  let leaseExpiresAt: number;

  if (typeof value.runtimeId !== 'string') {
    errors.push({ field: 'runtimeId', message: 'must be a canonical lowercase full UUID' });
    runtimeId = '' as RuntimeId;
  } else {
    try {
      runtimeId = asRuntimeId(value.runtimeId);
    } catch {
      errors.push({ field: 'runtimeId', message: 'must be a canonical lowercase full UUID' });
      runtimeId = '' as RuntimeId;
    }
  }

  if (typeof value.sessionId !== 'string') {
    errors.push({ field: 'sessionId', message: 'must be a valid Pi native session ID' });
    sessionId = '' as SessionId;
  } else {
    try {
      sessionId = asSessionId(value.sessionId);
    } catch {
      errors.push({ field: 'sessionId', message: 'must be a valid Pi native session ID' });
      sessionId = '' as SessionId;
    }
  }

  if (typeof value.roomId !== 'string') {
    errors.push({ field: 'roomId', message: 'must be an opaque versioned room ID' });
    roomId = '' as RoomId;
  } else {
    try {
      roomId = asRoomId(value.roomId);
    } catch {
      errors.push({ field: 'roomId', message: 'must be an opaque versioned room ID' });
      roomId = '' as RoomId;
    }
  }

  if (typeof value.networkName !== 'string') {
    errors.push({ field: 'networkName', message: 'must be a canonical network name' });
    networkName = '' as RegistryNetworkName;
  } else {
    try {
      networkName = canonicalNetworkName(value.networkName, runtimeId);
    } catch {
      errors.push({ field: 'networkName', message: 'must be a canonical network name' });
      networkName = '' as RegistryNetworkName;
    }
  }

  try {
    endpoint = assertText(value.endpoint, 'endpoint', MAX_ENDPOINT_LENGTH);
  } catch (error) {
    if (error instanceof RuntimeRecordValidationError) {
      errors.push(...error.errors);
    } else {
      errors.push({ field: 'endpoint', message: 'must be valid endpoint text' });
    }
  }

  if (typeof value.leaseExpiresAt !== 'number') {
    errors.push({ field: 'leaseExpiresAt', message: 'must be a finite timestamp number' });
    leaseExpiresAt = 0;
  } else {
    try {
      leaseExpiresAt = timestamp(value.leaseExpiresAt, 'leaseExpiresAt');
    } catch (error) {
      errors.push(
        ...(error instanceof RuntimeRecordValidationError
          ? error.errors
          : [{ field: 'leaseExpiresAt', message: 'must be a finite timestamp' }]),
      );
      leaseExpiresAt = 0;
    }
  }

  const expectedRuntimeId =
    options.expectedRuntimeId === undefined ? undefined : asRuntimeId(options.expectedRuntimeId);
  const expectedSessionId =
    options.expectedSessionId === undefined ? undefined : asSessionId(options.expectedSessionId);
  const expectedRoomId =
    options.expectedRoomId === undefined ? undefined : asRoomId(options.expectedRoomId);
  if (expectedRuntimeId !== undefined && runtimeId !== expectedRuntimeId) {
    errors.push({ field: 'runtimeId', message: 'does not match the expected runtime ID' });
  }
  if (expectedSessionId !== undefined && sessionId !== expectedSessionId) {
    errors.push({ field: 'sessionId', message: 'does not match the expected session ID' });
  }
  if (expectedRoomId !== undefined && roomId !== expectedRoomId) {
    errors.push({ field: 'roomId', message: 'does not match the expected room ID' });
  }
  if (options.requireUnexpired && leaseExpiresAt <= nowValue(options.now)) {
    errors.push({ field: 'leaseExpiresAt', message: 'lease has expired' });
  }

  if (errors.length > 0) {
    throw new RuntimeRecordValidationError(errors);
  }

  return Object.freeze({
    runtimeId,
    sessionId,
    roomId,
    networkName,
    endpoint,
    leaseExpiresAt,
  });
}

/** Validate a decoded record without throwing, suitable for discovery reads. */
export function validateRuntimeRecord(
  value: unknown,
  options: RuntimeRecordValidationOptions = {},
): RuntimeRecordValidationResult {
  try {
    const maxBytes = options.maxBytes ?? MAX_RUNTIME_RECORD_BYTES;
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
      return {
        valid: false,
        errors: [{ field: '$', message: 'maxBytes must be a positive safe integer' }],
      };
    }
    const serialized = JSON.stringify(value);
    if (serialized === undefined || Buffer.byteLength(serialized, 'utf8') > maxBytes) {
      return { valid: false, errors: [{ field: '$', message: 'record exceeds its byte limit' }] };
    }
    return { valid: true, record: validateRecordFields(value, options), errors: [] };
  } catch (error) {
    if (error instanceof RuntimeRecordValidationError) {
      return { valid: false, errors: error.errors };
    }
    return { valid: false, errors: [{ field: '$', message: 'record is malformed' }] };
  }
}

/** Throw unless a value is a complete, canonical runtime record. */
export function assertValidRuntimeRecord(
  value: unknown,
  options: RuntimeRecordValidationOptions = {},
): asserts value is RuntimeRecord {
  const result = validateRuntimeRecord(value, options);
  if (!result.valid || result.record === undefined) {
    throw new RuntimeRecordValidationError(result.errors);
  }
}

/** Type guard for callers that already have an in-memory record. */
export function isRuntimeRecord(value: unknown): value is RuntimeRecord {
  return validateRuntimeRecord(value).valid;
}

/** Parse and validate one JSON record. Malformed input is reported, not thrown. */
export function parseRuntimeRecordJson(
  source: string,
  options: RuntimeRecordValidationOptions = {},
): RuntimeRecordValidationResult {
  if (typeof source !== 'string') {
    return { valid: false, errors: [{ field: '$', message: 'source must be text' }] };
  }
  try {
    return validateRuntimeRecord(JSON.parse(source) as unknown, options);
  } catch {
    return { valid: false, errors: [{ field: '$', message: 'source is not valid JSON' }] };
  }
}

/** Serialize only a validated record, preserving all required ownership fields. */
export function serializeRuntimeRecord(record: unknown): string {
  assertValidRuntimeRecord(record);
  return JSON.stringify(record);
}

function identityFromDraft(draft: RuntimeRecordDraft): {
  readonly runtimeId: RuntimeId;
  readonly sessionId: SessionId;
} {
  const identity = draft.identity ?? draft.runtimeIdentity;
  const runtimeId = draft.runtimeId ?? identity?.runtimeId;
  const sessionId = draft.sessionId ?? identity?.sessionId;
  if (runtimeId === undefined || sessionId === undefined) {
    throw new RuntimeRecordValidationError([
      { field: 'identity', message: 'runtimeId and sessionId are required' },
    ]);
  }
  const brandedRuntimeId = asRuntimeId(runtimeId);
  const brandedSessionId = asSessionId(sessionId);
  if (
    identity &&
    (identity.runtimeId !== brandedRuntimeId || identity.sessionId !== brandedSessionId)
  ) {
    throw new RuntimeRecordValidationError([
      { field: 'identity', message: 'identity fields conflict with explicit runtime/session IDs' },
    ]);
  }
  return { runtimeId: brandedRuntimeId, sessionId: brandedSessionId };
}

function roomIdFromLike(value: RoomLike): RoomId {
  if (typeof value === 'string') {
    return asRoomId(value);
  }
  if ('roomId' in value) {
    return asRoomId(value.roomId);
  }
  return asRoomId(value.id);
}

function resolveRoomId(
  direct: RoomId | string | undefined,
  room: RoomLike | undefined,
): RoomId | undefined {
  const directRoom = direct === undefined ? undefined : asRoomId(direct);
  const objectRoom = room === undefined ? undefined : roomIdFromLike(room);
  if (directRoom !== undefined && objectRoom !== undefined && directRoom !== objectRoom) {
    throw new Error('roomId and room disagree');
  }
  return objectRoom ?? directRoom;
}

/** Construct and validate a record, deriving its initial lease when omitted. */
export function createRuntimeRecord(draft: RuntimeRecordDraft): RuntimeRecord {
  const { runtimeId, sessionId } = identityFromDraft(draft);
  let roomId: RoomId | undefined;
  try {
    roomId = resolveRoomId(draft.roomId, draft.room);
  } catch (error) {
    throw new RuntimeRecordValidationError([
      { field: 'roomId', message: error instanceof Error ? error.message : 'is invalid' },
    ]);
  }
  const networkName = draft.networkName ?? draft.name;
  if (roomId === undefined) {
    throw new RuntimeRecordValidationError([{ field: 'roomId', message: 'is required' }]);
  }
  if (networkName === undefined) {
    throw new RuntimeRecordValidationError([{ field: 'networkName', message: 'is required' }]);
  }
  const now = nowValue(draft.now);
  const leaseExpiresAt =
    draft.leaseExpiresAt === undefined
      ? now + safeDuration(draft.ttlMs, DEFAULT_LEASE_TTL_MS, 'ttlMs')
      : timestamp(draft.leaseExpiresAt, 'leaseExpiresAt');
  if (!Number.isSafeInteger(leaseExpiresAt)) {
    throw new RuntimeRecordValidationError([
      { field: 'leaseExpiresAt', message: 'must be a safe integer timestamp' },
    ]);
  }

  const candidate = {
    runtimeId,
    sessionId,
    roomId,
    networkName,
    endpoint: draft.endpoint,
    leaseExpiresAt,
  };
  const result = validateRuntimeRecord(candidate);
  if (!result.valid || result.record === undefined) {
    throw new RuntimeRecordValidationError(result.errors);
  }
  return result.record;
}

/** Resolve the safe per-user root without using user-controlled room values. */
export function resolveRegistryRoot(options: RegistryRootOptions = {}): string {
  const explicit = options.rootDirectory ?? options.registryRoot ?? options.root;
  if (
    options.rootDirectory !== undefined &&
    options.registryRoot !== undefined &&
    options.rootDirectory !== options.registryRoot
  ) {
    throw new RegistryPathError('rootDirectory and registryRoot disagree');
  }
  if (
    options.rootDirectory !== undefined &&
    options.root !== undefined &&
    options.rootDirectory !== options.root
  ) {
    throw new RegistryPathError('rootDirectory and root disagree');
  }
  if (
    options.registryRoot !== undefined &&
    options.root !== undefined &&
    options.registryRoot !== options.root
  ) {
    throw new RegistryPathError('registryRoot and root disagree');
  }

  const platform = options.platform ?? process.platform;
  const pathApi = platform === 'win32' ? nodePath.win32 : nodePath.posix;
  const env = options.env ?? process.env;
  const configured = explicit ?? env.PI_TO_PI_REGISTRY_DIR;
  if (configured !== undefined) {
    return absoluteRoot(configured, pathApi);
  }

  if (platform !== 'win32' && env.XDG_RUNTIME_DIR !== undefined) {
    const runtimeDir = absoluteRoot(env.XDG_RUNTIME_DIR, pathApi);
    return pathApi.join(runtimeDir, 'pi-to-pi');
  }
  if (platform === 'win32' && env.LOCALAPPDATA !== undefined) {
    const appData = absoluteRoot(env.LOCALAPPDATA, pathApi);
    return pathApi.join(appData, 'pi-to-pi', 'runtime');
  }

  const home = options.homeDirectory ?? env.HOME ?? env.USERPROFILE ?? homedir();
  if (typeof home === 'string' && pathApi.isAbsolute(home)) {
    return pathApi.join(home, '.pi-to-pi', 'runtime');
  }

  const temporary = options.temporaryDirectory ?? tmpdir();
  const fallback = absoluteRoot(temporary, pathApi);
  const uid = options.uid ?? (typeof process.getuid === 'function' ? process.getuid() : undefined);
  return pathApi.join(fallback, `pi-to-pi-${uid === undefined ? 'user' : `uid-${uid}`}`);
}

function absoluteRoot(value: string, pathApi: typeof nodePath.posix): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    !pathApi.isAbsolute(value) ||
    hasControlCharacter(value)
  ) {
    throw new RegistryPathError('registry root must be an absolute path without controls');
  }
  return pathApi.normalize(value);
}

function safeRoomPath(root: string, roomId: RoomId): string {
  const rooms = nodePath.join(root, REGISTRY_ROOMS_DIRECTORY);
  const room = nodePath.join(rooms, roomId);
  if (nodePath.basename(room) !== roomId || !room.startsWith(`${rooms}${nodePath.sep}`)) {
    throw new RegistryPathError('room ID escaped the registry root');
  }
  return room;
}

function safeRuntimePath(recordsDirectory: string, runtimeId: RuntimeId): string {
  const fileName = `${runtimeId}${RECORD_FILE_SUFFIX}`;
  const target = nodePath.join(recordsDirectory, fileName);
  if (
    !RUNTIME_RECORD_FILE_PATTERN.test(fileName) ||
    nodePath.basename(target) !== fileName ||
    !target.startsWith(`${recordsDirectory}${nodePath.sep}`)
  ) {
    throw new RegistryPathError('runtime ID is not a safe registry key');
  }
  return target;
}

/** Build room-scoped paths using only validated opaque identifiers. */
export function getRegistryPaths(
  roomId: RoomLike,
  options: RegistryPathOptions = {},
): RegistryPaths {
  const validatedRoomId = roomIdFromLike(roomId);
  const root = resolveRegistryRoot(options);
  const roomsDirectory = nodePath.join(root, REGISTRY_ROOMS_DIRECTORY);
  const roomDirectory = safeRoomPath(root, validatedRoomId);
  const recordsDirectory = nodePath.join(roomDirectory, REGISTRY_RECORDS_DIRECTORY);
  if (!recordsDirectory.startsWith(`${roomDirectory}${nodePath.sep}`)) {
    throw new RegistryPathError('record directory escaped the room path');
  }
  return {
    rootDirectory: root,
    roomsDirectory,
    roomDirectory,
    recordsDirectory,
    agentsDirectory: recordsDirectory,
    roomId: validatedRoomId,
  };
}

/** Alias with a naming style used by filesystem integrations. */
export const buildRegistryPaths = getRegistryPaths;

/** Return the exact path for one runtime key without touching the filesystem. */
export function getRuntimeRecordPath(
  roomId: RoomLike,
  runtimeId: RuntimeId | string,
  options: RegistryPathOptions = {},
): string {
  const paths = getRegistryPaths(roomId, options);
  return safeRuntimePath(paths.recordsDirectory, asRuntimeId(runtimeId));
}

export const buildRuntimeRecordPath = getRuntimeRecordPath;
export const getRecordPath = getRuntimeRecordPath;

function currentUid(options: RegistryPathOptions): number | undefined {
  return (
    options.ownerUid ??
    options.uid ??
    (typeof process.getuid === 'function' ? process.getuid() : undefined)
  );
}

function modeIs(mode: number, expected: number): boolean {
  return (mode & 0o7777) === expected;
}

function isPrivateDirectoryStats(
  stats: {
    readonly isDirectory: () => boolean;
    readonly isSymbolicLink: () => boolean;
    readonly mode: number;
    readonly uid: number;
  },
  options: RegistryPathOptions,
): boolean {
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    return false;
  }
  if ((options.platform ?? process.platform) === 'win32') {
    return true;
  }
  const uid = currentUid(options);
  return (uid === undefined || stats.uid === uid) && modeIs(stats.mode, PRIVATE_DIRECTORY_MODE);
}

function isPrivateFileStats(
  stats: {
    readonly isFile: () => boolean;
    readonly isSymbolicLink: () => boolean;
    readonly mode: number;
    readonly uid: number;
  },
  options: RegistryPathOptions,
): boolean {
  if (!stats.isFile() || stats.isSymbolicLink()) {
    return false;
  }
  if ((options.platform ?? process.platform) === 'win32') {
    return true;
  }
  const uid = currentUid(options);
  return (uid === undefined || stats.uid === uid) && modeIs(stats.mode, PRIVATE_FILE_MODE);
}

/** Ensure a real, current-user-only directory exists. */
export async function ensurePrivateDirectory(
  directory: string,
  options: RegistryPathOptions = {},
): Promise<string> {
  const platform = options.platform ?? process.platform;
  const pathApi = platform === 'win32' ? nodePath.win32 : nodePath.posix;
  const target = absoluteRoot(directory, pathApi);
  let created = false;
  try {
    const stats = await lstat(target);
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      throw new RegistryPathError(`registry path is not a real directory: ${target}`);
    }
  } catch (error) {
    if (!isMissing(error)) {
      throw error;
    }
    await mkdir(target, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
    created = true;
  }

  const stats = await lstat(target);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new RegistryPathError(`registry path is not a real directory: ${target}`);
  }
  if (platform !== 'win32') {
    const uid = currentUid(options);
    if (uid !== undefined && stats.uid !== uid) {
      throw new RegistryPathError(`registry directory is not owned by the current user: ${target}`);
    }
    if (!modeIs(stats.mode, PRIVATE_DIRECTORY_MODE)) {
      if (!created) {
        throw new RegistryPathError(`registry directory is not private: ${target}`);
      }
      await chmod(target, PRIVATE_DIRECTORY_MODE);
    }
    const tightened = await lstat(target);
    if (!modeIs(tightened.mode, PRIVATE_DIRECTORY_MODE)) {
      throw new RegistryPathError(`registry directory is not private: ${target}`);
    }
  }
  return target;
}

/** Create the complete private root/room/record directory tree. */
export async function ensureRegistryPaths(
  roomId: RoomLike,
  options: RegistryPathOptions = {},
): Promise<RegistryPaths> {
  const paths = getRegistryPaths(roomId, options);
  await ensurePrivateDirectory(paths.rootDirectory, options);
  await ensurePrivateDirectory(paths.roomsDirectory, options);
  await ensurePrivateDirectory(paths.roomDirectory, options);
  await ensurePrivateDirectory(paths.recordsDirectory, options);
  return paths;
}

/** Alias for callers that initialize a room before publication. */
export const ensurePrivateRegistry = ensureRegistryPaths;

async function ensurePrivateFile(file: string, options: RegistryPathOptions): Promise<void> {
  const stats = await lstat(file);
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new RegistryPathError(`registry record is not a regular file: ${file}`);
  }
  if ((options.platform ?? process.platform) !== 'win32') {
    const uid = currentUid(options);
    if (uid !== undefined && stats.uid !== uid) {
      throw new RegistryPathError(`registry record is not owned by the current user: ${file}`);
    }
    if (!modeIs(stats.mode, PRIVATE_FILE_MODE)) {
      throw new RegistryPathError(`registry record is not private: ${file}`);
    }
  }
}

const writeLocks = new Map<string, Promise<unknown>>();
const REGISTRY_LOCK_RETRY_DELAY_MS = 10;
const REGISTRY_LOCK_STALE_AFTER_MS = 2 * 60_000;

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

interface RegistryLockOwner {
  readonly pid: number;
  readonly token: string;
  readonly acquiredAt: number;
}

function parseRegistryLockOwner(source: string): RegistryLockOwner | undefined {
  try {
    const value = JSON.parse(source) as unknown;
    if (!isRecord(value)) {
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
    return { pid, token, acquiredAt };
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

function waitForRegistryLock(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, REGISTRY_LOCK_RETRY_DELAY_MS);
  });
}

async function reclaimStaleRegistryLock(lockPath: string): Promise<void> {
  let firstStats;
  try {
    firstStats = await lstat(lockPath);
  } catch (error) {
    if (isMissing(error)) {
      return;
    }
    throw error;
  }
  if (!firstStats.isFile() || firstStats.isSymbolicLink()) {
    return;
  }
  if (Date.now() - firstStats.mtimeMs < REGISTRY_LOCK_STALE_AFTER_MS) {
    return;
  }

  let owner: RegistryLockOwner | undefined;
  try {
    owner = parseRegistryLockOwner(await readFile(lockPath, 'utf8'));
  } catch (error) {
    if (!isMissing(error)) {
      throw error;
    }
  }
  if (owner && processIsAlive(owner.pid)) {
    return;
  }

  let secondStats;
  try {
    secondStats = await lstat(lockPath);
  } catch (error) {
    if (isMissing(error)) {
      return;
    }
    throw error;
  }
  if (snapshotStat(firstStats) !== snapshotStat(secondStats)) {
    return;
  }
  await unlink(lockPath).catch((error: unknown) => {
    if (!isMissing(error)) {
      throw error;
    }
  });
}

async function acquireRegistryRecordLock(recordPath: string): Promise<() => Promise<void>> {
  const lockPath = `${recordPath}.lock`;
  const owner: RegistryLockOwner = {
    pid: process.pid,
    token: randomBytes(16).toString('hex'),
    acquiredAt: Date.now(),
  };
  const serializedOwner = JSON.stringify(owner);

  while (true) {
    let created = false;
    let handle: FileHandle | undefined;
    try {
      handle = await open(lockPath, 'wx', PRIVATE_FILE_MODE);
      created = true;
      await handle.writeFile(serializedOwner, 'utf8');
      await handle.sync();
      await handle.close();
      handle = undefined;
      return async () => {
        let firstStats;
        try {
          firstStats = await lstat(lockPath);
        } catch (error) {
          if (isMissing(error)) {
            return;
          }
          throw error;
        }
        let source: string;
        try {
          source = await readFile(lockPath, 'utf8');
        } catch (error) {
          if (isMissing(error)) {
            return;
          }
          throw error;
        }
        let secondStats;
        try {
          secondStats = await lstat(lockPath);
        } catch (error) {
          if (isMissing(error)) {
            return;
          }
          throw error;
        }
        if (
          snapshotStat(firstStats) !== snapshotStat(secondStats) ||
          parseRegistryLockOwner(source)?.token !== owner.token
        ) {
          return;
        }
        await unlink(lockPath).catch((error: unknown) => {
          if (!isMissing(error)) {
            throw error;
          }
        });
      };
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
      await reclaimStaleRegistryLock(lockPath);
      await waitForRegistryLock();
    }
  }
}

function withRegistryRecordLock<T>(recordPath: string, operation: () => Promise<T>): Promise<T> {
  return withWriteLock(recordPath, async () => {
    const release = await acquireRegistryRecordLock(recordPath);
    try {
      return await operation();
    } finally {
      await release();
    }
  });
}

async function openUniqueTemporaryFile(
  directory: string,
  runtimeId: RuntimeId,
): Promise<{ readonly path: string; readonly handle: FileHandle }> {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const suffix = `${process.pid}-${Date.now().toString(36)}-${randomBytes(16).toString('hex')}`;
    const path = nodePath.join(directory, `.${runtimeId}.json.tmp-${suffix}`);
    try {
      const handle = await open(path, 'wx', PRIVATE_FILE_MODE);
      return { path, handle };
    } catch (error) {
      if (errorCode(error) !== 'EEXIST') {
        throw error;
      }
    }
  }
  throw new RuntimeRegistryError('unable to allocate a unique temporary registry file');
}

/**
 * Publish a complete record through a same-directory unique temporary file and
 * atomic rename.  Every write revalidates the runtime-key ownership invariant.
 */
export async function publishRuntimeRecordAtomically(
  record: unknown,
  options: RegistryPathOptions = {},
): Promise<string> {
  const validated = validateRuntimeRecord(record);
  if (!validated.valid || validated.record === undefined) {
    throw new RuntimeRecordValidationError(validated.errors);
  }
  const canonical = validated.record;
  const paths = await ensureRegistryPaths(canonical.roomId, options);
  const target = safeRuntimePath(paths.recordsDirectory, canonical.runtimeId);
  const payload = JSON.stringify(canonical);
  return withRegistryRecordLock(target, async () => {
    let temporaryPath: string | undefined;
    let handle: FileHandle | undefined;
    try {
      const temporary = await openUniqueTemporaryFile(paths.recordsDirectory, canonical.runtimeId);
      temporaryPath = temporary.path;
      handle = temporary.handle;
      await handle.writeFile(payload, 'utf8');
      await handle.sync();
      await handle.close();
      handle = undefined;
      await ensurePrivateFile(temporaryPath, options);
      await rename(temporaryPath, target);
      temporaryPath = undefined;
      await ensurePrivateFile(target, options);
      return target;
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

/** Short alias for callers that do not need the atomicity qualifier. */
export const publishRuntimeRecord = publishRuntimeRecordAtomically;
export const writeRuntimeRecordAtomically = publishRuntimeRecordAtomically;

function fileNameFor(runtimeId: RuntimeId): string {
  return `${runtimeId}${RECORD_FILE_SUFFIX}`;
}

function snapshotStat(stats: {
  readonly dev: number;
  readonly ino: number;
  readonly size: number;
  readonly mtimeMs: number;
}): string {
  return `${stats.dev}:${stats.ino}:${stats.size}:${stats.mtimeMs}`;
}

interface CandidateRecord {
  readonly record: RuntimeRecord;
  readonly path: string;
  readonly stat: string;
}

async function readCandidate(
  paths: RegistryPaths,
  fileName: string,
  options: RuntimeRecordReadOptions = {},
): Promise<CandidateRecord | undefined> {
  if (!RUNTIME_RECORD_FILE_PATTERN.test(fileName)) {
    return undefined;
  }
  const runtimeIdText = fileName.slice(0, -RECORD_FILE_SUFFIX.length);
  let runtimeId: RuntimeId;
  try {
    runtimeId = asRuntimeId(runtimeIdText);
  } catch {
    return undefined;
  }
  const path = safeRuntimePath(paths.recordsDirectory, runtimeId);
  let stats;
  try {
    stats = await lstat(path);
  } catch {
    return undefined;
  }
  if (
    !isPrivateFileStats(stats, options) ||
    stats.size > (options.maxBytes ?? MAX_RUNTIME_RECORD_BYTES)
  ) {
    return undefined;
  }

  let source: string;
  try {
    const bytes = await readFile(path);
    source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
  let sourceStats;
  try {
    sourceStats = await lstat(path);
  } catch {
    return undefined;
  }
  if (
    !isPrivateFileStats(sourceStats, options) ||
    sourceStats.size > (options.maxBytes ?? MAX_RUNTIME_RECORD_BYTES) ||
    snapshotStat(sourceStats) !== snapshotStat(stats)
  ) {
    return undefined;
  }
  const result = parseRuntimeRecordJson(source, {
    expectedRuntimeId: runtimeId,
    expectedRoomId: paths.roomId,
    requireUnexpired: options.requireUnexpired ?? true,
    now: options.now,
    maxBytes: options.maxBytes,
  });
  if (!result.valid || result.record === undefined) {
    return undefined;
  }
  return { record: result.record, path, stat: snapshotStat(stats) };
}
async function registryTreeIsPrivate(
  paths: RegistryPaths,
  options: RegistryPathOptions,
): Promise<boolean> {
  try {
    const stats = await Promise.all(
      [paths.rootDirectory, paths.roomsDirectory, paths.roomDirectory, paths.recordsDirectory].map(
        (path) => lstat(path),
      ),
    );
    return stats.every((entry) => isPrivateDirectoryStats(entry, options));
  } catch {
    return false;
  }
}

async function directoryFileNames(
  paths: RegistryPaths,
  options: RegistryPathOptions,
): Promise<string[]> {
  if (!(await registryTreeIsPrivate(paths, options))) {
    return [];
  }
  try {
    return (await readdir(paths.recordsDirectory)).filter((name) =>
      RUNTIME_RECORD_FILE_PATTERN.test(name),
    );
  } catch {
    return [];
  }
}

/** Read one exact runtime record, ignoring malformed or expired content. */
export async function readRuntimeRecord(
  roomId: RoomLike,
  runtimeId: RuntimeId | string,
  options: RuntimeRecordReadOptions = {},
): Promise<RuntimeRecord | undefined> {
  const validatedRuntimeId = asRuntimeId(runtimeId);
  const paths = getRegistryPaths(roomId, options);
  if (!(await registryTreeIsPrivate(paths, options))) {
    return undefined;
  }
  return (await readCandidate(paths, fileNameFor(validatedRuntimeId), options))?.record;
}

export const loadRuntimeRecord = readRuntimeRecord;

/**
 * List independently valid, live records in one exact room.  Every malformed,
 * cross-room, expired, symlinked, or incorrectly named file is ignored.
 */
export async function listRuntimeRecords(
  roomId: RoomLike,
  options: RuntimeRecordListOptions = {},
): Promise<RuntimeRecord[]> {
  const paths = getRegistryPaths(roomId, options);
  const now = options.now === undefined ? Date.now() : options.now;
  const records: RuntimeRecord[] = [];
  for (const fileName of await directoryFileNames(paths, options)) {
    const candidate = await readCandidate(paths, fileName, {
      ...options,
      now,
      requireUnexpired: true,
    });
    if (candidate) {
      records.push(candidate.record);
      continue;
    }
    if (!options.removeExpired) {
      continue;
    }
    // A second structural read intentionally distinguishes an expired record
    // from malformed content before attempting exact-key garbage collection.
    const expired = await readCandidate(paths, fileName, {
      ...options,
      now,
      requireUnexpired: false,
    });
    if (expired && expired.record.leaseExpiresAt <= nowValue(now)) {
      await removeCandidateIfUnchanged(paths, expired).catch(() => false);
    }
  }
  return records;
}

export const discoverRuntimeRecords = listRuntimeRecords;
export const listLiveRuntimeRecords = listRuntimeRecords;

async function currentStat(path: string): Promise<string | undefined> {
  try {
    return snapshotStat(await lstat(path));
  } catch {
    return undefined;
  }
}
async function removeCandidateIfUnchangedUnlocked(
  paths: RegistryPaths,
  candidate: CandidateRecord,
): Promise<boolean> {
  if (candidate.record.runtimeId !== candidate.path.slice(paths.recordsDirectory.length + 1, -5)) {
    return false;
  }
  const current = await currentStat(candidate.path);
  if (current === undefined || current !== candidate.stat) {
    return false;
  }
  try {
    await unlink(candidate.path);
    return true;
  } catch (error) {
    if (isMissing(error)) {
      return false;
    }
    throw error;
  }
}

async function removeCandidateIfUnchanged(
  paths: RegistryPaths,
  candidate: CandidateRecord,
): Promise<boolean> {
  return withRegistryRecordLock(candidate.path, () =>
    removeCandidateIfUnchangedUnlocked(paths, candidate),
  );
}

function matchesCleanupExpectation(
  record: RuntimeRecord,
  options: RuntimeRecordCleanupOptions,
): boolean {
  if (
    options.expectedSessionId !== undefined &&
    record.sessionId !== asSessionId(options.expectedSessionId)
  ) {
    return false;
  }
  if (options.expectedEndpoint !== undefined && record.endpoint !== options.expectedEndpoint) {
    return false;
  }
  if (options.expectedNetworkName !== undefined) {
    try {
      if (
        record.networkName !== canonicalNetworkName(options.expectedNetworkName, record.runtimeId)
      ) {
        return false;
      }
    } catch {
      return false;
    }
  }
  return true;
}

/**
 * Remove only an exact runtime-owned record.  Missing, malformed, replaced, or
 * cross-room content is left untouched and reports `false`.
 */
export async function removeRuntimeRecord(
  roomId: RoomLike,
  runtimeId: RuntimeId | string,
  options: RuntimeRecordCleanupOptions = {},
): Promise<boolean> {
  const validatedRuntimeId = asRuntimeId(runtimeId);
  const paths = getRegistryPaths(roomId, options);
  if (!(await registryTreeIsPrivate(paths, options))) {
    return false;
  }
  const fileName = fileNameFor(validatedRuntimeId);
  const target = safeRuntimePath(paths.recordsDirectory, validatedRuntimeId);
  const first = await readCandidate(paths, fileName, {
    ...options,
    requireUnexpired: false,
  });
  if (
    !first ||
    first.record.runtimeId !== validatedRuntimeId ||
    !matchesCleanupExpectation(first.record, options)
  ) {
    return false;
  }
  return withRegistryRecordLock(target, async () => {
    const second = await readCandidate(paths, fileName, {
      ...options,
      requireUnexpired: false,
    });
    if (
      !second ||
      second.stat !== first.stat ||
      second.record.runtimeId !== validatedRuntimeId ||
      !matchesCleanupExpectation(second.record, options)
    ) {
      return false;
    }
    return removeCandidateIfUnchangedUnlocked(paths, second);
  });
}

export const cleanupRuntimeRecord = removeRuntimeRecord;
export const removeExactRuntimeRecord = removeRuntimeRecord;

function failureKind(
  value: EndpointFailureKind | { readonly code?: string; readonly name?: string },
): EndpointFailureKind | undefined {
  if (typeof value === 'string') {
    return value;
  }
  const code = value.code?.toUpperCase();
  const name = value.name?.toLowerCase();
  if (code === 'ETIMEDOUT' || code === 'ESOCKETTIMEDOUT' || name?.includes('timeout')) {
    return 'timeout';
  }
  if (code === 'ENOENT' || code === 'ENOTFOUND') {
    return 'missing';
  }
  if (code === 'ECONNREFUSED') {
    return 'refused';
  }
  return undefined;
}

/** Return true only for a definitive endpoint absence/refusal result. */
export function isDefinitiveEndpointFailure(
  failure: EndpointFailureKind | { readonly code?: string; readonly name?: string },
): boolean {
  const kind = failureKind(failure);
  return (
    kind === 'missing' ||
    kind === 'not-found' ||
    kind === 'refused' ||
    kind === 'connection-refused' ||
    kind === 'definitive' ||
    kind === 'missing-endpoint'
  );
}

/** Return true for timeout-like failures, which never delete a live record. */
export function isEndpointTimeout(
  failure: EndpointFailureKind | { readonly code?: string; readonly name?: string },
): boolean {
  const kind = failureKind(failure);
  return kind === 'timeout' || kind === 'timed-out';
}

/**
 * Handle an endpoint probe result without conflating timeout with absence.
 * Definitive failure may remove an exact still-matching record; timeout leaves
 * an unexpired record available until renewal or lease expiry.
 */
export async function handleEndpointFailure(
  roomId: RoomLike,
  runtimeId: RuntimeId | string,
  options: EndpointFailureOptions,
): Promise<boolean> {
  const failure = options.failure ?? options.kind;
  if (failure === undefined || isEndpointTimeout(failure)) {
    return false;
  }
  if (!isDefinitiveEndpointFailure(failure)) {
    return false;
  }
  return removeRuntimeRecord(roomId, runtimeId, options);
}

export const removeAfterEndpointFailure = handleEndpointFailure;
export const handleProbeFailure = handleEndpointFailure;

function roomFromOptions(options: RuntimeRegistryOptions): RoomId {
  let roomId: RoomId | undefined;
  try {
    roomId = resolveRoomId(options.roomId, options.room);
  } catch (error) {
    throw new RuntimeRegistryError(error instanceof Error ? error.message : 'roomId is invalid');
  }
  if (roomId === undefined) {
    throw new RuntimeRegistryError('roomId is required');
  }
  return roomId;
}

function runtimeIdentityFromOptions(options: RuntimeRegistryOptions): {
  readonly runtimeId: RuntimeId;
  readonly sessionId: SessionId;
} {
  const identity = options.identity ?? options.runtimeIdentity;
  const runtimeId = options.runtimeId ?? identity?.runtimeId;
  const sessionId = options.sessionId ?? identity?.sessionId;
  if (runtimeId === undefined || sessionId === undefined) {
    throw new RuntimeRegistryError('runtimeId and sessionId are required');
  }
  try {
    const parsedRuntimeId = asRuntimeId(runtimeId);
    const parsedSessionId = asSessionId(sessionId);
    if (
      identity &&
      (identity.runtimeId !== parsedRuntimeId || identity.sessionId !== parsedSessionId)
    ) {
      throw new RuntimeRegistryError('runtime identity conflicts with explicit identity fields');
    }
    return { runtimeId: parsedRuntimeId, sessionId: parsedSessionId };
  } catch (error) {
    if (error instanceof RuntimeRegistryError) {
      throw error;
    }
    throw new RuntimeRegistryError('runtimeId and sessionId are invalid');
  }
}

/**
 * Lifecycle-facing registry owner.  Later Pi integration can create one at
 * `session_start`, call `start()`, and await `shutdown()` from
 * `session_shutdown`.  Shutdown is idempotent and never touches another key.
 */
export class RuntimeRegistry {
  public readonly runtimeId: RuntimeId;
  public readonly sessionId: SessionId;
  public readonly roomId: RoomId;
  public get networkName(): RegistryNetworkName {
    return this.currentNetworkName;
  }
  public readonly endpoint: string;
  public readonly ttlMs: number;
  public readonly renewalIntervalMs: number;
  public readonly lease: SerializedLease;

  private readonly pathOptions: RegistryPathOptions;
  private readonly clock: RegistryClock;
  private currentNetworkName: RegistryNetworkName;
  private readonly cleanupOptions: RuntimeRecordCleanupOptions;
  private currentRecord: RuntimeRecord | undefined;
  private attemptedRecord: RuntimeRecord | undefined;
  private pendingPublication: Promise<void> = Promise.resolve();
  private shutdownRequested = false;
  private shutdownPromise: Promise<boolean> | undefined;

  public constructor(options: RuntimeRegistryOptions) {
    const identity = runtimeIdentityFromOptions(options);
    this.runtimeId = identity.runtimeId;
    this.sessionId = identity.sessionId;
    this.roomId = roomFromOptions(options);
    const networkName = options.networkName ?? options.name;
    if (networkName === undefined) {
      throw new RuntimeRegistryError('networkName is required');
    }
    try {
      this.currentNetworkName = canonicalNetworkName(networkName, this.runtimeId);
    } catch (error) {
      if (error instanceof RuntimeRegistryError) {
        throw error;
      }
      throw new RuntimeRegistryError(
        'networkName must be a canonical base or published network name',
      );
    }
    try {
      this.endpoint = assertText(options.endpoint, 'endpoint', MAX_ENDPOINT_LENGTH);
    } catch {
      throw new RuntimeRegistryError('endpoint must be bounded endpoint text');
    }
    this.ttlMs = safeDuration(options.ttlMs, DEFAULT_LEASE_TTL_MS, 'ttlMs');
    this.renewalIntervalMs = safeDuration(
      options.renewalIntervalMs,
      DEFAULT_LEASE_RENEWAL_INTERVAL_MS,
      'renewalIntervalMs',
    );
    this.pathOptions = {
      rootDirectory: options.rootDirectory,
      registryRoot: options.registryRoot,
      root: options.root,
      env: options.env,
      platform: options.platform,
      homeDirectory: options.homeDirectory,
      temporaryDirectory: options.temporaryDirectory,
      uid: options.uid,
      ownerUid: options.ownerUid,
    };
    this.clock = clockFrom(options.clock ?? options.now);
    this.cleanupOptions = {
      ...this.pathOptions,
      expectedSessionId: this.sessionId,
      expectedEndpoint: this.endpoint,
      expectedNetworkName: this.networkName,
    };
    this.lease = new SerializedLease({
      renew: async () => {
        await this.renew();
      },
      ttlMs: this.ttlMs,
      renewalIntervalMs: this.renewalIntervalMs,
      scheduler: options.scheduler,
      now: this.clock,
      onError: options.onLeaseError,
    });
  }

  /** Return the currently published record, if this owner has renewed yet. */
  public current(): RuntimeRecord | undefined {
    return this.currentRecord;
  }

  private enqueuePublication(operation: () => Promise<void>): Promise<void> {
    const queued = this.pendingPublication.then(operation);
    this.pendingPublication = queued.then(
      () => undefined,
      () => undefined,
    );
    return queued;
  }

  /** Publish the currently staged name; subclasses may inject deterministic failures. */
  protected async publishCurrentName(): Promise<void> {
    if (this.shutdownRequested || this.lease.stopped) {
      throw new LeaseConfigurationError('cannot renew a stopped runtime registry');
    }
    const record = createRuntimeRecord({
      runtimeId: this.runtimeId,
      sessionId: this.sessionId,
      roomId: this.roomId,
      networkName: this.networkName,
      endpoint: this.endpoint,
      now: this.clock(),
      ttlMs: this.ttlMs,
    });
    this.attemptedRecord = record;
    await publishRuntimeRecordAtomically(record, this.pathOptions);
    this.currentRecord = record;
  }

  private async restoreCommittedRecord(
    previousRecord: RuntimeRecord | undefined,
    failedRecord: RuntimeRecord | undefined,
  ): Promise<void> {
    try {
      if (previousRecord !== undefined) {
        await publishRuntimeRecordAtomically(previousRecord, this.pathOptions);
      } else if (failedRecord !== undefined) {
        await removeRuntimeRecord(this.roomId, this.runtimeId, {
          ...this.pathOptions,
          expectedSessionId: failedRecord.sessionId,
          expectedEndpoint: failedRecord.endpoint,
          expectedNetworkName: failedRecord.networkName,
        });
      }
      this.currentRecord = previousRecord;
    } catch (error) {
      this.currentRecord = undefined;
      throw error;
    }
  }

  /** Publish one owner record with a fresh lease. */
  public renew(): Promise<void> {
    if (this.shutdownRequested || this.lease.stopped) {
      return Promise.reject(new LeaseConfigurationError('cannot renew a stopped runtime registry'));
    }
    return this.enqueuePublication(async () => {
      this.attemptedRecord = undefined;
      try {
        await this.publishCurrentName();
      } finally {
        this.attemptedRecord = undefined;
      }
    });
  }

  public publish(): Promise<void> {
    return this.renew();
  }

  /** Update the published name while retaining this runtime's exact ownership. */
  public updateNetworkName(networkName: RegistryNetworkName | string): Promise<void> {
    let canonical: RegistryNetworkName;
    try {
      canonical = canonicalNetworkName(networkName, this.runtimeId);
    } catch {
      return Promise.reject(
        new RuntimeRegistryError('networkName must be a canonical base or published network name'),
      );
    }

    return this.enqueuePublication(async () => {
      const previousNetworkName = this.networkName;
      const previousRecord = this.currentRecord;
      this.currentNetworkName = canonical;
      this.attemptedRecord = undefined;
      try {
        await this.publishCurrentName();
      } catch (error) {
        const failedRecord =
          this.attemptedRecord ??
          (this.currentRecord !== previousRecord ? this.currentRecord : undefined);
        this.attemptedRecord = undefined;
        this.currentNetworkName = previousNetworkName;
        await this.restoreCommittedRecord(previousRecord, failedRecord);
        throw error;
      } finally {
        this.attemptedRecord = undefined;
      }
    });
  }

  /** Alias for lifecycle callers that describe the operation as a rename. */
  public renameNetworkName(networkName: RegistryNetworkName | string): Promise<void> {
    return this.updateNetworkName(networkName);
  }

  /** Start the initial publication and the approximately ten-second timer. */
  public start(): Promise<void> {
    return this.lease.start();
  }

  /** Stop timer activity without removing the record. */
  public stopLease(): Promise<void> {
    return this.lease.stop();
  }

  public startLease(): Promise<void> {
    return this.start();
  }

  /**
   * Stop renewal and remove only this exact owner record.  Repeated calls share
   * the same cleanup promise and are safe after the file has already vanished.
   */
  public shutdown(): Promise<boolean> {
    if (!this.shutdownPromise) {
      this.shutdownRequested = true;
      this.shutdownPromise = (async () => {
        await this.lease.stop();
        await this.pendingPublication;
        // A rename stages the mutable name before its queued publication commits;
        // remove the exact record that was last committed to disk instead.
        const committedRecord = this.currentRecord;
        const cleanupOptions =
          committedRecord === undefined
            ? this.cleanupOptions
            : {
                ...this.cleanupOptions,
                expectedSessionId: committedRecord.sessionId,
                expectedEndpoint: committedRecord.endpoint,
                expectedNetworkName: committedRecord.networkName,
              };
        const removed = await removeRuntimeRecord(this.roomId, this.runtimeId, cleanupOptions);
        this.currentRecord = undefined;
        return removed;
      })();
    }
    return this.shutdownPromise;
  }

  public cleanup(): Promise<boolean> {
    return this.shutdown();
  }

  public close(): Promise<boolean> {
    return this.shutdown();
  }
}

/** Factory-style alias for lifecycle integration. */
export function createRuntimeRegistry(options: RuntimeRegistryOptions): RuntimeRegistry {
  return new RuntimeRegistry(options);
}

export const createRegistry = createRuntimeRegistry;
export const RuntimeRecordRegistry = RuntimeRegistry;
