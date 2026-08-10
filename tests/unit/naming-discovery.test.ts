import { describe, expect, it } from 'vitest';

import {
  asPublishedNetworkName,
  buildNetworkName,
  createInitialPeerName,
  isPublishedNetworkName,
  isRuntimeNameSuffix,
  normalizePeerLookupName,
  normalizePeerName,
  normalizeSessionPeerName,
  publishedNetworkBase,
  runtimeNameSuffix,
  splitPublishedNetworkName,
  synchronizePeerName,
} from '../../src/discovery/naming.js';
import {
  AmbiguousPeerNameError,
  CrossRoomPeerError,
  lookupPeerByName,
  lookupPeerByRuntimeId,
  resolvePeerTarget,
  resolvePeerTargetOrThrow,
  type PeerRecordLike,
} from '../../src/discovery/lookup.js';
import { asNormalizedName } from '../../src/identity.js';
import { asRoomId, type RoomId } from '../../src/room.js';

const ROOM_A = asRoomId(`r1-${'a'.repeat(32)}`);
const ROOM_B = asRoomId(`r1-${'b'.repeat(32)}`);
const RUNTIME_A = '11111111-1111-4111-8111-111111111111';
const RUNTIME_B = '22222222-2222-4222-8222-222222222222';
const RUNTIME_C = '33333333-3333-4333-8333-333333333333';

function record(runtimeId: string, roomId: RoomId, networkName: string): PeerRecordLike {
  return { runtimeId, roomId, networkName: asPublishedNetworkName(networkName) };
}

describe('canonical runtime peer naming', () => {
  it('normalizes NFKC text, case, Unicode letters/numbers, and separator runs', () => {
    expect(asNormalizedName('  Ｐlanner / 東京 ✨ １２３  ')).toBe('planner-東京-123');
    expect(asNormalizedName('Élan 東京')).toBe('élan-東京');
  });

  it('rejects controls and explicit values that become empty', () => {
    expect(() => asNormalizedName('planner\u0000')).toThrow();
    expect(() => asNormalizedName('planner\u200b')).toThrow();
    expect(() => asNormalizedName('--- ✨ ---')).toThrow();
  });

  it('bounds the base to 48 Unicode code points and trims separator runs', () => {
    const normalized = normalizePeerName(`${'é'.repeat(60)}!!!`);
    expect(Array.from(normalized)).toHaveLength(48);
    expect(normalized).toBe('é'.repeat(48));
    expect(normalizePeerName(undefined)).toBe('agent');
    expect(normalizeSessionPeerName('---')).toBe('agent');
  });

  it('derives a deterministic lowercase Crockford suffix from the full UUID', () => {
    expect(runtimeNameSuffix(RUNTIME_A)).toBe('qnv6');
    expect(runtimeNameSuffix(RUNTIME_A)).toBe(runtimeNameSuffix(RUNTIME_A));
    expect(runtimeNameSuffix(RUNTIME_A)).not.toBe(runtimeNameSuffix(RUNTIME_B));
    expect(isRuntimeNameSuffix(runtimeNameSuffix(RUNTIME_A))).toBe(true);
    expect(runtimeNameSuffix(RUNTIME_A)).toMatch(/^[0-9a-hjkmnp-tv-z]{4}$/u);
    expect(() => runtimeNameSuffix('ABCDEFAB-CDEF-4ABC-8DEF-ABCDEFABCDEF')).toThrow(
      'canonical lowercase',
    );

    const networkName = buildNetworkName('Planner', RUNTIME_A);
    expect(networkName).toBe('planner-qnv6');
    expect(isPublishedNetworkName(networkName)).toBe(true);
    expect(publishedNetworkBase(networkName)).toBe('planner');
    expect(splitPublishedNetworkName(networkName)).toEqual({ base: 'planner', suffix: 'qnv6' });
  });

  it('retains the full published name when the base reaches the limit', () => {
    const base = 'a'.repeat(48);
    const name = buildNetworkName(base, RUNTIME_A);
    expect(Array.from(name)).toHaveLength(53);
    expect(asPublishedNetworkName(name)).toBe(name);
    expect(normalizePeerLookupName(name)).toBe(name);
  });

  it('updates only the published name and keeps the runtime suffix on native renames', () => {
    const initial = createInitialPeerName(RUNTIME_A, 'Planner');
    const renamed = synchronizePeerName(initial, 'New Session Name');

    expect(initial).toMatchObject({ runtimeId: RUNTIME_A, base: 'planner', suffix: 'qnv6' });
    expect(renamed).toMatchObject({
      runtimeId: RUNTIME_A,
      base: 'new-session-name',
      suffix: 'qnv6',
      networkName: 'new-session-name-qnv6',
    });
    expect(synchronizePeerName(initial, 'Ignored', { p2pName: 'Planner' })).toBe(initial);
  });
});

