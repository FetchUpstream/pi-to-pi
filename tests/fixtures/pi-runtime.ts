import type {
  AgentSession,
  AgentSessionRuntime,
  AgentSessionServices,
  CreateAgentSessionRuntimeFactory,
  SessionManager,
  SettingsManager,
} from '@earendil-works/pi-coding-agent';
import {
  ModelRuntime,
  SessionManager as PiSessionManager,
  SettingsManager as PiSettingsManager,
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
} from '@earendil-works/pi-coding-agent';
import {
  fauxAssistantMessage,
  fauxProvider,
  type FauxProviderHandle,
  type FauxResponseStep,
  type Model,
  type RegisterFauxProviderOptions,
} from '@earendil-works/pi-ai';
import type { AgentSessionEvent } from '@earendil-works/pi-coding-agent';
import { join } from 'node:path';

import {
  bindPiProbe,
  createInlineProbeExtension,
  createPiProbe,
  type PiProbe,
} from './pi-probe.js';

export const DEFAULT_FAUX_PROVIDER_ID = 'pi-p2p-fixture-faux';
export const DEFAULT_FAUX_MODEL_ID = 'pi-p2p-fixture-model';
export const DEFAULT_FAUX_API = 'faux';

export interface CreatePiRuntimeFixtureOptions {
  cwd: string;
  agentDir: string;
  sessionManager?: SessionManager;
  sessionDir?: string;
  probe?: PiProbe;
  faux?: FauxProviderHandle;
  fauxOptions?: Omit<RegisterFauxProviderOptions, 'api' | 'provider'>;
  responses?: FauxResponseStep[];
  providerId?: string;
  modelId?: string;
  modelName?: string;
  model?: Model<string>;
  settingsManager?: SettingsManager;
  modelRuntime?: ModelRuntime;
}

export interface PiRuntimeFixture {
  readonly runtime: AgentSessionRuntime;
  readonly probe: PiProbe;
  readonly faux: FauxProviderHandle;
  readonly services: AgentSessionServices;
  readonly model: Model<string>;
  readonly settingsManager: SettingsManager;
  readonly modelRuntime: ModelRuntime;
  readonly agentDir: string;
  readonly cwd: string;
  readonly sessionDir: string;
  readonly session: AgentSession;
  readonly sessionManager: SessionManager;
  readonly sessionId: string;
  readonly sessionFile: string | undefined;
  readonly entries: ReturnType<SessionManager['getEntries']>;
  bindCurrentSession(): Promise<void>;
  reload(): Promise<void>;
  newSession(
    options?: Parameters<AgentSessionRuntime['newSession']>[0],
  ): Promise<{ cancelled: boolean }>;
  resume(
    sessionFile: string,
    options?: Parameters<AgentSessionRuntime['switchSession']>[1],
  ): Promise<{ cancelled: boolean }>;
  fork(
    entryId: string,
    options?: Parameters<AgentSessionRuntime['fork']>[1],
  ): Promise<{ cancelled: boolean; selectedText?: string }>;
  waitForIdle(): Promise<void>;
  dispose(): Promise<void>;
}

function modelFromRuntime(
  modelRuntime: ModelRuntime,
  providerId: string,
  modelId: string,
): Model<string> {
  const model = modelRuntime.getModel(providerId, modelId);
  if (!model) {
    throw new Error(`Faux fixture model ${providerId}/${modelId} was not registered`);
  }
  return model;
}

function defaultFauxOptions(
  options: CreatePiRuntimeFixtureOptions,
  providerId: string,
  modelId: string,
): RegisterFauxProviderOptions {
  return {
    api: DEFAULT_FAUX_API,
    provider: providerId,
    models: [
      {
        id: modelId,
        name: options.modelName ?? 'Pi-to-Pi deterministic faux model',
        reasoning: false,
        input: ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128_000,
        maxTokens: 16_384,
      },
    ],
    tokenSize: { min: 4096, max: 4096 },
    ...(options.fauxOptions ?? {}),
  };
}

function defaultSettings(): SettingsManager {
  return PiSettingsManager.inMemory({
    compaction: { enabled: false },
    retry: { enabled: false },
    defaultThinkingLevel: 'off',
  });
}

