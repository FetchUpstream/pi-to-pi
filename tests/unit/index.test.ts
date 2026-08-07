import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ExtensionAPI,
  ExtensionContext,
  SessionInfoChangedEvent,
  SessionShutdownEvent,
  SessionStartEvent,
} from '@earendil-works/pi-coding-agent';

import registerPiToPi, { createPiToPiLifecycle } from '../../src/index.js';
import { type LeaseScheduler } from '../../src/discovery/lease.js';
import {
  RuntimeRegistry,
  listRuntimeRecords,
  readRuntimeRecord,
} from '../../src/discovery/registry.js';

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

let registryRoot: string;

beforeEach(async () => {
  registryRoot = await mkdtemp(join(tmpdir(), 'pi-to-pi-lifecycle-'));
});

afterEach(async () => {
  await rm(registryRoot, { recursive: true, force: true });
});

function createLifecycle(flags: { name?: string; project?: string } = {}) {
  return createPiToPiLifecycle(
    { getFlag: createFlags(flags) },
    {
      registryOptions: {
        rootDirectory: registryRoot,
        renewalIntervalMs: 60_000,
      },
    },
  );
}

class FailingFirstRenameRegistry extends RuntimeRegistry {
  private publicationCount = 0;

  protected override publishCurrentName(): Promise<void> {
    this.publicationCount += 1;
    const publication = super.publishCurrentName();
    if (this.publicationCount !== 2) {
      return publication;
    }
    return publication.then(() => {
      throw new Error('first overlapping rename fails');
    });
  }
}

class FailingSecondRenameRegistry extends RuntimeRegistry {
  private publicationCount = 0;