describe('same-room collision-safe peer lookup', () => {
  const plannerA = record(RUNTIME_A, ROOM_A, buildNetworkName('planner', RUNTIME_A));
  const plannerB = record(RUNTIME_B, ROOM_A, buildNetworkName('planner', RUNTIME_B));
  const otherRoom = record(RUNTIME_C, ROOM_B, buildNetworkName('planner', RUNTIME_C));

  it('returns one full runtime address for an exact published name', () => {
    const result = lookupPeerByName(plannerA.networkName, ROOM_A, [plannerA, otherRoom]);

    expect(result.kind).toBe('found');
    if (result.kind !== 'found') return;
    expect(result.address).toEqual({ runtimeId: RUNTIME_A, roomId: ROOM_A });
    expect(result.record).toBe(plannerA);
  });
  it('distinguishes exact published names from base-name collisions', () => {
    const plannerC = record(RUNTIME_C, ROOM_A, buildNetworkName('planner', RUNTIME_C));

    const exact = lookupPeerByName(plannerA.networkName, ROOM_A, [plannerA, plannerC]);
    expect(exact.kind).toBe('found');
    if (exact.kind === 'found') {
      expect(exact.address).toEqual({ runtimeId: RUNTIME_A, roomId: ROOM_A });
    }

    const base = lookupPeerByName('planner', ROOM_A, [plannerA, plannerC]);
    expect(base.kind).toBe('ambiguous');
    if (base.kind !== 'ambiguous') return;
    expect(base.candidates).toEqual([
      { runtimeId: RUNTIME_A, roomId: ROOM_A },
      { runtimeId: RUNTIME_C, roomId: ROOM_A },
    ]);
  });

  it('returns every full address for a normalized-name collision', () => {
    const result = lookupPeerByName('PLANNER', ROOM_A, [plannerA, plannerB, otherRoom]);

    expect(result.kind).toBe('ambiguous');
    if (result.kind !== 'ambiguous') return;
    expect(result.candidates).toEqual([
      { runtimeId: RUNTIME_A, roomId: ROOM_A },
      { runtimeId: RUNTIME_B, roomId: ROOM_A },
    ]);
    expect(() => resolvePeerTargetOrThrow('planner', ROOM_A, [plannerA, plannerB])).toThrow(
      AmbiguousPeerNameError,
    );
  });

  it('returns every address for a published-name suffix collision', () => {
    const suffixCollision = record(RUNTIME_C, ROOM_A, plannerA.networkName);
    const result = lookupPeerByName(plannerA.networkName, ROOM_A, [plannerA, suffixCollision]);

    expect(result.kind).toBe('ambiguous');
    if (result.kind !== 'ambiguous') return;
    expect(result.candidates).toEqual([
      { runtimeId: RUNTIME_A, roomId: ROOM_A },
      { runtimeId: RUNTIME_C, roomId: ROOM_A },
    ]);
  });
  it('never considers records from another room for name lookup', () => {
    expect(lookupPeerByName('planner', ROOM_A, [otherRoom])).toEqual({
      kind: 'not-found',
      query: 'planner',
    });
  });

  it('resolves an exact UUID only in the exact current room', () => {
    const found = lookupPeerByRuntimeId(RUNTIME_A, ROOM_A, [plannerA, otherRoom]);
    expect(found.kind).toBe('found');
    if (found.kind === 'found') {
      expect(found.address.runtimeId).toBe(RUNTIME_A);
      expect(found.address.roomId).toBe(ROOM_A);
    }
    expect(resolvePeerTargetOrThrow(RUNTIME_A, ROOM_A, [plannerA])).toMatchObject({
      address: { runtimeId: RUNTIME_A, roomId: ROOM_A },
      record: plannerA,
    });

    expect(() => resolvePeerTargetOrThrow(RUNTIME_C, ROOM_A, [otherRoom])).toThrow(
      CrossRoomPeerError,
    );

    const isolated = resolvePeerTarget(RUNTIME_C, ROOM_A, [plannerA, otherRoom]);
    expect(isolated.kind).toBe('cross-room');
    if (isolated.kind === 'cross-room') {
      expect(isolated.candidates).toEqual([{ runtimeId: RUNTIME_C, roomId: ROOM_B }]);
      expect(isolated.currentRoom).toBe(ROOM_A);
      expect(isolated.targetRooms).toEqual([ROOM_B]);
    }
  });
  it('treats malformed and uppercase UUID-shaped targets as names', () => {
    const uppercase = 'ABCDEFAB-CDEF-4ABC-8DEF-ABCDEFABCDEF';
    const malformed = '11111111-1111-0111-8111-111111111111';

    expect(() => lookupPeerByRuntimeId('qnv6', ROOM_A, [plannerA])).toThrow('full UUID');
    expect(resolvePeerTarget('qnv6', ROOM_A, [plannerA])).toEqual({
      kind: 'not-found',
      query: 'qnv6',
    });
    expect(resolvePeerTarget(uppercase, ROOM_A, [plannerA])).toEqual({
      kind: 'not-found',
      query: uppercase.toLowerCase(),
    });
    expect(resolvePeerTarget(malformed, ROOM_A, [plannerA])).toEqual({
      kind: 'not-found',
      query: malformed,
    });
  });
});