export async function createPiRuntimeFixture(
  options: CreatePiRuntimeFixtureOptions,
): Promise<PiRuntimeFixture> {
  const probe = options.probe ?? createPiProbe();
  const faux =
    options.faux ??
    fauxProvider(
      defaultFauxOptions(
        options,
        options.providerId ?? DEFAULT_FAUX_PROVIDER_ID,
        options.modelId ?? DEFAULT_FAUX_MODEL_ID,
      ),
    );
  const providerId = options.providerId ?? faux.provider.id;
  const modelId = options.modelId ?? faux.getModel().id;
  if (options.responses) {
    faux.setResponses(options.responses);
  }

  const settingsManager = options.settingsManager ?? defaultSettings();
  const modelRuntime =
    options.modelRuntime ??
    (await ModelRuntime.create({
      authPath: join(options.agentDir, 'auth.json'),
      modelsPath: null,
      allowModelNetwork: false,
      refreshOnCreate: false,
    }));
  if (!modelRuntime.getModel(providerId, modelId)) {
    modelRuntime.registerNativeProvider(faux.provider);
  }

  const sessionManager = options.sessionManager ?? PiSessionManager.inMemory(options.cwd);
  const extension = createInlineProbeExtension(probe);
  const createRuntime: CreateAgentSessionRuntimeFactory = async ({
    cwd,
    sessionManager: replacementSessionManager,
    sessionStartEvent,
  }) => {
    const services = await createAgentSessionServices({
      cwd,
      agentDir: options.agentDir,
      modelRuntime,
      settingsManager,
      resourceLoaderOptions: {
        extensionFactories: [extension],
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
      },
    });
    const replacementModel = options.model ?? modelFromRuntime(modelRuntime, providerId, modelId);
    const result = await createAgentSessionFromServices({
      services,
      sessionManager: replacementSessionManager,
      model: replacementModel,
      thinkingLevel: 'off',
      noTools: 'all',
      sessionStartEvent,
    });
    return {
      ...result,
      services,
      diagnostics: services.diagnostics,
    };
  };

  const runtime = await createAgentSessionRuntime(createRuntime, {
    cwd: options.cwd,
    agentDir: options.agentDir,
    sessionManager,
  });

  let unsubscribe: (() => void) | undefined;
  let disposed = false;
  const bindCurrentSession = async (): Promise<void> => {
    unsubscribe?.();
    await bindPiProbe(runtime.session, probe);
    unsubscribe = runtime.session.subscribe((event: AgentSessionEvent) => {
      probe.recordSessionEvent(event, runtime.session.sessionManager);
    });
  };

  runtime.setRebindSession(async () => {
    await bindCurrentSession();
  });
  await bindCurrentSession();

  const fixture: PiRuntimeFixture = {
    runtime,
    get services() {
      return runtime.services;
    },
    probe,
    faux,
    get model() {
      return options.model ?? modelFromRuntime(modelRuntime, providerId, modelId);
    },
    settingsManager,
    modelRuntime,
    agentDir: options.agentDir,
    cwd: options.cwd,
    sessionDir: options.sessionDir ?? sessionManager.getSessionDir(),
    get session() {
      return runtime.session;
    },
    get sessionManager() {
      return runtime.session.sessionManager;
    },
    get sessionId() {
      return runtime.session.sessionId;
    },
    get sessionFile() {
      return runtime.session.sessionFile;
    },
    get entries() {
      return runtime.session.sessionManager.getEntries();
    },
    bindCurrentSession,
    async reload() {
      await runtime.session.reload();
    },
    async newSession(newSessionOptions) {
      return runtime.newSession(newSessionOptions);
    },
    async resume(sessionFile, switchOptions) {
      return runtime.switchSession(sessionFile, switchOptions);
    },
    async fork(entryId, forkOptions) {
      return runtime.fork(entryId, forkOptions);
    },
    async waitForIdle() {
      await runtime.session.waitForIdle();
    },
    async dispose() {
      if (disposed) {
        return;
      }
      disposed = true;
      await runtime.dispose();
      unsubscribe?.();
      unsubscribe = undefined;
    },
  };

  return fixture;
}

export const createInProcessPiRuntime = createPiRuntimeFixture;
export const createPiTestRuntime = createPiRuntimeFixture;
export const createRuntimeFixture = createPiRuntimeFixture;

export function enqueueFauxResponses(
  fixture: PiRuntimeFixture,
  responses: FauxResponseStep[],
): void {
  fixture.faux.appendResponses(responses);
}

export function setFauxResponses(fixture: PiRuntimeFixture, responses: FauxResponseStep[]): void {
  fixture.faux.setResponses(responses);
}

export function defaultFauxResponse(text = 'fixture response') {
  return fauxAssistantMessage(text);
}
