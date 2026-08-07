import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import {
  SessionManager,
  type AgentSessionRuntime,
  type NewSessionOptions,
} from '@earendil-works/pi-coding-agent';
import {
  createPiRuntimeFixture,
  type CreatePiRuntimeFixtureOptions,
  type PiRuntimeFixture,
} from './pi-runtime.js';

export interface PersistedPiSessionFixtureOptions extends Omit<
  CreatePiRuntimeFixtureOptions,
  'cwd' | 'agentDir' | 'sessionDir' | 'sessionManager'
> {
  rootDir?: string;
  cwd?: string;
  agentDir?: string;
  sessionDir?: string;
  sessionManager?: SessionManager;
  removeOnDispose?: boolean;
}

export interface CloneSessionOptions {
  sourceSessionFile?: string;
  id?: string;
  rootDir?: string;
  cwd?: string;
  sessionDir?: string;
}

export interface ClonedPersistedSession {
  readonly rootDir: string;
  readonly cwd: string;
  readonly sessionDir: string;
  readonly sessionManager: SessionManager;
  readonly sessionFile: string;
  readonly sourceSessionFile: string;
  createRuntime(
    options?: Omit<
      CreatePiRuntimeFixtureOptions,
      'cwd' | 'agentDir' | 'sessionDir' | 'sessionManager'
    >,
  ): Promise<PiRuntimeFixture>;
  cleanup(): Promise<void>;
}

export interface PersistedPiSessionFixture extends PiRuntimeFixture {
  readonly rootDir: string;
  readonly removeOnDispose: boolean;
  createSession(options?: NewSessionOptions): SessionManager;
  openSession(sessionFile: string): SessionManager;
  reloadSession(): Promise<void>;
  resumeSession(
    sessionFile: string,
    options?: Parameters<PiRuntimeFixture['runtime']['switchSession']>[1],
  ): Promise<{ cancelled: boolean }>;
  forkSession(
    entryId: string,
    options?: Parameters<PiRuntimeFixture['runtime']['fork']>[1],
  ): Promise<{ cancelled: boolean; selectedText?: string }>;
  cloneSession(options?: CloneSessionOptions): Promise<ClonedPersistedSession>;
}

async function ensureDirectories(paths: string[]): Promise<void> {
  await Promise.all(paths.map((path) => mkdir(path, { recursive: true })));
}

function samePath(left: string, right: string): boolean {
  return resolve(left) === resolve(right);
}

function sessionPaths(
  options: PersistedPiSessionFixtureOptions,
  rootDir: string,
): { cwd: string; sessionDir: string } {
  const sessionManager = options.sessionManager;
  if (
    sessionManager &&
    options.cwd !== undefined &&
    !samePath(options.cwd, sessionManager.getCwd())
  ) {
    throw new Error(
      `Injected SessionManager cwd ${sessionManager.getCwd()} conflicts with fixture cwd ${options.cwd}`,
    );
  }
  if (
    sessionManager &&
    options.sessionDir !== undefined &&
    !samePath(options.sessionDir, sessionManager.getSessionDir())
  ) {
    throw new Error(
      `Injected SessionManager session directory ${sessionManager.getSessionDir()} conflicts with fixture session directory ${options.sessionDir}`,
    );
  }
  return {
    cwd: options.cwd ?? sessionManager?.getCwd() ?? join(rootDir, 'workspace'),
    sessionDir: options.sessionDir ?? sessionManager?.getSessionDir() ?? join(rootDir, 'sessions'),
  };
}

