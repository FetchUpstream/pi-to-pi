import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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

export async function createPersistedPiSessionFixture(
  options: PersistedPiSessionFixtureOptions = {},
): Promise<PersistedPiSessionFixture> {
  const ownsRoot = options.rootDir === undefined;
  const rootDir = options.rootDir ?? (await mkdtemp(join(tmpdir(), 'pi-p2p-session-')));
  const cwd = options.cwd ?? join(rootDir, 'workspace');
  const agentDir = options.agentDir ?? join(rootDir, 'agent');
  const sessionDir = options.sessionDir ?? join(rootDir, 'sessions');
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
  let disposed = false;

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
      switchOptions: Parameters<AgentSessionRuntime['switchSession']>[1],
    ) {
      return fixture.resume(sessionFile, switchOptions);
    },
    async forkSession(entryId: string, forkOptions: Parameters<AgentSessionRuntime['fork']>[1]) {
      return fixture.fork(entryId, forkOptions);
    },
    async cloneSession(cloneOptions: CloneSessionOptions = {}) {
      return clonePersistedSession(fixture, cloneOptions);
    },
    async dispose() {
      if (disposed) {
        return;
      }
      disposed = true;
      await disposeRuntime();
      if (removeOnDispose) {
        await rm(rootDir, { recursive: true, force: true });
      }
    },
  });

  return persistedFixture;
}

async function clonePersistedSession(
  fixture: PiRuntimeFixture,
  options: CloneSessionOptions,
): Promise<ClonedPersistedSession> {
  const sourceSessionFile = options.sourceSessionFile ?? fixture.sessionFile;
  if (!sourceSessionFile) {
    throw new Error('Cannot clone an in-memory session without a session file');
  }

  const rootDir = options.rootDir ?? (await mkdtemp(join(tmpdir(), 'pi-p2p-clone-')));
  const cwd = options.cwd ?? join(rootDir, 'workspace');
  const sessionDir = options.sessionDir ?? join(rootDir, 'sessions');
  await ensureDirectories([rootDir, cwd, sessionDir]);
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
      cleaned = true;
      await rm(rootDir, { recursive: true, force: true });
    },
  };
}

export const createIsolatedPersistedSession = createPersistedPiSessionFixture;
export const createPersistedSessionFixture = createPersistedPiSessionFixture;
