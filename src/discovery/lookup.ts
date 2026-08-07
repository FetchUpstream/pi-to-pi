import {
  asRuntimeId,
  createCanonicalPeerAddress,
  isUuid,
  type CanonicalPeerAddress,
  type RuntimeId,
} from '../identity.js';
import { asRoomId, type RoomId, type RoomLike } from '../room.js';
import { isPublishedNetworkName, normalizePeerLookupName, publishedNetworkBase } from './naming.js';

/** The registry fields required by pure same-room lookup. */
export interface PeerRecordLike {
  readonly runtimeId: RuntimeId | string;
  readonly roomId: RoomId | string;
  /** Base-only and full published names are both accepted at this seam. */
  readonly networkName: string;
}

export interface PeerCandidate<TRecord extends PeerRecordLike = PeerRecordLike> {
  readonly address: CanonicalPeerAddress;
  readonly record: TRecord;
}

export interface PeerNotFoundResult {
  readonly kind: 'not-found';
  readonly query: string;
}

export interface PeerFoundResult<TRecord extends PeerRecordLike = PeerRecordLike> {
  readonly kind: 'found';
  readonly query: string;
  readonly candidate: PeerCandidate<TRecord>;
  readonly address: CanonicalPeerAddress;
  readonly record: TRecord;
}

export interface PeerAmbiguousResult<TRecord extends PeerRecordLike = PeerRecordLike> {
  readonly kind: 'ambiguous';
  readonly query: string;
  /** Every full runtime address remains available to the caller. */
  readonly candidates: readonly CanonicalPeerAddress[];
  /** Alias for callers that use the address terminology. */
  readonly addresses: readonly CanonicalPeerAddress[];
  /** The records corresponding to `candidates`, in the same order. */
  readonly records: readonly TRecord[];
  /** Rich candidates for callers that need both records and addresses. */
  readonly matches: readonly PeerCandidate<TRecord>[];
}

export interface PeerCrossRoomResult<TRecord extends PeerRecordLike = PeerRecordLike> {
  readonly kind: 'cross-room';
  readonly query: string;
  readonly currentRoom: RoomId;
  /** Every full runtime address found outside the current room. */
  readonly candidates: readonly CanonicalPeerAddress[];
  readonly addresses: readonly CanonicalPeerAddress[];
  readonly records: readonly TRecord[];
  readonly matches: readonly PeerCandidate<TRecord>[];
  readonly targetRooms: readonly RoomId[];
}

export type PeerLookupResult<TRecord extends PeerRecordLike = PeerRecordLike> =
  | PeerNotFoundResult
  | PeerFoundResult<TRecord>
  | PeerAmbiguousResult<TRecord>
  | PeerCrossRoomResult<TRecord>;

export type PeerLookupErrorCode = 'not-found' | 'ambiguous' | 'cross-room';

/** A typed error for callers that prefer throwing resolution APIs. */
export class PeerLookupError extends Error {
  public readonly code: PeerLookupErrorCode;
  public readonly query: string;

  public constructor(code: PeerLookupErrorCode, query: string, message: string) {
    super(message);
    this.name = 'PeerLookupError';
    this.code = code;
    this.query = query;
  }
}

export class PeerNotFoundError extends PeerLookupError {
  public constructor(query: string) {
    super('not-found', query, `Peer was not found: ${query}`);
    this.name = 'PeerNotFoundError';
  }
}

export class AmbiguousPeerNameError<
  TRecord extends PeerRecordLike = PeerRecordLike,
> extends PeerLookupError {
  public readonly candidates: readonly CanonicalPeerAddress[];
  public readonly addresses: readonly CanonicalPeerAddress[];
  public readonly records: readonly TRecord[];
  public readonly matches: readonly PeerCandidate<TRecord>[];

  public constructor(result: PeerAmbiguousResult<TRecord>) {
    super('ambiguous', result.query, `Peer name is ambiguous: ${result.query}`);
    this.name = 'AmbiguousPeerNameError';
    this.candidates = result.candidates;
    this.addresses = result.addresses;
    this.records = result.records;
    this.matches = result.matches;
  }
}

export class CrossRoomPeerError<
  TRecord extends PeerRecordLike = PeerRecordLike,
