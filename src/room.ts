/**
 * Opaque room identity contracts.
 *
 * Room derivation is intentionally implemented separately from these models.
 * Keeping the room identifier branded here prevents raw project labels and
 * filesystem paths from being passed to registry/discovery code by accident.
 */

declare const roomIdBrand: unique symbol;

/** Versioned, filesystem-safe room identifier. */
export type RoomId = string & { readonly [roomIdBrand]: 'RoomId' };

/** The source used to derive a room. */
export type RoomSource = 'explicit-project' | 'git-common-directory' | 'working-directory';

/** A resolved room and the canonical input used to derive it. */
export interface ResolvedRoom {
  readonly id: RoomId;
  readonly source: RoomSource;
  readonly input: string;
}

const ROOM_ID_PATTERN = /^r1-[a-z0-9][a-z0-9_-]*$/u;
const MAX_ROOM_ID_LENGTH = 128;

/** Return whether a value is a valid opaque room identifier. */
export function isRoomId(value: string): value is RoomId {
  return value.length <= MAX_ROOM_ID_LENGTH && ROOM_ID_PATTERN.test(value);
}

/**
 * Brand and validate a room identifier at an external boundary.
 *
 * The identifier is deliberately opaque: only the version prefix and
 * filesystem-safe alphabet are accepted. Raw paths and project labels are
 * therefore rejected before they reach a registry path builder.
 */
export function asRoomId(value: string): RoomId {
  if (!isRoomId(value)) {
    throw new Error(`Invalid room ID: ${JSON.stringify(value)}`);
  }
  return value;
}

/** Construct a resolved room without deriving or allocating any resources. */
export function createResolvedRoom(
  id: RoomId | string,
  source: RoomSource,
  input: string,
): ResolvedRoom {
  return Object.freeze({ id: asRoomId(id), source, input });
}
