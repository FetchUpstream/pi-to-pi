import { describe, expect, it } from 'vitest';

import {
  P2PConfigurationError,
  P2P_NAME_FLAG,
  P2P_PROJECT_FLAG,
  readP2PFlags,
  registerP2PFlags,
  resolveP2PConfig,
} from '../../src/config.js';
import { createRuntimeLifecycle } from '../../src/identity.js';
import { asRoomId, createResolvedRoom, isRoomId } from '../../src/room.js';

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

  it('allows repeated shutdown without retaining runtime state', () => {
    const lifecycle = createRuntimeLifecycle();
    lifecycle.start('session-id');

    lifecycle.shutdown();
    lifecycle.shutdown();

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

    expect(config.name).toBe('Planner');
    expect(config.nameSource).toBe('p2p-name');
    expect(config.nameOverride).toBe('Planner');
    expect(config.projectOverride).toBe('frontend');
  });

  it('falls back from native session name to agent when no name exists', () => {
    expect(resolveP2PConfig({ sessionName: 'Native' }).name).toBe('Native');
    expect(resolveP2PConfig().name).toBe('agent');
  });

  it('rejects invalid explicit flag values with option-specific errors', () => {
    expect(() => resolveP2PConfig({ p2pName: '' })).toThrowError(P2PConfigurationError);
    expect(() => resolveP2PConfig({ p2pName: '---' })).toThrow('--p2p-name');
    expect(() => resolveP2PConfig({ p2pProject: 'bad\nproject' })).toThrow('--p2p-project');
    expect(() => resolveP2PConfig({ flags: { p2pName: true } })).toThrow('--p2p-name');
  });

  it('brands only opaque versioned room IDs', () => {
    const roomId = asRoomId(`r1-${'a'.repeat(32)}`);
    expect(isRoomId(roomId)).toBe(true);
    expect(createResolvedRoom(roomId, 'explicit-project', 'frontend')).toEqual({
      id: roomId,
      source: 'explicit-project',
      input: 'frontend',
    });
    expect(() => asRoomId('../shared')).toThrow('Invalid room ID');
  });
});
