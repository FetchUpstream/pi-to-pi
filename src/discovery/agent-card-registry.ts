/**
 * The Agent Card discovery authority.
 *
 * This module deliberately does not import or delegate to the deprecated
 * RuntimeRecord/RuntimeRegistry compatibility seam in `registry.ts`.
 */

import { lstat, opendir, readFile, unlink } from 'node:fs/promises';
import type { Stats } from 'node:fs';

import { resolveRuntimeRoot } from '../config.js';
import type { RuntimeRootOptions, RuntimeRootSelection } from '../config.js';
import {
  asRuntimeId,
  asSessionId,
  type RuntimeId,
  type RuntimeIdentity,
  type SessionId,
} from '../identity.js';
import { assertValidRoomId, isSafeStorageKey, type ResolvedRoom, type RoomId } from '../room.js';
import {
  AGENT_CARD_PROTOCOL_VERSION,
  createAgentCard,
  DEFAULT_LEASE_RENEWAL_INTERVAL_MS,
  DEFAULT_LEASE_TTL_MS,
  MAX_AGENT_CARD_SIZE_BYTES,
  type AgentCard,
  type AgentCapabilities,
  type AgentCardDraft,
  type AgentModel,
  type AgentState,
  type ContextUsage,
  type EndpointDescriptor,
} from '../protocol/agent-card.js';
import { parseAgentCardJson, type AgentCardValidationOptions } from '../protocol/validation.js';
import {
  DEFAULT_ABANDONED_TEMP_MAX_ENTRIES,
  buildAgentCardPath,
  buildRegistryPaths,
  cleanupAbandonedTemporaryFiles,
  createPrivateRuntimeTree,
  withAgentCardWriteLock,
  writeAgentCardAtomically,
  type FileStatSnapshot,
  type PrivateFilesystemOptions,
  type RegistryPaths,
  type RoomStorageIdentity,
  type RuntimeTree,
} from './filesystem.js';
import {
  DEFAULT_LEASE_TTL_MS as LEASE_TTL_MS,
  SerializedLease,
  isLeaseExpired,
  leaseExpiration,
  parseLeaseTimestamp,
  serializeLeaseTimestamp,
  type LeaseClock,
  type LeaseScheduler,
  type LeaseTimestamp,
} from './lease.js';
import {
  buildNetworkName,
  isPublishedNetworkName,
  publishedNetworkBase,
  type PublishedNetworkName,
} from './naming.js';
import {
  lookupPeerByName,
  lookupPeerByRuntimeId,
  type PeerLookupResult,
  type PeerRecordLike,
} from './lookup.js';

export const DEFAULT_AGENT_CARD_SCAN_MAX_ENTRIES = 256;
export const DEFAULT_AGENT_CARD_SCAN_TIME_BUDGET_MS = 250;

const DEFAULT_AGENT_CARD_CAPABILITIES: AgentCapabilities = Object.freeze({
  structuredReplies: true,
  cancellation: true,
  statusUpdates: true,
  maxMessageSize: 16 * 1024 * 1024,
  supportedContentTypes: Object.freeze(['text/plain']),
});

export type AgentCardRoomInput =
  | string
  | ResolvedRoom
  | RoomStorageIdentity
  | { readonly roomId: string; readonly storageKey?: string }
  | { readonly id: string; readonly storageKey?: string };

export interface AgentCardRoomAdapterOptions {
  readonly storageKey?: string;
}

/** Resolve a canonical room to the filesystem identity consumed by discovery. */
export function resolveAgentCardRoom(
  room: AgentCardRoomInput,
  options: AgentCardRoomAdapterOptions = {},
): RoomStorageIdentity {
  const source = typeof room === 'string' ? { roomId: room } : room;
  const roomIdValue = 'roomId' in source ? source.roomId : 'id' in source ? source.id : undefined;
  if (roomIdValue === undefined) {
    throw new AgentCardRegistryError('room must provide a canonical roomId');
  }

  let roomId: RoomId;
  try {
    roomId = assertValidRoomId(roomIdValue);
  } catch {
    throw new AgentCardRegistryError('room must provide a canonical r1 roomId');
  }

  const suppliedStorageKey =
    options.storageKey ?? ('storageKey' in source ? source.storageKey : undefined);
  if (
    options.storageKey !== undefined &&
    'storageKey' in source &&
    source.storageKey !== undefined &&
    source.storageKey !== options.storageKey
  ) {
    throw new AgentCardRegistryError('room storage keys disagree');
  }
  const storageKey = suppliedStorageKey ?? roomId;
  if (!isSafeStorageKey(storageKey)) {
    throw new AgentCardRegistryError('room storageKey must be a safe filesystem component');
  }

  return Object.freeze({ roomId, storageKey });
}

/** Compatibility aliases for the explicit discovery room adapter. */
export const adaptResolvedRoom = resolveAgentCardRoom;
export const toRoomStorageIdentity = resolveAgentCardRoom;
export const roomStorageIdentityFromResolvedRoom = resolveAgentCardRoom;

/** Map P2P-008's runtimeId vocabulary without shortening or regenerating it. */
export function runtimeInstanceIdFromRuntimeId(runtimeId: RuntimeId | string): RuntimeId {
  return asRuntimeId(runtimeId);
}

