import { describe, expect, it, vi } from 'vitest';
import type {
  ExtensionAPI,
  ExtensionContext,
  SessionInfoChangedEvent,
  SessionShutdownEvent,
  SessionStartEvent,
} from '@earendil-works/pi-coding-agent';

import registerPiToPi, { createPiToPiLifecycle } from '../../src/index.js';

function createFlags(options: { name?: string; project?: string } = {}) {
  return vi.fn<ExtensionAPI['getFlag']>((name) => {
    if (name === 'p2p-name') return options.name;
    if (name === 'p2p-project') return options.project;
    return undefined;
  });
}

function createContext(
  sessionId: string,
  sessionName: string | undefined,
  cwd = process.cwd(),
): ExtensionContext {
  return {
    cwd,
    sessionManager: {
      getSessionId: () => sessionId,
      getSessionName: () => sessionName,
    },
  } as unknown as ExtensionContext;
}

function startEvent(
  reason: SessionStartEvent['reason'],
  previousSessionFile?: string,
): SessionStartEvent {
  return {
    type: 'session_start',
    reason,
    ...(previousSessionFile === undefined ? {} : { previousSessionFile }),
  };
}

function shutdownEvent(
  reason: SessionShutdownEvent['reason'],
  targetSessionFile?: string,
): SessionShutdownEvent {
  return {
    type: 'session_shutdown',
    reason,
    ...(targetSessionFile === undefined ? {} : { targetSessionFile }),
  };
}