  protected override publishCurrentName(): Promise<void> {
    this.publicationCount += 1;
    const publication = super.publishCurrentName();
    if (this.publicationCount !== 3) {
      return publication;
    }
    return publication.then(() => {
      throw new Error('second overlapping rename fails after commit');
    });
  }
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

describe('Pi-to-Pi extension lifecycle integration', () => {
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

  it('does not allocate registry resources until session_start', async () => {
    const timer = { unref: vi.fn() } as unknown as ReturnType<typeof setInterval>;
    const scheduler: LeaseScheduler = {
      setInterval: vi.fn(() => timer),
      clearInterval: vi.fn(),
    };
    const lifecycle = createPiToPiLifecycle(
      { getFlag: createFlags({ project: 'Lifecycle Room' }) },
      {
        registryOptions: {
          rootDirectory: registryRoot,
          scheduler,
        },
      },
    );

    expect(scheduler.setInterval).not.toHaveBeenCalled();
    expect(lifecycle.current()).toBeUndefined();

    await lifecycle.onSessionStart(
      startEvent('startup'),
      createContext('native-session-id', 'Planner'),
    );

    expect(scheduler.setInterval).toHaveBeenCalledTimes(1);
    expect(lifecycle.current()?.registry.current()).toEqual(
      expect.objectContaining({
        sessionId: 'native-session-id',
        roomId: lifecycle.current()?.room.roomId,
        networkName: lifecycle.current()?.publishedName.networkName,
        endpoint: lifecycle.current()?.endpoint,
      }),
    );
    await lifecycle.onSessionShutdown(
      shutdownEvent('quit'),
      createContext('native-session-id', 'Planner'),
    );
  });

  it('reads native session metadata and starts a runtime only at session_start', async () => {
    const on = vi.fn<ExtensionAPI['on']>();
    const registerFlag = vi.fn<ExtensionAPI['registerFlag']>();
    const getFlag = vi.fn<ExtensionAPI['getFlag']>().mockReturnValue(undefined);
    registerPiToPi({ on, registerFlag, getFlag } as unknown as ExtensionAPI, {
      registryOptions: { rootDirectory: registryRoot },
    });

    const startHandler = on.mock.calls[0]?.[1] as unknown as
      ((event: SessionStartEvent, context: ExtensionContext) => Promise<void>) | undefined;
    const shutdownHandler = on.mock.calls[2]?.[1] as unknown as
      ((event: SessionShutdownEvent, context: ExtensionContext) => Promise<void>) | undefined;
    expect(startHandler).toEqual(expect.any(Function));
    expect(shutdownHandler).toEqual(expect.any(Function));
    if (startHandler === undefined || shutdownHandler === undefined) return;

    const getSessionId = vi.fn(() => 'native-session-id');
    const getSessionName = vi.fn(() => 'Planner');
    const context = {
      cwd: process.cwd(),
      sessionManager: { getSessionId, getSessionName },
    } as unknown as ExtensionContext;

    await expect(startHandler(startEvent('startup'), context)).resolves.toBeUndefined();
    expect(getSessionId).toHaveBeenCalledTimes(1);
    expect(getSessionName).toHaveBeenCalledTimes(1);
    await shutdownHandler(shutdownEvent('quit'), context);
  });

  for (const scenario of replacementScenarios) {
    it(`handles native ${scenario.reason} session replacement metadata`, async () => {
      const lifecycle = createLifecycle({ project: 'Lifecycle Room' });
      const currentContext = createContext('session-reload', 'Planner');

      await lifecycle.onSessionStart(startEvent('startup'), currentContext);
      const previousRuntime = lifecycle.current();
      expect(previousRuntime).toBeDefined();

      await lifecycle.onSessionShutdown(
        shutdownEvent(scenario.reason, scenario.targetSessionFile),
        currentContext,
      );
      expect(lifecycle.current()).toBeUndefined();

      await lifecycle.onSessionStart(
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
      await lifecycle.onSessionShutdown(
        shutdownEvent('quit'),
        createContext(scenario.replacementSessionId, 'Planner'),
      );
    });
  }

  it('updates only the native name while preserving identity, room, endpoint, and registry ownership', async () => {
    const lifecycle = createLifecycle({ project: 'Project Label' });
    const context = createContext('native-session-id', 'Planner');

    await lifecycle.onSessionStart(startEvent('startup'), context);
    const before = lifecycle.current();
    expect(before).toBeDefined();
    const beforeRecord = before?.registry.current();
    expect(beforeRecord).toBeDefined();

    const renamedEvent: SessionInfoChangedEvent = {
      type: 'session_info_changed',
      name: 'New Planner',
    };
    await lifecycle.onSessionInfoChanged(renamedEvent, context);
    const afterRename = lifecycle.current();
    const afterRecord = afterRename?.registry.current();

    expect(afterRename?.config.name).toBe('new-planner');
    expect(afterRename?.config.nameSource).toBe('session-name');
    expect(afterRename?.config.projectOverride).toBe('project-label');
    expect(afterRename?.identity).toBe(before?.identity);
    expect(afterRename?.room).toBe(before?.room);
    expect(afterRename?.endpoint).toBe(before?.endpoint);
    expect(afterRename?.registry).toBe(before?.registry);
    expect(afterRename?.publishedName.suffix).toBe(before?.publishedName.suffix);
    expect(afterRecord?.runtimeId).toBe(beforeRecord?.runtimeId);
    expect(afterRecord?.sessionId).toBe(beforeRecord?.sessionId);
    expect(afterRecord?.roomId).toBe(beforeRecord?.roomId);
    expect(afterRecord?.endpoint).toBe(beforeRecord?.endpoint);
    expect(afterRecord?.networkName).toBe(afterRename?.publishedName.networkName);
    expect(afterRecord?.networkName).not.toBe(beforeRecord?.networkName);

    await lifecycle.onSessionInfoChanged(
      { type: 'session_info_changed', name: undefined },
      context,
    );
    expect(lifecycle.current()?.config.name).toBe('agent');
    expect(lifecycle.current()?.identity).toBe(before?.identity);
    expect(lifecycle.current()?.room).toBe(before?.room);
    expect(lifecycle.current()?.endpoint).toBe(before?.endpoint);

    await lifecycle.onSessionShutdown(shutdownEvent('quit'), context);
    expect(await listRuntimeRecords(before!.room.roomId, { rootDirectory: registryRoot })).toEqual(
      [],
    );
  });
  it('keeps overlapping successful native renames synchronized with the committed record', async () => {
    const lifecycle = createLifecycle({ project: 'Project Label' });
    const context = createContext('native-session-id', 'Planner');

    await lifecycle.onSessionStart(startEvent('startup'), context);
    const firstRename = lifecycle.onSessionInfoChanged(
      { type: 'session_info_changed', name: 'First' },
      context,
    );
    const secondRename = lifecycle.onSessionInfoChanged(
      { type: 'session_info_changed', name: 'Second' },
      context,
    );

    await expect(firstRename).resolves.toBeUndefined();
    await expect(secondRename).resolves.toBeUndefined();

    const runtime = lifecycle.current();
    expect(runtime?.config.name).toBe('second');
    expect(runtime?.publishedName.base).toBe('second');
    expect(runtime?.registry.networkName).toBe(runtime?.publishedName.networkName);
    expect(runtime?.registry.current()?.networkName).toBe(runtime?.publishedName.networkName);
    expect(
      await readRuntimeRecord(runtime!.room.roomId, runtime!.identity.runtimeId, {
        rootDirectory: registryRoot,
      }),
    ).toEqual(runtime?.registry.current());

    await lifecycle.onSessionShutdown(shutdownEvent('quit'), context);
  });

  it('keeps overlapping native renames consistent after an earlier publication fails', async () => {
    let registry: FailingFirstRenameRegistry | undefined;
    const lifecycle = createPiToPiLifecycle(
      { getFlag: createFlags() },
      {
        registryOptions: {
          rootDirectory: registryRoot,
          renewalIntervalMs: 60_000,
        },
        createRegistry: (options) => {
          registry = new FailingFirstRenameRegistry(options);
          return registry;
        },
      },
    );
    const context = createContext('native-session-id', 'Planner');

    await lifecycle.onSessionStart(startEvent('startup'), context);
    const firstRename = lifecycle.onSessionInfoChanged(
      { type: 'session_info_changed', name: 'First' },
      context,
    );
    const secondRename = lifecycle.onSessionInfoChanged(
      { type: 'session_info_changed', name: 'Second' },
      context,
    );

    await expect(firstRename).rejects.toThrow('first overlapping rename fails');
    await expect(secondRename).resolves.toBeUndefined();

    const runtime = lifecycle.current();
    expect(runtime?.config.name).toBe('second');
    expect(registry?.networkName).toBe(runtime?.publishedName.networkName);
    expect(registry?.current()?.networkName).toBe(runtime?.publishedName.networkName);
    expect(
      await readRuntimeRecord(runtime!.room.roomId, runtime!.identity.runtimeId, {
        rootDirectory: registryRoot,
      }),
    ).toEqual(registry?.current());

    await lifecycle.onSessionShutdown(shutdownEvent('quit'), context);
  });

  it('keeps the last committed native rename after a later publication fails', async () => {
    let registry: FailingSecondRenameRegistry | undefined;
    const lifecycle = createPiToPiLifecycle(
      { getFlag: createFlags() },
      {
        registryOptions: {
          rootDirectory: registryRoot,
          renewalIntervalMs: 60_000,
        },
        createRegistry: (options) => {
          registry = new FailingSecondRenameRegistry(options);
          return registry;
        },
      },
    );
    const context = createContext('native-session-id', 'Planner');

    await lifecycle.onSessionStart(startEvent('startup'), context);
    const firstRename = lifecycle.onSessionInfoChanged(
      { type: 'session_info_changed', name: 'First' },
      context,
    );
    const secondRename = lifecycle.onSessionInfoChanged(
      { type: 'session_info_changed', name: 'Second' },
      context,
    );

    await expect(firstRename).resolves.toBeUndefined();
    await expect(secondRename).rejects.toThrow('second overlapping rename fails after commit');

    const runtime = lifecycle.current();
    expect(runtime?.config.name).toBe('first');
    expect(runtime?.publishedName.base).toBe('first');
    expect(registry?.networkName).toBe(runtime?.publishedName.networkName);
    expect(registry?.current()?.networkName).toBe(runtime?.publishedName.networkName);
    expect(
      await readRuntimeRecord(runtime!.room.roomId, runtime!.identity.runtimeId, {
        rootDirectory: registryRoot,
      }),
    ).toEqual(registry?.current());

    await lifecycle.onSessionShutdown(shutdownEvent('quit'), context);
  });

  it('keeps an explicit P2P name and project when native session metadata changes', async () => {
    const lifecycle = createLifecycle({ name: 'Explicit Name', project: 'Project Label' });
    const context = createContext('native-session-id', 'Native Name');

    await lifecycle.onSessionStart(startEvent('startup'), context);
    const before = lifecycle.current();
    await lifecycle.onSessionInfoChanged(
      { type: 'session_info_changed', name: 'Changed' },
      context,
    );
    const afterRename = lifecycle.current();

    expect(afterRename?.config.name).toBe('explicit-name');
    expect(afterRename?.config.nameOverride).toBe('explicit-name');
    expect(afterRename?.config.projectOverride).toBe('project-label');
    expect(afterRename?.identity).toBe(before?.identity);
    expect(afterRename?.room).toBe(before?.room);
    expect(afterRename?.endpoint).toBe(before?.endpoint);
    expect(afterRename?.registry.current()?.networkName).toBe(
      before?.registry.current()?.networkName,
    );
    await lifecycle.onSessionShutdown(shutdownEvent('quit'), context);
  });

  it('makes repeated native shutdown cleanup idempotent for the current runtime', async () => {
    const lifecycle = createLifecycle();
    const context = createContext('native-session-id', undefined);

    await lifecycle.onSessionStart(startEvent('startup'), context);
    expect(lifecycle.current()?.identity.sessionId).toBe('native-session-id');
    expect(lifecycle.current()?.identity.runtimeId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    );

    await expect(
      lifecycle.onSessionShutdown(shutdownEvent('quit'), context),
    ).resolves.toBeUndefined();
    await expect(
      lifecycle.onSessionShutdown(shutdownEvent('quit'), context),
    ).resolves.toBeUndefined();
    await expect(
      lifecycle.onSessionShutdown(shutdownEvent('quit'), context),
    ).resolves.toBeUndefined();
    expect(lifecycle.current()).toBeUndefined();
  });

  it('gives a replacement extension process a fresh runtime without affecting old-process cleanup', async () => {
    const flags = { project: 'Lifecycle Room' };
    const previousProcess = createLifecycle(flags);
    const context = createContext('stable-session-id', 'Planner');

    await previousProcess.onSessionStart(startEvent('startup'), context);
    const previousRuntime = previousProcess.current();
    expect(previousRuntime).toBeDefined();
    await previousProcess.onSessionShutdown(
      shutdownEvent('reload', '/sessions/reloaded.jsonl'),
      context,
    );

    const replacementProcess = createLifecycle(flags);
    await replacementProcess.onSessionStart(
      startEvent('reload', '/sessions/active.jsonl'),
      createContext('stable-session-id', 'Planner'),
    );
    const replacementRuntime = replacementProcess.current();
    expect(replacementRuntime).toBeDefined();

    expect(replacementRuntime?.identity.sessionId).toBe(previousRuntime?.identity.sessionId);
    expect(replacementRuntime?.identity.runtimeId).not.toBe(previousRuntime?.identity.runtimeId);
    expect(replacementRuntime?.room.roomId).toBe(previousRuntime?.room.roomId);

    await previousProcess.onSessionShutdown(shutdownEvent('reload'), context);
    await previousProcess.onSessionShutdown(shutdownEvent('reload'), context);
    expect(replacementProcess.current()).toBe(replacementRuntime);

    await replacementProcess.onSessionShutdown(shutdownEvent('quit'), context);
    expect(replacementProcess.current()).toBeUndefined();
  });

  it('resolves an explicit project room before the Pi working directory', async () => {
    const lifecycle = createLifecycle({ project: 'Project Label' });
    const context = createContext('native-session-id', 'Native Name', '/path/that/does/not/exist');

    await lifecycle.onSessionStart(startEvent('startup'), context);

    expect(lifecycle.current()?.room.source).toBe('explicit');
    expect(lifecycle.current()?.room.value).toBe('project-label');
    await lifecycle.onSessionShutdown(shutdownEvent('quit'), context);
  });
});