> extends PeerLookupError {
  public readonly currentRoom: RoomId;
  public readonly candidates: readonly CanonicalPeerAddress[];
  public readonly addresses: readonly CanonicalPeerAddress[];
  public readonly records: readonly TRecord[];
  public readonly matches: readonly PeerCandidate<TRecord>[];
  public readonly targetRooms: readonly RoomId[];

  public constructor(result: PeerCrossRoomResult<TRecord>) {
    super('cross-room', result.query, `Peer target belongs to another room: ${result.query}`);
    this.name = 'CrossRoomPeerError';
    this.currentRoom = result.currentRoom;
    this.candidates = result.candidates;
    this.addresses = result.addresses;
    this.records = result.records;
    this.matches = result.matches;
    this.targetRooms = result.targetRooms;
  }
}

interface ParsedCandidate<TRecord extends PeerRecordLike> {
  readonly candidate: PeerCandidate<TRecord>;
  readonly normalizedName: string;
}

function roomIdFromLike(room: RoomLike): RoomId {
  if (typeof room === 'string') {
    return asRoomId(room);
  }

  if ('roomId' in room) {
    return asRoomId(room.roomId);
  }

  return asRoomId(room.id);
}

function runtimeIdsEqual(left: RuntimeId, right: RuntimeId): boolean {
  return left === right;
}

function parseCandidate<TRecord extends PeerRecordLike>(
  record: TRecord,
): ParsedCandidate<TRecord> | undefined {
  if (
    typeof record.runtimeId !== 'string' ||
    typeof record.roomId !== 'string' ||
    typeof record.networkName !== 'string' ||
    record.networkName.length === 0
  ) {
    return undefined;
  }

  try {
    const runtimeId = asRuntimeId(record.runtimeId);
    const roomId = asRoomId(record.roomId);
    const normalizedName = normalizePeerLookupName(record.networkName);
    return {
      candidate: {
        address: createCanonicalPeerAddress(runtimeId, roomId),
        record,
      },
      normalizedName,
    };
  } catch {
    // The registry filters malformed records. A pure seam remains defensive when
    // supplied with an in-memory list assembled by a caller or test.
    return undefined;
  }
}

function candidateBase(normalizedName: string): string {
  return isPublishedNetworkName(normalizedName)
    ? String(publishedNetworkBase(normalizedName))
    : normalizedName;
}

function freezeMatches<TRecord extends PeerRecordLike>(
  matches: readonly PeerCandidate<TRecord>[],
): readonly PeerCandidate<TRecord>[] {
  return Object.freeze([...matches]);
}

function addressesFor<TRecord extends PeerRecordLike>(
  matches: readonly PeerCandidate<TRecord>[],
): readonly CanonicalPeerAddress[] {
  return Object.freeze(matches.map(({ address }) => address));
}

function recordsFor<TRecord extends PeerRecordLike>(
  matches: readonly PeerCandidate<TRecord>[],
): readonly TRecord[] {
  return Object.freeze(matches.map(({ record }) => record));
}

/**
 * Resolve a normalized human-facing name in one exact room.
 *
 * The input records are expected to come from `listRuntimeRecords(currentRoom)`;
 * room filtering is repeated here so this helper cannot accidentally become a
 * cross-room fallback when used with a broader in-memory collection.
 */
export function lookupPeerByName<TRecord extends PeerRecordLike>(
  name: string,
  currentRoom: RoomLike,
  records: readonly TRecord[],
): PeerLookupResult<TRecord> {
  const roomId = roomIdFromLike(currentRoom);
  const normalizedQuery = normalizePeerLookupName(name);
  const queryIsFullName = isPublishedNetworkName(normalizedQuery);
  const queryBase = queryIsFullName
    ? String(publishedNetworkBase(normalizedQuery))
    : normalizedQuery;
  const matching: PeerCandidate<TRecord>[] = [];

  for (const record of records) {
    const parsed = parseCandidate(record);
    if (parsed === undefined || parsed.candidate.address.roomId !== roomId) {
      continue;
    }

    const exactMatch = parsed.normalizedName === normalizedQuery;
    const baseMatch = queryIsFullName
      ? parsed.normalizedName === queryBase
      : candidateBase(parsed.normalizedName) === queryBase;
    if (exactMatch || baseMatch) {
      matching.push(parsed.candidate);
    }
  }

  if (matching.length === 0) {
    return { kind: 'not-found', query: normalizedQuery };
  }

  const matches = freezeMatches(matching);
  if (matches.length === 1) {
    const [candidate] = matches;
    return {
      kind: 'found',
      query: normalizedQuery,
      candidate: candidate!,
      address: candidate!.address,
      record: candidate!.record,
    };
  }

  const candidates = addressesFor(matches);
  return {
    kind: 'ambiguous',
    query: normalizedQuery,
    candidates,
    addresses: candidates,
    records: recordsFor(matches),
    matches,
  };
}