export const mapRuntimeIdToRuntimeInstanceId = runtimeInstanceIdFromRuntimeId;
export const toRuntimeInstanceId = runtimeInstanceIdFromRuntimeId;

export interface AgentCardPathOptions extends PrivateFilesystemOptions {
  readonly rootDirectory?: string;
  readonly registryRoot?: string;
  readonly root?: string;
  readonly runtimeRoot?: string | RuntimeRootSelection;
  readonly rootOptions?: RuntimeRootOptions;
  /** Optional already-derived key when the room argument carries only roomId. */
  readonly storageKey?: string;
}

export interface AgentCardListingOptions extends AgentCardPathOptions {
  readonly now?: number | Date;
  readonly maxCardBytes?: number;
  readonly maxEntries?: number;
  readonly maxDurationMs?: number;
}

export interface AgentCardCleanupOptions extends AgentCardListingOptions {
  readonly ttlMs?: number;
  readonly runtimeInstanceId?: RuntimeId | string;
}

export interface AgentCardRemovalOptions extends AgentCardPathOptions {
  readonly expectedSessionId?: SessionId | string;
  readonly expectedEndpoint?: string | Pick<EndpointDescriptor, 'kind' | 'address'>;
}

export interface AgentCardMetadataPatch {
  readonly displayName?: string | null;
  readonly purpose?: string | null;
  readonly workingDirectoryLabel?: string | null;
  readonly roleTags?: readonly string[];
  readonly model?: AgentModel | null;
  readonly capabilities?: AgentCapabilities;
  readonly state?: AgentState;
  readonly contextUsage?: ContextUsage | null;
  readonly inboundQueueDepth?: number;
  readonly endpoint?: Partial<EndpointDescriptor>;
}

export type AgentCardEndpointInput = Omit<EndpointDescriptor, 'runtimeInstanceId'> &
  Partial<Pick<EndpointDescriptor, 'runtimeInstanceId'>>;

export interface AgentCardRegistryOptions extends AgentCardPathOptions {
  readonly room?: AgentCardRoomInput;
  readonly roomIdentity?: AgentCardRoomInput;
  readonly identity?: RuntimeIdentity;
  readonly runtimeIdentity?: RuntimeIdentity;
  readonly runtimeId?: RuntimeId | string;
  readonly runtimeInstanceId?: RuntimeId | string;
  readonly sessionId?: SessionId | string;
  readonly displayName?: string | null;
  readonly name?: string | null;
  readonly endpoint?: AgentCardEndpointInput;
  readonly card?: Partial<AgentCard>;
  readonly metadata?: AgentCardMetadataPatch;
  readonly capabilities?: AgentCapabilities;
  readonly runtimeStartedAt?: LeaseTimestamp;
  readonly ttlMs?: number;
  readonly renewalIntervalMs?: number;
  readonly clock?: LeaseClock;
  readonly now?: LeaseClock | number | Date;
  readonly scheduler?: LeaseScheduler;
  readonly onLeaseError?: (error: unknown) => void;
  readonly maxCardBytes?: number;
}

export interface AgentCardPeerRecord extends PeerRecordLike {
  readonly runtimeId: RuntimeId;
  readonly roomId: RoomId;
  readonly networkName: PublishedNetworkName;
  readonly runtimeInstanceId: string;
  readonly displayName: string;
  readonly endpoint: EndpointDescriptor;
  readonly card: AgentCard;
}

export interface AgentCardCleanupResult {
  readonly cardsRemoved: number;
  readonly temporaryFilesRemoved: number;
  readonly totalRemoved: number;
}

export class AgentCardRegistryError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'AgentCardRegistryError';
  }
}

interface MutableCardMetadata {
  protocolVersion: AgentCard['protocolVersion'];
  displayName: string;
  purpose: string | null;
  workingDirectoryLabel: string | null;
  roleTags: readonly string[];
  model: AgentModel | null;
  capabilities: AgentCapabilities;
  state: AgentState;
  contextUsage: ContextUsage | null;
  inboundQueueDepth: number;
  endpoint: AgentCardEndpointInput;
}

interface CardCandidate {
  readonly card: AgentCard;
  readonly path: string;
  readonly snapshot: FileStatSnapshot;
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String(error.code)
    : undefined;
}

function isMissing(error: unknown): boolean {
  return errorCode(error) === 'ENOENT';
}

function absoluteDeadline(options: AgentCardPathOptions, maxDurationMs: number): number {
  const startedAt = Date.now();
  const configured = options.deadlineMs ?? Number.MAX_SAFE_INTEGER;
  if (!Number.isSafeInteger(configured) || configured < 0) {
    throw new AgentCardRegistryError('deadlineMs must be a non-negative safe integer');
  }
  if (!Number.isSafeInteger(maxDurationMs) || maxDurationMs < 0) {
    throw new AgentCardRegistryError('maxDurationMs must be a non-negative safe integer');
  }
  return Math.min(configured, startedAt + maxDurationMs);
}

function positiveDuration(value: number | undefined, fallback: number, label: string): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result <= 0) {
    throw new AgentCardRegistryError(`${label} must be a positive safe integer`);
  }
  return result;
}