export async function createPersistedPiSessionFixture(
  options: PersistedPiSessionFixtureOptions = {},
): Promise<PersistedPiSessionFixture> {
  const ownsRoot = options.rootDir === undefined;
  const rootDir = options.rootDir ?? (await mkdtemp(join(tmpdir(), 'pi-p2p-session-')));

  try {
    const { cwd, sessionDir } = sessionPaths(options, rootDir);
    const agentDir = options.agentDir ?? join(rootDir, 'agent');
    await ensureDirectories([rootDir, cwd, agentDir, sessionDir]);

    const sessionManager = options.sessionManager ?? SessionManager.create(cwd, sessionDir);
    const fixture = await createPiRuntimeFixture({
      ...options,
      cwd,
      agentDir,
      sessionDir,
      sessionManager,
    });
    const removeOnDispose = options.removeOnDispose ?? ownsRoot;
    const disposeRuntime = fixture.dispose.bind(fixture);
    let runtimeDisposed = false;
    let rootRemoved = !removeOnDispose;

    const persistedFixture: PersistedPiSessionFixture = Object.assign(fixture, {
      rootDir,
      removeOnDispose,
      createSession(sessionOptions?: NewSessionOptions) {
        return SessionManager.create(cwd, sessionDir, sessionOptions);
      },
      openSession(sessionFile: string) {
        return SessionManager.open(sessionFile, sessionDir);
      },
      async reloadSession() {
        await fixture.reload();
      },
      async resumeSession(
        sessionFile: string,
        switchOptions?: Parameters<AgentSessionRuntime['switchSession']>[1],
      ) {
        return fixture.resume(sessionFile, switchOptions);
      },
      async forkSession(entryId: string, forkOptions?: Parameters<AgentSessionRuntime['fork']>[1]) {
        return fixture.fork(entryId, forkOptions);
      },
      async cloneSession(cloneOptions: CloneSessionOptions = {}) {
        return clonePersistedSession(fixture, cloneOptions);
      },
      async dispose() {
        if (runtimeDisposed && rootRemoved) {
          return;
        }
        let disposeError: unknown;
        let hasDisposeError = false;
        try {
          if (!runtimeDisposed) {
            await disposeRuntime();
            runtimeDisposed = true;
          }
        } catch (error) {
          disposeError = error;
          hasDisposeError = true;
        } finally {
          if (removeOnDispose && !rootRemoved) {
            try {
              await rm(rootDir, { recursive: true, force: true });
              rootRemoved = true;
            } catch (error) {
              disposeError ??= error;
              hasDisposeError = true;
            }
          }
        }
        if (hasDisposeError) {
          throw disposeError;
        }
      },
    });

    return persistedFixture;
  } catch (error) {
    if (ownsRoot) {
      await rm(rootDir, { recursive: true, force: true }).catch(() => undefined);
    }
    throw error;
  }
}

async function clonePersistedSession(
  fixture: PiRuntimeFixture,
  options: CloneSessionOptions,
): Promise<ClonedPersistedSession> {
  const sourceSessionFile = options.sourceSessionFile ?? fixture.sessionFile;
  if (!sourceSessionFile) {
    throw new Error('Cannot clone an in-memory session without a session file');
  }

  const ownsRoot = options.rootDir === undefined;
  const rootDir = options.rootDir ?? (await mkdtemp(join(tmpdir(), 'pi-p2p-clone-')));

  try {
    const cwd = options.cwd ?? join(rootDir, 'workspace');
    const sessionDir = options.sessionDir ?? join(rootDir, 'sessions');
    await ensureDirectories([rootDir, cwd, join(rootDir, 'agent'), sessionDir]);
    const sessionManager = SessionManager.forkFrom(sourceSessionFile, cwd, sessionDir, {
      id: options.id,
    });
    const sessionFile = sessionManager.getSessionFile();
    if (!sessionFile) {
      throw new Error('Pi did not return a file for the cloned session');
    }

    let cleaned = false;
    return {
      rootDir,
      cwd,
      sessionDir,
      sessionManager,
      sessionFile,
      sourceSessionFile,
      async createRuntime(runtimeOptions = {}) {
        return createPiRuntimeFixture({
          ...runtimeOptions,
          cwd,
          agentDir: join(rootDir, 'agent'),
          sessionDir,
          sessionManager,
        });
      },
      async cleanup() {
        if (cleaned) {
          return;
        }
        if (!ownsRoot) {
          cleaned = true;
          return;
        }
        await rm(rootDir, { recursive: true, force: true });
        cleaned = true;
      },
    };
  } catch (error) {
    if (ownsRoot) {
      await rm(rootDir, { recursive: true, force: true }).catch(() => undefined);
    }
    throw error;
  }
}

export const createIsolatedPersistedSession = createPersistedPiSessionFixture;
export const createPersistedSessionFixture = createPersistedPiSessionFixture;