/** Resolve one exact full runtime UUID, requiring exact room equality. */
export function lookupPeerByRuntimeId<TRecord extends PeerRecordLike>(
  runtimeId: RuntimeId | string,
  currentRoom: RoomLike,
  records: readonly TRecord[],
): PeerLookupResult<TRecord> {
  const targetRuntimeId = asRuntimeId(runtimeId);
  const roomId = roomIdFromLike(currentRoom);
  const sameRoom: PeerCandidate<TRecord>[] = [];
  const otherRoom: PeerCandidate<TRecord>[] = [];

  for (const record of records) {
    const parsed = parseCandidate(record);
    if (
      parsed === undefined ||
      !runtimeIdsEqual(parsed.candidate.address.runtimeId, targetRuntimeId)
    ) {
      continue;
    }

    if (parsed.candidate.address.roomId === roomId) {
      sameRoom.push(parsed.candidate);
    } else {
      otherRoom.push(parsed.candidate);
    }
  }

  if (sameRoom.length > 1) {
    const matches = freezeMatches(sameRoom);
    const candidates = addressesFor(matches);
    return {
      kind: 'ambiguous',
      query: targetRuntimeId,
      candidates,
      addresses: candidates,
      records: recordsFor(matches),
      matches,
    };
  }

  if (sameRoom.length === 1 && otherRoom.length === 0) {
    const candidate = sameRoom[0]!;
    return {
      kind: 'found',
      query: targetRuntimeId,
      candidate,
      address: candidate.address,
      record: candidate.record,
    };
  }

  if (sameRoom.length === 0 && otherRoom.length > 0) {
    const matches = freezeMatches(otherRoom);
    const candidates = addressesFor(matches);
    return {
      kind: 'cross-room',
      query: targetRuntimeId,
      currentRoom: roomId,
      candidates,
      addresses: candidates,
      records: recordsFor(matches),
      matches,
      targetRooms: Object.freeze([...new Set(candidates.map(({ roomId: target }) => target))]),
    };
  }

  if (sameRoom.length === 1) {
    const matches = freezeMatches([...sameRoom, ...otherRoom]);
    const candidates = addressesFor(matches);
    return {
      kind: 'ambiguous',
      query: targetRuntimeId,
      candidates,
      addresses: candidates,
      records: recordsFor(matches),
      matches,
    };
  }

  return { kind: 'not-found', query: targetRuntimeId };
}

/** Resolve a name or full runtime UUID using the appropriate exact strategy. */
export function resolvePeerTarget<TRecord extends PeerRecordLike>(
  target: string,
  currentRoom: RoomLike,
  records: readonly TRecord[],
): PeerLookupResult<TRecord> {
  if (isUuid(target)) {
    return lookupPeerByRuntimeId(target, currentRoom, records);
  }

  return lookupPeerByName(target, currentRoom, records);
}

/** Throwing counterpart for protocol code that treats non-found as an error. */
export function resolvePeerTargetOrThrow<TRecord extends PeerRecordLike>(
  target: string,
  currentRoom: RoomLike,
  records: readonly TRecord[],
): PeerCandidate<TRecord> {
  const result = resolvePeerTarget(target, currentRoom, records);
  if (result.kind === 'found') {
    return result.candidate;
  }
  if (result.kind === 'ambiguous') {
    throw new AmbiguousPeerNameError(result);
  }
  if (result.kind === 'cross-room') {
    throw new CrossRoomPeerError(result);
  }
  throw new PeerNotFoundError(result.query);
}

/** Explicit aliases for integrations that already distinguish name and address. */
export const resolvePeerName = lookupPeerByName;
export const resolveRuntimeAddress = lookupPeerByRuntimeId;
export const resolvePeer = resolvePeerTarget;