function boundedEntries(value: number | undefined): number {
  const result = value ?? DEFAULT_AGENT_CARD_SCAN_MAX_ENTRIES;
  if (!Number.isSafeInteger(result) || result < 0) {
    throw new AgentCardRegistryError('maxEntries must be a non-negative safe integer');
  }
  return result;
}

function nowValue(value: number | Date | undefined): number {
  const result = value instanceof Date ? value.getTime() : (value ?? Date.now());
  if (!Number.isSafeInteger(result) || result < 0) {
    throw new AgentCardRegistryError('now must be a non-negative safe integer timestamp');
  }
  return result;
}

function clockFrom(value: LeaseClock | number | Date | undefined): LeaseClock {
  if (typeof value === 'function') {
    return () => nowValue(value());
  }
  const fixed = value === undefined ? undefined : nowValue(value);
  return fixed === undefined ? () => nowValue(undefined) : () => fixed;
}

function explicitRoot(options: AgentCardPathOptions): string | undefined {
  const values = [options.rootDirectory, options.registryRoot, options.root].filter(
    (value): value is string => value !== undefined,
  );
  if (new Set(values).size > 1) {
    throw new AgentCardRegistryError('rootDirectory, registryRoot, and root disagree');
  }
  return values[0];
}

function runtimeRootFor(options: AgentCardPathOptions): string | RuntimeRootSelection {
  if (options.runtimeRoot !== undefined) {
    return options.runtimeRoot;
  }
  const configured = explicitRoot(options);
  if (configured !== undefined) {
    return configured;
  }
  return resolveRuntimeRoot({
    ...(options.rootOptions ?? {}),
    ...(options.platform === undefined ? {} : { platform: options.platform }),
    ...(options.uid === undefined ? {} : { uid: options.uid }),
  });
}

function filesystemOptions(options: AgentCardPathOptions): PrivateFilesystemOptions {
  return {
    platform: options.platform,
    uid: options.uid,
    windowsAcl: options.windowsAcl,
    deadlineMs: options.deadlineMs,
  };
}

function snapshot(stats: Stats): FileStatSnapshot {
  return {
    device: stats.dev,
    inode: stats.ino,
    size: stats.size,
    modifiedAt: stats.mtimeMs,
  };
}

function sameSnapshot(left: FileStatSnapshot, right: FileStatSnapshot): boolean {
  return (
    left.device === right.device &&
    left.inode === right.inode &&
    left.size === right.size &&
    left.modifiedAt === right.modifiedAt
  );
}

function privateDirectory(stats: Stats, options: AgentCardPathOptions): boolean {
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    return false;
  }
  if ((options.platform ?? process.platform) === 'win32') {
    return true;
  }
  const uid = options.uid ?? (typeof process.getuid === 'function' ? process.getuid() : undefined);
  return (uid === undefined || stats.uid === uid) && (stats.mode & 0o7777) === 0o700;
}

function privateFile(stats: Stats, options: AgentCardPathOptions): boolean {
  if (!stats.isFile() || stats.isSymbolicLink()) {
    return false;
  }
  if ((options.platform ?? process.platform) === 'win32') {
    return true;
  }
  const uid = options.uid ?? (typeof process.getuid === 'function' ? process.getuid() : undefined);
  return (uid === undefined || stats.uid === uid) && (stats.mode & 0o7777) === 0o600;
}

async function privateTree(paths: RegistryPaths, options: AgentCardPathOptions): Promise<boolean> {
  try {
    const stats = await Promise.all(
      [paths.rootDirectory, paths.roomsDirectory, paths.roomDirectory, paths.agentsDirectory].map(
        (path) => lstat(path),
      ),
    );
    return stats.every((statsValue) => privateDirectory(statsValue, options));
  } catch {
    return false;
  }
}

function cardFileName(runtimeInstanceId: string): string {
  return `${runtimeInstanceId}.json`;
}

async function readCandidate(
  paths: RegistryPaths,
  fileName: string,
  options: AgentCardListingOptions,
  requireUnexpired: boolean,
  now: number,
): Promise<CardCandidate | undefined> {
  if (!fileName.endsWith('.json')) {
    return undefined;
  }
  const runtimeInstanceId = fileName.slice(0, -'.json'.length);
  if (cardFileName(runtimeInstanceId) !== fileName) {
    return undefined;
  }

  let path: string;
  try {
    path = buildAgentCardPath(paths.rootDirectory, paths.storageKey, runtimeInstanceId);
  } catch {
    return undefined;
  }

  const maxCardBytes = Math.min(
    options.maxCardBytes ?? MAX_AGENT_CARD_SIZE_BYTES,
    MAX_AGENT_CARD_SIZE_BYTES,
  );
  if (!Number.isSafeInteger(maxCardBytes) || maxCardBytes <= 0) {
    return undefined;
  }

  let firstStats: Stats;
  try {
    firstStats = await lstat(path);
  } catch {
    return undefined;
  }
  if (!privateFile(firstStats, options) || firstStats.size > maxCardBytes) {
    return undefined;
  }

  let source: string;
  try {
    const bytes = await readFile(path);
    source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }

  let secondStats: Stats;
  try {
    secondStats = await lstat(path);
  } catch {
    return undefined;
  }
  if (
    !privateFile(secondStats, options) ||
    secondStats.size > maxCardBytes ||
    !sameSnapshot(snapshot(firstStats), snapshot(secondStats))
  ) {
    return undefined;
  }

  const validationOptions: AgentCardValidationOptions = {
    expectedRoomId: paths.roomId,
    expectedRuntimeInstanceId: runtimeInstanceId,
    expectedRecordFileName: fileName,
    maxCardSizeBytes: maxCardBytes,
    requireUnexpired,
    now,
  };
  const validation = parseAgentCardJson(source, validationOptions);
  if (!validation.valid || validation.card === undefined) {
    return undefined;
  }
  return { card: validation.card, path, snapshot: snapshot(secondStats) };
}

