import type {
  ExtensionAPI,
  ExtensionContext,
  SessionInfoChangedEvent,
  SessionShutdownEvent,
  SessionStartEvent,
} from '@earendil-works/pi-coding-agent';

import { readP2PFlags, resolveP2PConfig, type P2PConfig } from '../config.js';
import { createInitialPeerName, type PublishedPeerName } from '../discovery/naming.js';
import { type RuntimeRegistry, type RuntimeRegistryOptions } from '../discovery/registry.js';
import {
  createRuntimeLifecycle,
  type RuntimeIdentity,
  type RuntimeLifecycle,
} from '../identity.js';
import { resolveRoom, type ResolvedRoom } from '../room.js';
import {
  PiToPiRuntimeComposition,
  type PiToPiRuntimeCompositionOptions,
} from '../runtime/composition.js';

export type PiToPiLifecycleOptions = Pick<
  Partial<PiToPiRuntimeCompositionOptions>,
  'registryOptions' | 'transportOptions' | 'createTransport' | 'createEndpoint'
> & {
  readonly createComposition?: (
    options: PiToPiRuntimeCompositionOptions,
  ) => PiToPiRuntimeComposition;
  /** Deprecated compatibility seam; production lifecycle never invokes it. */
  readonly createRegistry?: (options: RuntimeRegistryOptions) => RuntimeRegistry;
  readonly onError?: (error: unknown) => void;
};

export interface PiToPiRuntime {
  readonly identity: RuntimeIdentity;
  readonly config: P2PConfig;
  readonly room: ResolvedRoom;
  readonly endpoint: string;
  readonly composition: PiToPiRuntimeComposition;
  /** Legacy inspection seams; the active owner is always `composition`. */
  readonly registry: RuntimeRegistry;
  readonly publishedName: PublishedPeerName;
}

export interface PiToPiLifecycle {
  readonly onSessionStart: (event: SessionStartEvent, ctx: ExtensionContext) => Promise<void>;
  readonly onSessionInfoChanged: (
    event: SessionInfoChangedEvent,
    ctx: ExtensionContext,
  ) => Promise<void>;
  readonly onSessionShutdown: (event: SessionShutdownEvent, ctx: ExtensionContext) => Promise<void>;
  readonly current: () => PiToPiRuntime | undefined;
}

function sessionName(ctx: ExtensionContext): string | undefined {
  try {
    return ctx.sessionManager.getSessionName?.();
  } catch {
    return undefined;
  }
}

/** Lifecycle owner for a single current, generation-fenced production composition. */
export function createPiToPiLifecycle(
  pi: Pick<ExtensionAPI, 'getFlag'>,
  options: PiToPiLifecycleOptions = {},
): PiToPiLifecycle {
  const identities: RuntimeLifecycle = createRuntimeLifecycle();
  const createComposition =
    options.createComposition ?? ((input) => new PiToPiRuntimeComposition(input));
  let active: PiToPiRuntime | undefined;
  let generation = 0;
  let stopping: Promise<void> | undefined;

  const stop = (runtime: PiToPiRuntime): Promise<void> => {
    if (active === runtime) active = undefined;
    const cleanup = runtime.composition.shutdown().finally(() => {
      identities.shutdown(runtime.identity.runtimeId);
      if (stopping === cleanup) stopping = undefined;
    });
    stopping = cleanup;
    return cleanup;
  };

  return {
    async onSessionStart(_event, ctx): Promise<void> {
      if (active !== undefined) await stop(active);
      if (stopping !== undefined) await stopping;
      const identity = identities.start(ctx.sessionManager.getSessionId());
      const config = resolveP2PConfig({ flags: readP2PFlags(pi), sessionName: sessionName(ctx) });
      const room = resolveRoom({ project: config.projectOverride, cwd: ctx.cwd });
      const nextGeneration = ++generation;
      try {
        const composition = createComposition({
          identity,
          room,
          config,
          displayName: sessionName(ctx),
          generation: nextGeneration,
          registryOptions: options.registryOptions,
          transportOptions: options.transportOptions,
          createTransport: options.createTransport,
          createEndpoint: options.createEndpoint,
        });
        await composition.start();
        active = {
          identity,
          config,
          room,
          endpoint: composition.endpoint,
          composition,
          registry: composition.registry as unknown as RuntimeRegistry,
          publishedName: createInitialPeerName(identity.runtimeId, config.name),
        };
      } catch (error) {
        identities.shutdown(identity.runtimeId);
        throw error;
      }
    },

    async onSessionInfoChanged(event): Promise<void> {
      const runtime = active;
      if (
        runtime === undefined ||
        runtime.config.nameOverride !== undefined ||
        typeof event.name !== 'string'
      ) {
        return;
      }
      await runtime.composition.updateDisplayName(event.name);
      if (active === runtime) {
        active = {
          ...runtime,
          config: resolveP2PConfig({
            sessionName: event.name,
            p2pProject: runtime.config.projectOverride,
          }),
          publishedName: createInitialPeerName(runtime.identity.runtimeId, event.name),
        };
      }
    },

    async onSessionShutdown(): Promise<void> {
      const runtime = active;
      if (runtime === undefined) return stopping;
      try {
        await stop(runtime);
      } catch (error) {
        options.onError?.(error);
      }
    },

    current: () => active,
  };
}

export const createLifecycle = createPiToPiLifecycle;
