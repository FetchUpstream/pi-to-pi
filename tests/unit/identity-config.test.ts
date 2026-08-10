import { describe, expect, it } from 'vitest';

import {
  P2PConfigurationError,
  P2P_NAME_FLAG,
  P2P_PROJECT_FLAG,
  readP2PFlags,
  registerP2PFlags,
  resolveP2PConfig,
} from '../../src/config.js';
import {
  adaptExternalPeerAddress,
  adaptExternalRuntimeIdentity,
  asNormalizedName,
  asRuntimeId,
  asSessionId,
  createCanonicalPeerAddress,
  createRuntimeLifecycle,
  createRuntimeLifecycleForTesting,
  isSessionId,
  isUuid,
} from '../../src/identity.js';
import { asRoomId, isValidRoomId, resolveRoom } from '../../src/room.js';

describe('P2P identity and configuration foundations', () => {
  it('generates a new runtime identity for every lifecycle start', () => {
    const lifecycle = createRuntimeLifecycle();

    const first = lifecycle.start('session-id');
    const replacement = lifecycle.start('session-id');

    expect(first.sessionId).toBe('session-id');
    expect(replacement.sessionId).toBe('session-id');
    expect(replacement.runtimeId).not.toBe(first.runtimeId);
    expect(lifecycle.current()).toBe(replacement);
  });

  it('keeps session identity stable on reload and distinct across new or forked sessions', () => {
    const runtimeIds = [
      '11111111-1111-4111-8111-111111111111',
      '22222222-2222-4222-8222-222222222222',
      '33333333-3333-4333-8333-333333333333',
      '44444444-4444-4444-8444-444444444444',
    ];
    const lifecycle = createRuntimeLifecycleForTesting(() => runtimeIds.shift()!);

    const started = lifecycle.start('resumed-session');
    const reloaded = lifecycle.start('resumed-session');
    const newSession = lifecycle.start('new-session');
    const forked = lifecycle.start('forked-session');

    expect(reloaded.sessionId).toBe(started.sessionId);
    expect(newSession.sessionId).not.toBe(started.sessionId);
    expect(forked.sessionId).not.toBe(started.sessionId);
    expect(
      new Set([started.runtimeId, reloaded.runtimeId, newSession.runtimeId, forked.runtimeId]),
    ).toHaveLength(4);
  });

  it('requires full UUID runtime syntax and keeps deterministic injection test-only', () => {
    expect(isUuid('11111111-1111-4111-8111-111111111111')).toBe(true);
    expect(isUuid('runtime-1')).toBe(false);
    expect(isUuid('abcdefab-cdef-4abc-8def-abcdefabcdef'.toUpperCase())).toBe(false);
    expect(() => asRuntimeId('runtime-1')).toThrow('full UUID');
    expect(() => asRuntimeId('11111111-1111-4111-7111-111111111111')).toThrow('full UUID');
    expect(() => asRuntimeId('abcdefab-cdef-4abc-8def-abcdefabcdef'.toUpperCase())).toThrow(
      'canonical lowercase',
    );
    expect(() => asRuntimeId(123)).toThrow('canonical lowercase');
    expect(isSessionId('A_session.id-9')).toBe(true);
    expect(asSessionId('A_session.id-9')).toBe('A_session.id-9');
    for (const value of [
      '',
      ' leading',
      'trailing ',
      '-leading',
      'trailing-',
      'has space',
      'has/slash',
    ]) {
      expect(isSessionId(value)).toBe(false);
      expect(() => asSessionId(value)).toThrow('native session ID grammar');
    }
    expect(asNormalizedName('  Ｐlanner / One  ')).toBe('planner-one');
    expect(() => asNormalizedName('planner\uFEFF')).toThrow();
  });

  it('constructs machine-actionable addresses from a full runtime ID and exact room', () => {
    const roomId = asRoomId(`r1-${'a'.repeat(32)}`);
    const address = createCanonicalPeerAddress('11111111-1111-4111-8111-111111111111', roomId);

    expect(address).toEqual({
      runtimeId: '11111111-1111-4111-8111-111111111111',
      roomId,
    });
    expect(() => createCanonicalPeerAddress('runtime-1', roomId)).toThrow('full UUID');
    expect(() =>
      createCanonicalPeerAddress('11111111-1111-4111-8111-111111111111', 'not-a-room'),
    ).toThrow('Invalid room ID');
  });
  it('adapts external runtimeInstanceId fields to canonical identity and addresses', () => {
    const roomId = asRoomId(`r1-${'a'.repeat(32)}`);
    const runtimeInstanceId = '11111111-1111-4111-8111-111111111111';

    expect(adaptExternalRuntimeIdentity({ sessionId: 'session-id', runtimeInstanceId })).toEqual({
      sessionId: 'session-id',
      runtimeId: runtimeInstanceId,
    });
    expect(adaptExternalPeerAddress({ runtimeInstanceId, roomId })).toEqual({
      runtimeId: runtimeInstanceId,
      roomId,
    });
    expect(() =>
      adaptExternalRuntimeIdentity({ sessionId: 'session-id', runtimeInstanceId: 'runtime-1' }),
    ).toThrow('full UUID');
    expect(() => adaptExternalPeerAddress({ runtimeInstanceId: 'runtime-1', roomId })).toThrow(
      'full UUID',
    );
    expect(() => adaptExternalPeerAddress({ runtimeInstanceId, roomId: '../room' })).toThrow(
      'Invalid room ID',
    );
  });
  it('keys shutdown to the owning runtime and tolerates repeated cleanup', () => {
    const uuids = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'];
    const lifecycle = createRuntimeLifecycleForTesting(() => uuids.shift() ?? uuids[0]!);
    const first = lifecycle.start('session-id');
    const replacement = lifecycle.start('session-id');

    lifecycle.shutdown(first.runtimeId);
    expect(lifecycle.current()).toBe(replacement);

    lifecycle.shutdown(replacement.runtimeId);
    lifecycle.shutdown(replacement.runtimeId);
    expect(lifecycle.current()).toBeUndefined();
  });

  it('registers and reads namespaced string flags through Pi', () => {
    const registrations: Array<[string, { type: 'string'; description?: string }]> = [];
    const values = new Map<string, boolean | string>([
      [P2P_NAME_FLAG, 'Planner'],
      [P2P_PROJECT_FLAG, 'frontend'],
    ]);
    const pi = {
      registerFlag(name: string, options: { type: 'string'; description?: string }): void {
        registrations.push([name, options]);
      },
      getFlag(name: string): boolean | string | undefined {
        return values.get(name);
      },
    };

    registerP2PFlags(pi);

    expect(registrations.map(([name]) => name)).toEqual([P2P_NAME_FLAG, P2P_PROJECT_FLAG]);
    expect(registrations.every(([, options]) => options.type === 'string')).toBe(true);
    expect(readP2PFlags(pi)).toEqual({ p2pName: 'Planner', p2pProject: 'frontend' });
  });

  it('gives explicit values precedence over Pi session-name defaults', () => {
    const config = resolveP2PConfig({
      flags: { p2pName: 'Planner', p2pProject: 'frontend' },
      sessionName: 'Native session name',
    });

    expect(config.name).toBe('planner');
    expect(config.nameSource).toBe('p2p-name');
    expect(config.nameOverride).toBe('planner');
    expect(config.projectOverride).toBe('frontend');
  });

  it('falls back from native session name to agent when no name exists', () => {
    expect(resolveP2PConfig({ sessionName: 'Native' }).name).toBe('native');
    expect(resolveP2PConfig().name).toBe('agent');
    expect(resolveP2PConfig({ sessionName: '---' })).toMatchObject({
      name: 'agent',
      nameSource: 'fallback',
    });
  });

  it('rejects invalid explicit flag values with option-specific errors', () => {
    expect(() => resolveP2PConfig({ p2pName: '' })).toThrowError(P2PConfigurationError);
    expect(() => resolveP2PConfig({ p2pName: '---' })).toThrow('--p2p-name');
    expect(() => resolveP2PConfig({ p2pProject: 'bad\nproject' })).toThrow('--p2p-project');
    expect(() => resolveP2PConfig({ p2pProject: 'frontend\uFEFF' })).toThrow('--p2p-project');
    expect(() => resolveP2PConfig({ flags: { p2pName: true } })).toThrow('--p2p-name');
  });

  it('brands only opaque versioned room IDs', () => {
    const roomId = asRoomId(`r1-${'a'.repeat(32)}`);
    expect(isValidRoomId(roomId)).toBe(true);
    const resolved = resolveRoom({ project: 'Frontend' });
    expect(resolved).toMatchObject({ source: 'explicit', value: 'frontend' });
    expect('id' in resolved).toBe(false);
    expect(() => asRoomId('../shared')).toThrow('Invalid room ID');
  });
});