const replacementScenarios: ReadonlyArray<{
  readonly reason: Exclude<SessionStartEvent['reason'], 'startup'>;
  readonly replacementSessionId: string;
  readonly previousSessionFile?: string;
  readonly targetSessionFile?: string;
}> = [
  {
    reason: 'reload',
    replacementSessionId: 'session-reload',
  },
  {
    reason: 'resume',
    replacementSessionId: 'session-resumed',
    previousSessionFile: '/sessions/active.jsonl',
    targetSessionFile: '/sessions/resumed.jsonl',
  },
  {
    reason: 'new',
    replacementSessionId: 'session-new',
    previousSessionFile: '/sessions/active.jsonl',
    targetSessionFile: '/sessions/new.jsonl',
  },
  {
    reason: 'fork',
    replacementSessionId: 'session-fork',
    previousSessionFile: '/sessions/active.jsonl',
    targetSessionFile: '/sessions/fork.jsonl',
  },
];

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

  it('reads native session metadata and starts a runtime only at session_start', () => {
    const on = vi.fn<ExtensionAPI['on']>();
    const registerFlag = vi.fn<ExtensionAPI['registerFlag']>();
    const getFlag = vi.fn<ExtensionAPI['getFlag']>().mockReturnValue(undefined);
    registerPiToPi({ on, registerFlag, getFlag } as unknown as ExtensionAPI);

    const startHandler = on.mock.calls[0]?.[1] as unknown as
      ((event: SessionStartEvent, context: ExtensionContext) => void) | undefined;
    expect(startHandler).toEqual(expect.any(Function));
    if (startHandler === undefined) return;

    const getSessionId = vi.fn(() => 'native-session-id');
    const getSessionName = vi.fn(() => 'Planner');
    const context = {
      cwd: process.cwd(),
      sessionManager: { getSessionId, getSessionName },
    } as unknown as ExtensionContext;

    expect(() => startHandler(startEvent('startup'), context)).not.toThrow();

    expect(getSessionId).toHaveBeenCalledTimes(1);
    expect(getSessionName).toHaveBeenCalledTimes(1);
  });

  for (const scenario of replacementScenarios) {
    it(`handles native ${scenario.reason} session replacement metadata`, () => {
      const lifecycle = createPiToPiLifecycle({
        getFlag: createFlags({ project: 'Lifecycle Room' }),
      });
      const currentContext = createContext('session-reload', 'Planner');

      lifecycle.onSessionStart(startEvent('startup'), currentContext);
      const previousRuntime = lifecycle.current();
      expect(previousRuntime).toBeDefined();

      lifecycle.onSessionShutdown(
        shutdownEvent(scenario.reason, scenario.targetSessionFile),
        currentContext,
      );
      expect(lifecycle.current()).toBeUndefined();

      lifecycle.onSessionStart(
        startEvent(scenario.reason, scenario.previousSessionFile),
        createContext(scenario.replacementSessionId, 'Planner'),
      );
      const replacementRuntime = lifecycle.current();
      expect(replacementRuntime).toBeDefined();

      expect(replacementRuntime?.identity.runtimeId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
      );
      expect(replacementRuntime?.identity.runtimeId).not.toBe(previousRuntime?.identity.runtimeId);
      expect(replacementRuntime?.identity.sessionId).toBe(scenario.replacementSessionId);
      expect(replacementRuntime?.config.name).toBe('planner');
      expect(replacementRuntime?.config.projectOverride).toBe('lifecycle-room');
      expect(replacementRuntime?.room.roomId).toBe(previousRuntime?.room.roomId);
    });
  }

  it('updates only the native name while preserving project, identity, and room state', () => {
    const lifecycle = createPiToPiLifecycle({
      getFlag: createFlags({ project: 'Project Label' }),
    });
    const context = createContext('native-session-id', 'Planner');

    lifecycle.onSessionStart(startEvent('startup'), context);
    const before = lifecycle.current();
    expect(before).toBeDefined();
    expect(before?.config.name).toBe('planner');
    expect(before?.config.nameSource).toBe('session-name');

    const renamedEvent: SessionInfoChangedEvent = {
      type: 'session_info_changed',
      name: 'New Planner',
    };
    lifecycle.onSessionInfoChanged(renamedEvent, context);
    const afterRename = lifecycle.current();

    expect(afterRename?.config.name).toBe('new-planner');
    expect(afterRename?.config.nameSource).toBe('session-name');
    expect(afterRename?.config.projectOverride).toBe('project-label');
    expect(afterRename?.identity).toBe(before?.identity);
    expect(afterRename?.identity.sessionId).toBe('native-session-id');
    expect(afterRename?.identity.runtimeId).toBe(before?.identity.runtimeId);
    expect(afterRename?.room).toBe(before?.room);

    lifecycle.onSessionInfoChanged({ type: 'session_info_changed', name: undefined }, context);
    const afterClear = lifecycle.current();
    expect(afterClear?.config.name).toBe('agent');
    expect(afterClear?.config.projectOverride).toBe('project-label');
    expect(afterClear?.identity).toBe(before?.identity);
    expect(afterClear?.room).toBe(before?.room);
  });

  it('keeps an explicit P2P name and project when native session metadata changes', () => {
    const lifecycle = createPiToPiLifecycle({
      getFlag: createFlags({ name: 'Explicit Name', project: 'Project Label' }),
    });
    const context = createContext('native-session-id', 'Native Name');

    lifecycle.onSessionStart(startEvent('startup'), context);
    const before = lifecycle.current();
    expect(before).toBeDefined();

    lifecycle.onSessionInfoChanged({ type: 'session_info_changed', name: 'Changed' }, context);
    const afterRename = lifecycle.current();

    expect(afterRename?.config.name).toBe('explicit-name');
    expect(afterRename?.config.nameOverride).toBe('explicit-name');
    expect(afterRename?.config.projectOverride).toBe('project-label');
    expect(afterRename?.identity).toBe(before?.identity);
    expect(afterRename?.room).toBe(before?.room);
  });

  it('makes repeated native shutdown cleanup idempotent for the current runtime', () => {
    const lifecycle = createPiToPiLifecycle({ getFlag: createFlags() });
    const context = createContext('native-session-id', undefined);

    lifecycle.onSessionStart(startEvent('startup'), context);
    expect(lifecycle.current()?.identity.sessionId).toBe('native-session-id');
    expect(lifecycle.current()?.identity.runtimeId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    );

    expect(() => {
      lifecycle.onSessionShutdown(shutdownEvent('quit'), context);
      lifecycle.onSessionShutdown(shutdownEvent('quit'), context);
      lifecycle.onSessionShutdown(shutdownEvent('quit'), context);
    }).not.toThrow();
    expect(lifecycle.current()).toBeUndefined();
  });

  it('gives a replacement extension process a fresh runtime without affecting the old process state', () => {
    const flags = { project: 'Lifecycle Room' };
    const previousProcess = createPiToPiLifecycle({ getFlag: createFlags(flags) });
    const context = createContext('stable-session-id', 'Planner');

    previousProcess.onSessionStart(startEvent('startup'), context);
    const previousRuntime = previousProcess.current();
    expect(previousRuntime).toBeDefined();
    previousProcess.onSessionShutdown(shutdownEvent('reload', '/sessions/reloaded.jsonl'), context);
    expect(previousProcess.current()).toBeUndefined();

    const replacementProcess = createPiToPiLifecycle({ getFlag: createFlags(flags) });
    replacementProcess.onSessionStart(
      startEvent('reload', '/sessions/active.jsonl'),
      createContext('stable-session-id', 'Planner'),
    );
    const replacementRuntime = replacementProcess.current();
    expect(replacementRuntime).toBeDefined();

    expect(replacementRuntime?.identity.sessionId).toBe(previousRuntime?.identity.sessionId);
    expect(replacementRuntime?.identity.runtimeId).not.toBe(previousRuntime?.identity.runtimeId);
    expect(replacementRuntime?.room.roomId).toBe(previousRuntime?.room.roomId);

    expect(() => {
      previousProcess.onSessionShutdown(shutdownEvent('reload'), context);
      previousProcess.onSessionShutdown(shutdownEvent('reload'), context);
    }).not.toThrow();
    expect(replacementProcess.current()).toBe(replacementRuntime);

    replacementProcess.onSessionShutdown(shutdownEvent('quit'), context);
    replacementProcess.onSessionShutdown(shutdownEvent('quit'), context);
    expect(replacementProcess.current()).toBeUndefined();
  });

  it('resolves an explicit project room before the Pi working directory', () => {
    const lifecycle = createPiToPiLifecycle({
      getFlag: createFlags({ project: 'Project Label' }),
    });
    const context = createContext('native-session-id', 'Native Name', '/path/that/does/not/exist');

    lifecycle.onSessionStart(startEvent('startup'), context);

    expect(lifecycle.current()?.room.source).toBe('explicit');
    expect(lifecycle.current()?.room.value).toBe('project-label');
  });
});