async function finalCardNames(
  paths: RegistryPaths,
  options: AgentCardListingOptions,
  deadlineMs: number,
): Promise<string[]> {
  const maxEntries = boundedEntries(options.maxEntries);
  if (maxEntries === 0 || Date.now() >= deadlineMs || !(await privateTree(paths, options))) {
    return [];
  }

  let directory;
  try {
    directory = await opendir(paths.agentsDirectory);
  } catch {
    return [];
  }

  const names: string[] = [];
  try {
    for await (const entry of directory) {
      if (names.length >= maxEntries || Date.now() >= deadlineMs) {
        break;
      }
      if (entry.name.endsWith('.json') && !entry.name.includes('.tmp-')) {
        names.push(entry.name);
      }
    }
  } finally {
    await directory.close().catch(() => undefined);
  }
  return names.sort();
}

function buildPaths(room: AgentCardRoomInput, options: AgentCardPathOptions): RegistryPaths {
  return buildRegistryPaths(runtimeRootFor(options), resolveAgentCardRoom(room, options));
}

function peerFromCard(card: AgentCard): AgentCardPeerRecord {
  const runtimeId = runtimeInstanceIdFromRuntimeId(card.runtimeInstanceId);
  const roomId = assertValidRoomId(card.roomId);
  const base = isPublishedNetworkName(card.displayName)
    ? publishedNetworkBase(card.displayName)
    : card.displayName;
  const networkName = buildNetworkName(base, runtimeId);
  return Object.freeze({
    ...card,
    runtimeId,
    roomId,
    networkName,
    runtimeInstanceId: card.runtimeInstanceId,
    displayName: card.displayName,
    endpoint: card.endpoint,
    card,
  });
}

/** List valid, unexpired Agent Cards in one exact room. */
export async function listLiveAgentCards(
  room: AgentCardRoomInput,
  options: AgentCardListingOptions = {},
): Promise<AgentCard[]> {
  const paths = buildPaths(room, options);
  const now = nowValue(options.now);
  const deadlineMs = absoluteDeadline(
    options,
    options.maxDurationMs ?? DEFAULT_AGENT_CARD_SCAN_TIME_BUDGET_MS,
  );
  const cards: AgentCard[] = [];
  for (const fileName of await finalCardNames(paths, options, deadlineMs)) {
    if (Date.now() >= deadlineMs) {
      break;
    }
    const candidate = await readCandidate(paths, fileName, options, true, now);
    if (candidate !== undefined) {
      cards.push(candidate.card);
    }
  }
  return cards;
}

/** List valid live cards in the lookup module's collision-safe peer shape. */
export async function listLiveAgentCardPeers(
  room: AgentCardRoomInput,
  options: AgentCardListingOptions = {},
): Promise<AgentCardPeerRecord[]> {
  return (await listLiveAgentCards(room, options)).map(peerFromCard);
}

export const listAgentCards = listLiveAgentCards;
export const listLiveCards = listLiveAgentCards;
export const listAgentCardPeers = listLiveAgentCardPeers;
export const listLivePeers = listLiveAgentCardPeers;

/** Read one exact card without adapting it into a legacy RuntimeRecord. */
export async function readAgentCard(
  room: AgentCardRoomInput,
  runtimeInstanceId: RuntimeId | string,
  options: AgentCardListingOptions = {},
): Promise<AgentCard | undefined> {
  const identity = runtimeInstanceIdFromRuntimeId(runtimeInstanceId);
  const paths = buildPaths(room, options);
  if (!(await privateTree(paths, options))) {
    return undefined;
  }
  return (await readCandidate(paths, cardFileName(identity), options, false, nowValue(options.now)))
    ?.card;
}

function endpointMatches(
  card: AgentCard,
  expectedEndpoint: string | Pick<EndpointDescriptor, 'kind' | 'address'> | undefined,
): boolean {
  if (expectedEndpoint === undefined) {
    return true;
  }
  if (typeof expectedEndpoint === 'string') {
    return card.endpoint.address === expectedEndpoint;
  }
  return (
    card.endpoint.kind === expectedEndpoint.kind &&
    card.endpoint.address === expectedEndpoint.address
  );
}

