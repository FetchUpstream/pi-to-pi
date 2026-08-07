import { describe, expect, it } from 'vitest';

import {
  asPublishedNetworkName,
  buildNetworkName,
  createInitialPeerName,
  isPublishedNetworkName,
  normalizeExplicitPeerName,
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
  lookupPeerByName,
  lookupPeerByRuntimeId,
  resolvePeerTarget,
  resolvePeerTargetOrThrow,
  type PeerRecordLike,
} from '../../src/discovery/lookup.js';
import { asRoomId, type RoomId } from '../../src/room.js';

const ROOM_A = asRoomId(`r1-${'a'.repeat(32)}`);
const ROOM_B = asRoomId(`r1-${'b'.repeat(32)}`);
const RUNTIME_A = '11111111-1111-4111-8111-111111111111';
const RUNTIME_B = '22222222-2222-4222-8222-222222222222';
const RUNTIME_C = '33333333-3333-4333-8333-333333333333';

function record(runtimeId: string, roomId: RoomId, networkName: string): PeerRecordLike {
  return { runtimeId, roomId, networkName };
}

describe('canonical runtime peer naming', () => {
  it('normalizes NFKC text, case, Unicode letters/numbers, and separator runs', () => {
    expect(normalizeExplicitPeerName('  Ｐlanner / 東京 ✨ １２３  ')).toBe('planner-東京-123');
    expect(normalizeExplicitPeerName('Élan 東京')).toBe('élan-東京');
  });

  it('rejects controls and explicit values that become empty', () => {
    expect(() => normalizeExplicitPeerName('planner\u0000')).toThrow();
    expect(() => normalizeExplicitPeerName('planner\u200b')).toThrow();
    expect(() => normalizeExplicitPeerName('--- ✨ ---')).toThrow();
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

  it('returns every full address for a normalized-name collision', () => {
    const result = lookupPeerByName('PLANNER', ROOM_A, [plannerA, plannerB, otherRoom]);

    expect(result.kind).toBe('ambiguous');
    if (result.kind !== 'ambiguous') return;
    expect(result.candidates).toEqual([
      { runtimeId: RUNTIME_A, roomId: ROOM_A },
      { runtimeId: RUNTIME_B, roomId: ROOM_A },
    ]);
    expect(result.addresses).toEqual(result.candidates);
    expect(result.records).toEqual([plannerA, plannerB]);
    expect(() => resolvePeerTargetOrThrow('planner', ROOM_A, [plannerA, plannerB])).toThrow(
      AmbiguousPeerNameError,
    );
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

    const isolated = resolvePeerTarget(RUNTIME_C, ROOM_A, [plannerA, otherRoom]);
    expect(isolated.kind).toBe('cross-room');
    if (isolated.kind === 'cross-room') {
      expect(isolated.candidates).toEqual([{ runtimeId: RUNTIME_C, roomId: ROOM_B }]);
      expect(isolated.currentRoom).toBe(ROOM_A);
      expect(isolated.targetRooms).toEqual([ROOM_B]);
    }
  });
});
