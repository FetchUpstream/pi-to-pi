import { describe, expect, it, vi } from 'vitest';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

import registerPiToPi, { createPiToPiLifecycle } from '../../src/index.js';

describe('Pi-to-Pi extension bootstrap', () => {
  it('registers namespaced flags and native session lifecycle hooks during extension load', () => {
    const on = vi.fn<ExtensionAPI['on']>();
    const registerFlag = vi.fn<ExtensionAPI['registerFlag']>();
    const getFlag = vi.fn<ExtensionAPI['getFlag']>().mockReturnValue(undefined);

    registerPiToPi({ on, registerFlag, getFlag } as unknown as ExtensionAPI);

    expect(registerFlag).toHaveBeenCalledTimes(2);
    expect(registerFlag).toHaveBeenNthCalledWith(
      1,
      'p2p-name',
      expect.objectContaining({ type: 'string' }),
    );
    expect(registerFlag).toHaveBeenNthCalledWith(
      2,
      'p2p-project',
      expect.objectContaining({ type: 'string' }),
    );
    expect(on).toHaveBeenCalledTimes(3);
    expect(on).toHaveBeenNthCalledWith(1, 'session_start', expect.any(Function));
    expect(on).toHaveBeenNthCalledWith(2, 'session_info_changed', expect.any(Function));
    expect(on).toHaveBeenNthCalledWith(3, 'session_shutdown', expect.any(Function));
  });

  it('reads the native session ID and starts a runtime only at session_start', () => {
    const on = vi.fn<ExtensionAPI['on']>();
    const registerFlag = vi.fn<ExtensionAPI['registerFlag']>();
    const getFlag = vi.fn<ExtensionAPI['getFlag']>().mockReturnValue(undefined);
    registerPiToPi({ on, registerFlag, getFlag } as unknown as ExtensionAPI);

    const startHandler = on.mock.calls[0]?.[1] as unknown as
      ((event: { type: 'session_start'; reason: 'startup' }, context: never) => void) | undefined;
    expect(startHandler).toEqual(expect.any(Function));
    if (!startHandler) return;

    const getSessionId = vi.fn(() => 'native-session-id');
    const getSessionName = vi.fn(() => 'Planner');
    const context = {
      cwd: process.cwd(),
      sessionManager: { getSessionId, getSessionName },
    } as never;

    startHandler({ type: 'session_start', reason: 'startup' }, context);

    expect(getSessionId).toHaveBeenCalledTimes(1);
    expect(getSessionName).toHaveBeenCalledTimes(1);
  });

  it('keeps shutdown idempotent for the current runtime', () => {
    const getFlag = vi.fn<ExtensionAPI['getFlag']>().mockReturnValue(undefined);
    const lifecycle = createPiToPiLifecycle({ getFlag });
    const context = {
      cwd: process.cwd(),
      sessionManager: {
        getSessionId: () => 'native-session-id',
        getSessionName: () => undefined,
      },
    } as never;

    lifecycle.onSessionStart({ type: 'session_start', reason: 'startup' }, context);
    expect(lifecycle.current()?.identity.sessionId).toBe('native-session-id');
    expect(lifecycle.current()?.identity.runtimeId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(lifecycle.current()?.room.roomId).toMatch(/^r1-[0-9a-f]{32}$/);
    expect(lifecycle.current()?.room.value).toBeDefined();
    const initial = lifecycle.current();
    lifecycle.onSessionInfoChanged({ type: 'session_info_changed', name: 'New Planner' }, context);
    expect(lifecycle.current()?.config.name).toBe('new-planner');
    expect(lifecycle.current()?.identity).toBe(initial?.identity);
    expect(lifecycle.current()?.room).toBe(initial?.room);
    lifecycle.onSessionShutdown({ type: 'session_shutdown', reason: 'quit' }, context);
    lifecycle.onSessionShutdown({ type: 'session_shutdown', reason: 'quit' }, context);
    expect(lifecycle.current()).toBeUndefined();
  });

  it('keeps an explicit P2P name when native session metadata changes', () => {
    const getFlag = vi.fn<ExtensionAPI['getFlag']>((name) =>
      name === 'p2p-name' ? 'Explicit Name' : undefined,
    );
    const lifecycle = createPiToPiLifecycle({ getFlag });
    const context = {
      cwd: process.cwd(),
      sessionManager: {
        getSessionId: () => 'native-session-id',
        getSessionName: () => 'Native Name',
      },
    } as never;

    lifecycle.onSessionStart({ type: 'session_start', reason: 'startup' }, context);
    const before = lifecycle.current();
    lifecycle.onSessionInfoChanged({ type: 'session_info_changed', name: 'Changed' }, context);

    expect(lifecycle.current()?.config.name).toBe('explicit-name');
    expect(lifecycle.current()?.identity).toBe(before?.identity);
    expect(lifecycle.current()?.room).toBe(before?.room);
  });
  it('preserves an explicit project when native session metadata changes', () => {
    const getFlag = vi.fn<ExtensionAPI['getFlag']>((name) =>
      name === 'p2p-project' ? 'Project Label' : undefined,
    );
    const lifecycle = createPiToPiLifecycle({ getFlag });
    const context = {
      cwd: '/path/that/does/not/need/to/exist',
      sessionManager: {
        getSessionId: () => 'native-session-id',
        getSessionName: () => 'Native Name',
      },
    } as never;

    lifecycle.onSessionStart({ type: 'session_start', reason: 'startup' }, context);
    const before = lifecycle.current();
    lifecycle.onSessionInfoChanged(
      { type: 'session_info_changed', name: 'Changed Native Name' },
      context,
    );

    expect(lifecycle.current()?.config.name).toBe('changed-native-name');
    expect(lifecycle.current()?.config.projectOverride).toBe('project-label');
    expect(lifecycle.current()?.identity).toBe(before?.identity);
    expect(lifecycle.current()?.room).toBe(before?.room);
  });

  it('resolves the configured project room before using the Pi cwd', () => {
    const getFlag = vi.fn<ExtensionAPI['getFlag']>((name) =>
      name === 'p2p-project' ? 'Project Label' : undefined,
    );
    const lifecycle = createPiToPiLifecycle({ getFlag });
    const context = {
      cwd: '/path/that/does/not/need/to/exist',
      sessionManager: {
        getSessionId: () => 'native-session-id',
        getSessionName: () => 'Native Name',
      },
    } as never;

    lifecycle.onSessionStart({ type: 'session_start', reason: 'startup' }, context);

    expect(lifecycle.current()?.room.source).toBe('explicit');
    expect(lifecycle.current()?.room.value).toBe('project-label');
  });
});