/** Remove only an exact, currently matching Agent Card owner. */
export async function removeAgentCard(
  room: AgentCardRoomInput,
  runtimeInstanceId: RuntimeId | string,
  options: AgentCardRemovalOptions = {},
): Promise<boolean> {
  const identity = runtimeInstanceIdFromRuntimeId(runtimeInstanceId);
  const paths = buildPaths(room, options);
  if (!(await privateTree(paths, options))) {
    return false;
  }
  const target = buildAgentCardPath(paths.rootDirectory, paths.storageKey, identity);
  const lockOptions: PrivateFilesystemOptions = filesystemOptions(options);
  const result = await withAgentCardWriteLock(
    target,
    async () => {
      const candidate = await readCandidate(
        paths,
        cardFileName(identity),
        options,
        false,
        Date.now(),
      );
      if (
        candidate === undefined ||
        candidate.card.runtimeInstanceId !== identity ||
        (options.expectedSessionId !== undefined &&
          candidate.card.sessionId !== asSessionId(options.expectedSessionId)) ||
        !endpointMatches(candidate.card, options.expectedEndpoint)
      ) {
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
    lockOptions,
  );
  return result === true;
}

export const removeExactAgentCard = removeAgentCard;
export const removeAgentCardExactOwner = removeAgentCard;

async function removeStaleCandidate(
  paths: RegistryPaths,
  fileName: string,
  expectedCandidate: CardCandidate,
  options: AgentCardCleanupOptions,
  now: number,
  staleBefore: number,
  deadlineMs: number,
): Promise<boolean> {
  const runtimeInstanceId = fileName.slice(0, -'.json'.length);
  const target = buildAgentCardPath(paths.rootDirectory, paths.storageKey, runtimeInstanceId);
  const result = await withAgentCardWriteLock(
    target,
    async () => {
      if (Date.now() >= deadlineMs) {
        return false;
      }
      const candidate = await readCandidate(paths, fileName, options, false, now);
      if (candidate === undefined) {
        return false;
      }
      if (
        !sameSnapshot(candidate.snapshot, expectedCandidate.snapshot) ||
        candidate.card.sessionId !== expectedCandidate.card.sessionId ||
        candidate.card.endpoint.kind !== expectedCandidate.card.endpoint.kind ||
        candidate.card.endpoint.address !== expectedCandidate.card.endpoint.address ||
        candidate.card.runtimeStartedAt !== expectedCandidate.card.runtimeStartedAt
      ) {
        return false;
      }
      if (
        options.runtimeInstanceId !== undefined &&
        runtimeInstanceId !== runtimeInstanceIdFromRuntimeId(options.runtimeInstanceId)
      ) {
        return false;
      }
      let expiry: number;
      try {
        expiry = parseLeaseTimestamp(candidate.card.leaseExpiresAt);
      } catch {
        return false;
      }
      if (
        candidate.card.runtimeInstanceId !== runtimeInstanceId ||
        candidate.card.endpoint.runtimeInstanceId !== runtimeInstanceId ||
        expiry > staleBefore ||
        !isLeaseExpired(expiry, now)
      ) {
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
    { ...filesystemOptions(options), deadlineMs },
  );
  return result === true;
}

async function cleanupAgentCardStateInternal(
  room: AgentCardRoomInput,
  options: AgentCardCleanupOptions,
): Promise<AgentCardCleanupResult> {
  const paths = buildPaths(room, options);
  const now = nowValue(options.now);
  const ttlMs = positiveDuration(options.ttlMs, DEFAULT_LEASE_TTL_MS, 'ttlMs');
  const graceMs = ttlMs * 2;
  if (!Number.isSafeInteger(graceMs)) {
    throw new AgentCardRegistryError('ttlMs is too large for stale cleanup');
  }
  const staleBefore = now - graceMs;
  const deadlineMs = absoluteDeadline(
    options,
    options.maxDurationMs ?? DEFAULT_AGENT_CARD_SCAN_TIME_BUDGET_MS,
  );
  const names = await finalCardNames(paths, options, deadlineMs);
  let cardsRemoved = 0;
  for (const fileName of names) {
    if (Date.now() >= deadlineMs) {
      break;
    }
    const candidate = await readCandidate(paths, fileName, options, false, now);
    if (candidate === undefined) {
      continue;
    }
    let expiry: number;
    try {
      expiry = parseLeaseTimestamp(candidate.card.leaseExpiresAt);
    } catch {
      continue;
    }
    if (expiry > staleBefore || !isLeaseExpired(expiry, now)) {
      continue;
    }
    if (
      options.runtimeInstanceId !== undefined &&
      candidate.card.runtimeInstanceId !== runtimeInstanceIdFromRuntimeId(options.runtimeInstanceId)
    ) {
      continue;
    }
    if (
      await removeStaleCandidate(paths, fileName, candidate, options, now, staleBefore, deadlineMs)
    ) {
      cardsRemoved += 1;
    }
  }

  const temporaryFilesRemoved = await cleanupAbandonedTemporaryFiles(paths.agentsDirectory, {
    ...filesystemOptions(options),
    minAgeMs: graceMs,
    now,
    runtimeInstanceId:
      options.runtimeInstanceId === undefined
        ? undefined
        : runtimeInstanceIdFromRuntimeId(options.runtimeInstanceId),
    maxEntries: options.maxEntries ?? DEFAULT_ABANDONED_TEMP_MAX_ENTRIES,
    maxDurationMs: Math.max(0, deadlineMs - Date.now()),
    deadlineMs,
  });
  return {
    cardsRemoved,
    temporaryFilesRemoved,
    totalRemoved: cardsRemoved + temporaryFilesRemoved,
  };
}

/** Remove only cards expired for two additional canonical TTLs plus old temps. */
export async function cleanupAgentCardState(
  room: AgentCardRoomInput,
  options: AgentCardCleanupOptions = {},
): Promise<AgentCardCleanupResult> {
  return cleanupAgentCardStateInternal(room, options);
}

export async function cleanupStaleAgentCards(
  room: AgentCardRoomInput,
  options: AgentCardCleanupOptions = {},
): Promise<number> {
  return (await cleanupAgentCardStateInternal(room, options)).totalRemoved;
}

export const cleanupStaleCards = cleanupStaleAgentCards;
export const cleanupAgentCards = cleanupStaleAgentCards;

function resolveRuntimeIdentity(
  options: AgentCardRegistryOptions,
  card: Partial<AgentCard>,
): {
  readonly runtimeId: RuntimeId;
  readonly sessionId: SessionId;
} {
  const identity = options.identity ?? options.runtimeIdentity;
  const runtimeValue =
    options.runtimeInstanceId ?? options.runtimeId ?? identity?.runtimeId ?? card.runtimeInstanceId;
  const sessionValue = options.sessionId ?? identity?.sessionId ?? card.sessionId;
  if (runtimeValue === undefined || sessionValue === undefined) {
    throw new AgentCardRegistryError('runtimeId/runtimeInstanceId and sessionId are required');
  }
  try {
    const runtimeId = asRuntimeId(runtimeValue);
    const sessionId = asSessionId(sessionValue);
    if (
      identity !== undefined &&
      (identity.runtimeId !== runtimeId || identity.sessionId !== sessionId)
    ) {
      throw new AgentCardRegistryError('runtime identity conflicts with explicit identity fields');
    }
    if (card.runtimeInstanceId !== undefined && card.runtimeInstanceId !== runtimeId) {
      throw new AgentCardRegistryError('card runtimeInstanceId does not match the owner');
    }
    if (card.sessionId !== undefined && card.sessionId !== sessionId) {
      throw new AgentCardRegistryError('card sessionId does not match the owner');
    }
    return { runtimeId, sessionId };
  } catch (error) {
    if (error instanceof AgentCardRegistryError) {
      throw error;
    }
    throw new AgentCardRegistryError('runtimeId/runtimeInstanceId or sessionId is invalid');
  }
}

function endpointFromOptions(
  options: AgentCardRegistryOptions,
  card: Partial<AgentCard>,
  metadata: AgentCardMetadataPatch,
  runtimeId: RuntimeId,
): AgentCardEndpointInput {
  const supplied = options.endpoint ?? card.endpoint;
  if (supplied === undefined) {
    throw new AgentCardRegistryError('endpoint is required');
  }
  const kind = metadata.endpoint?.kind ?? supplied.kind;
  const address = metadata.endpoint?.address ?? supplied.address;
  const endpointRuntimeId = supplied.runtimeInstanceId ?? metadata.endpoint?.runtimeInstanceId;
  if (endpointRuntimeId !== undefined && endpointRuntimeId !== runtimeId) {
    throw new AgentCardRegistryError('endpoint.runtimeInstanceId does not match the owner');
  }
  return { kind, address, runtimeInstanceId: runtimeId };
}

function copyMetadata(
  options: AgentCardRegistryOptions,
  card: Partial<AgentCard>,
  metadata: AgentCardMetadataPatch,
  runtimeId: RuntimeId,
): MutableCardMetadata {
  const displayName =
    options.displayName ?? options.name ?? metadata.displayName ?? card.displayName ?? undefined;
  return {
    protocolVersion: card.protocolVersion ?? AGENT_CARD_PROTOCOL_VERSION,
    displayName: displayName?.trim() || `pi-to-pi-${runtimeId.replaceAll('-', '').slice(-12)}`,
    purpose: metadata.purpose ?? card.purpose ?? null,
    workingDirectoryLabel: metadata.workingDirectoryLabel ?? card.workingDirectoryLabel ?? null,
    roleTags: Object.freeze([...(metadata.roleTags ?? card.roleTags ?? [])]),
    model: metadata.model === undefined ? (card.model ?? null) : metadata.model,
    capabilities:
      options.capabilities ??
      metadata.capabilities ??
      card.capabilities ??
      DEFAULT_AGENT_CARD_CAPABILITIES,
    state: metadata.state ?? card.state ?? 'idle',
    contextUsage:
      metadata.contextUsage === undefined ? (card.contextUsage ?? null) : metadata.contextUsage,
    inboundQueueDepth: metadata.inboundQueueDepth ?? card.inboundQueueDepth ?? 0,
    endpoint: endpointFromOptions(options, card, metadata, runtimeId),
  };
}

/** High-level owner boundary for Agent Card publication and renewal. */
export class AgentCardRegistry {
  public readonly room: RoomStorageIdentity;
  public readonly roomId: RoomId;
  public readonly storageKey: string;
  public readonly runtimeId: RuntimeId;
  public readonly runtimeInstanceId: RuntimeId;
  public readonly sessionId: SessionId;
  public readonly ttlMs: number;
  public readonly renewalIntervalMs: number;
  public readonly lease: SerializedLease;

  private readonly pathOptions: AgentCardPathOptions;
  private readonly clock: LeaseClock;
  private readonly runtimeStartedAt: string;
  private readonly maxCardBytes: number;
  private metadata: MutableCardMetadata;
  private treePromise: Promise<RuntimeTree> | undefined;
  private currentCardValue: AgentCard | undefined;
  private pendingPublication: Promise<void> = Promise.resolve();
  private shutdownRequested = false;
  private shutdownPromise: Promise<boolean> | undefined;

  public constructor(options: AgentCardRegistryOptions) {
    const roomInput = options.room ?? options.roomIdentity;
    if (roomInput === undefined) {
      throw new AgentCardRegistryError('room or roomIdentity is required');
    }
    this.room = resolveAgentCardRoom(roomInput, { storageKey: options.storageKey });
    this.roomId = this.room.roomId as RoomId;
    this.storageKey = this.room.storageKey;
    const card = options.card ?? {};
    const identity = resolveRuntimeIdentity(options, card);
    this.runtimeId = identity.runtimeId;
    this.runtimeInstanceId = identity.runtimeId;
    this.sessionId = identity.sessionId;
    this.pathOptions = {
      rootDirectory: options.rootDirectory,
      registryRoot: options.registryRoot,
      root: options.root,
      runtimeRoot: options.runtimeRoot,
      rootOptions: options.rootOptions,
      storageKey: options.storageKey,
      platform: options.platform,
      uid: options.uid,
      windowsAcl: options.windowsAcl,
      deadlineMs: options.deadlineMs,
    };
    this.clock = clockFrom(options.clock ?? options.now);
    this.metadata = copyMetadata(options, card, options.metadata ?? {}, this.runtimeId);
    const startInput = options.runtimeStartedAt ?? card.runtimeStartedAt ?? this.clock();
    try {
      this.runtimeStartedAt = serializeLeaseTimestamp(startInput, 'runtimeStartedAt');
    } catch {
      throw new AgentCardRegistryError('runtimeStartedAt is invalid');
    }
    this.maxCardBytes = Math.min(
      options.maxCardBytes ?? MAX_AGENT_CARD_SIZE_BYTES,
      MAX_AGENT_CARD_SIZE_BYTES,
    );
    if (!Number.isSafeInteger(this.maxCardBytes) || this.maxCardBytes <= 0) {
      throw new AgentCardRegistryError('maxCardBytes must be a positive safe integer');
    }
    this.lease = new SerializedLease({
      renew: () => this.enqueuePublication(() => this.publishCurrentCard()).then(() => undefined),
      ttlMs: options.ttlMs,
      renewalIntervalMs: options.renewalIntervalMs,
      scheduler: options.scheduler,
      now: this.clock,
      onError: options.onLeaseError,
    });
    this.ttlMs = this.lease.ttlMs;
    this.renewalIntervalMs = this.lease.renewalIntervalMs;
  }

  public current(): AgentCard | undefined {
    return this.currentCardValue;
  }

  public get currentCard(): AgentCard | undefined {
    return this.currentCardValue;
  }

  public async getPaths(): Promise<RuntimeTree> {
    return this.ensureTree();
  }

  private ensureTree(): Promise<RuntimeTree> {
    if (this.treePromise === undefined) {
      this.treePromise = createPrivateRuntimeTree(
        runtimeRootFor(this.pathOptions),
        this.room,
        filesystemOptions(this.pathOptions),
      );
    }
    return this.treePromise;
  }

  private enqueuePublication<T>(operation: () => Promise<T>): Promise<T> {
    const queued = this.pendingPublication.then(operation, operation);
    this.pendingPublication = queued.then(
      () => undefined,
      () => undefined,
    );
    return queued;
  }

  private buildCard(): AgentCard {
    const now = this.clock();
    const draft: AgentCardDraft = {
      protocolVersion: this.metadata.protocolVersion,
      sessionId: this.sessionId,
      runtimeInstanceId: this.runtimeInstanceId,
      displayName: this.metadata.displayName,
      roomId: this.roomId,
      purpose: this.metadata.purpose,
      workingDirectoryLabel: this.metadata.workingDirectoryLabel,
      roleTags: this.metadata.roleTags,
      model: this.metadata.model,
      capabilities: this.metadata.capabilities,
      state: this.metadata.state,
      contextUsage: this.metadata.contextUsage,
      inboundQueueDepth: this.metadata.inboundQueueDepth,
      endpoint: this.metadata.endpoint,
      runtimeStartedAt: this.runtimeStartedAt,
      leaseExpiresAt: leaseExpiration({ now, ttlMs: this.ttlMs }),
    };
    return createAgentCard(draft);
  }

  private async publishCurrentCard(): Promise<AgentCard> {
    if (this.shutdownRequested || this.lease.stopped) {
      throw new AgentCardRegistryError('cannot publish a stopped Agent Card registry');
    }
    const card = this.buildCard();
    const tree = await this.ensureTree();
    await writeAgentCardAtomically(tree, this.runtimeInstanceId, card, {
      ...filesystemOptions(this.pathOptions),
      maxCardBytes: this.maxCardBytes,
    });
    this.currentCardValue = card;
    return card;
  }

  /** Publish once and renew periodically. */
  public start(): Promise<void> {
    return this.lease.start();
  }

  public renew(): Promise<void> {
    return this.lease.renew();
  }

  public publish(): Promise<void> {
    return this.renew();
  }

  public updateMetadata(patch: AgentCardMetadataPatch): Promise<AgentCard> {
    return this.enqueuePublication(async () => {
      if (this.shutdownRequested || this.lease.stopped) {
        throw new AgentCardRegistryError('cannot update a stopped Agent Card registry');
      }
      if (
        patch.endpoint?.runtimeInstanceId !== undefined &&
        patch.endpoint.runtimeInstanceId !== this.runtimeInstanceId
      ) {
        throw new AgentCardRegistryError('endpoint.runtimeInstanceId does not match the owner');
      }
      const previous = this.metadata;
      const endpoint = patch.endpoint
        ? {
            ...this.metadata.endpoint,
            ...patch.endpoint,
            runtimeInstanceId: this.runtimeInstanceId,
          }
        : this.metadata.endpoint;
      this.metadata = {
        ...this.metadata,
        ...(patch.displayName === undefined
          ? {}
          : {
              displayName:
                patch.displayName?.trim() ||
                `pi-to-pi-${this.runtimeId.replaceAll('-', '').slice(-12)}`,
            }),
        ...(patch.purpose === undefined ? {} : { purpose: patch.purpose }),
        ...(patch.workingDirectoryLabel === undefined
          ? {}
          : { workingDirectoryLabel: patch.workingDirectoryLabel }),
        ...(patch.roleTags === undefined ? {} : { roleTags: Object.freeze([...patch.roleTags]) }),
        ...(patch.model === undefined ? {} : { model: patch.model }),
        ...(patch.capabilities === undefined ? {} : { capabilities: patch.capabilities }),
        ...(patch.state === undefined ? {} : { state: patch.state }),
        ...(patch.contextUsage === undefined ? {} : { contextUsage: patch.contextUsage }),
        ...(patch.inboundQueueDepth === undefined
          ? {}
          : { inboundQueueDepth: patch.inboundQueueDepth }),
        endpoint,
      };
      try {
        return await this.publishCurrentCard();
      } catch (error) {
        this.metadata = previous;
        throw error;
      }
    });
  }

  public update(patch: AgentCardMetadataPatch): Promise<AgentCard> {
    return this.updateMetadata(patch);
  }

  public updateCardMetadata(patch: AgentCardMetadataPatch): Promise<AgentCard> {
    return this.updateMetadata(patch);
  }

  /** List this registry's exact room through the Agent Card authority. */
  public listLiveCards(
    options: Omit<AgentCardListingOptions, keyof AgentCardPathOptions> = {},
  ): Promise<AgentCard[]> {
    return listLiveAgentCards(this.room, { ...this.pathOptions, ...options });
  }

  public listPeers(
    options: Omit<AgentCardListingOptions, keyof AgentCardPathOptions> = {},
  ): Promise<AgentCardPeerRecord[]> {
    return listLiveAgentCardPeers(this.room, { ...this.pathOptions, ...options });
  }

  public lookupPeerByName(
    name: string,
    options: Omit<AgentCardListingOptions, keyof AgentCardPathOptions> = {},
  ): Promise<PeerLookupResult<AgentCardPeerRecord>> {
    return this.listPeers(options).then((records) => lookupPeerByName(name, this.room, records));
  }

  public lookupPeerByRuntimeId(
    runtimeId: RuntimeId | string,
    options: Omit<AgentCardListingOptions, keyof AgentCardPathOptions> = {},
  ): Promise<PeerLookupResult<AgentCardPeerRecord>> {
    return this.listPeers(options).then((records) =>
      lookupPeerByRuntimeId(runtimeId, this.room, records),
    );
  }

  public cleanupStale(
    options: Omit<AgentCardCleanupOptions, keyof AgentCardPathOptions> = {},
  ): Promise<number> {
    return cleanupStaleAgentCards(this.room, { ...this.pathOptions, ...options });
  }

  public cleanup(
    options: Omit<AgentCardCleanupOptions, keyof AgentCardPathOptions> = {},
  ): Promise<number> {
    return this.cleanupStale(options);
  }

  /** Stop renewal and remove only this exact owner card. */
  public shutdown(): Promise<boolean> {
    if (this.shutdownPromise === undefined) {
      this.shutdownRequested = true;
      this.shutdownPromise = (async () => {
        await this.lease.stop();
        await this.pendingPublication;
        const removed = await removeAgentCard(this.room, this.runtimeInstanceId, {
          ...this.pathOptions,
          expectedSessionId: this.sessionId,
          expectedEndpoint: {
            kind: this.metadata.endpoint.kind,
            address: this.metadata.endpoint.address,
          },
        });
        this.currentCardValue = undefined;
        return removed;
      })();
    }
    return this.shutdownPromise;
  }

  public remove(): Promise<boolean> {
    return this.shutdown();
  }

  public close(): Promise<boolean> {
    return this.shutdown();
  }
}

export function createAgentCardRegistry(options: AgentCardRegistryOptions): AgentCardRegistry {
  return new AgentCardRegistry(options);
}

export const createDiscoveryAgentCardRegistry = createAgentCardRegistry;
export const AgentCardRecordRegistry = AgentCardRegistry;

/** Keep the canonical lease values available at the Agent Card boundary. */
export { DEFAULT_LEASE_RENEWAL_INTERVAL_MS, LEASE_TTL_MS };
export { LEASE_TTL_MS as DEFAULT_AGENT_CARD_TTL_MS };
