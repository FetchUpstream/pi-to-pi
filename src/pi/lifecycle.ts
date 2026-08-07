import type {
  ExtensionAPI,
  ExtensionContext,
  SessionInfoChangedEvent,
  SessionShutdownEvent,
  SessionStartEvent,
} from '@earendil-works/pi-coding-agent';

import { readP2PFlags, resolveP2PConfig, type P2PConfig } from '../config.js';
import {
  createInitialPeerName,
  synchronizePeerName,
  type PublishedPeerName,
} from '../discovery/naming.js';
import { RuntimeRegistry, type RuntimeRegistryOptions } from '../discovery/registry.js';
import {
  createRuntimeLifecycle,
  type RuntimeIdentity,
  type RuntimeLifecycle,
} from '../identity.js';
import { resolveRoom, type ResolvedRoom } from '../room.js';

/** Registry options supplied by the embedding host and lifecycle tests. */
export type PiToPiRegistryOptions = Omit<
  RuntimeRegistryOptions,
  | 'identity'
  | 'runtimeIdentity'
  | 'runtimeId'
  | 'sessionId'
  | 'roomId'
  | 'room'
  | 'networkName'
  | 'name'
  | 'endpoint'
>;

/** Endpoint construction remains opaque until the transport layer is wired. */
export type PiToPiEndpointFactory =
  string | ((identity: RuntimeIdentity, ctx: ExtensionContext) => string);

/** Options for the lifecycle integration seam and deterministic tests. */
export interface PiToPiLifecycleOptions {
  readonly registryOptions?: PiToPiRegistryOptions;
  readonly endpoint?: PiToPiEndpointFactory;
  readonly createRegistry?: (options: RuntimeRegistryOptions) => RuntimeRegistry;
  readonly onError?: (error: unknown) => void;
}

/** Runtime-scoped identity, naming, room, endpoint, and registry ownership. */
export interface PiToPiRuntime {
  readonly identity: RuntimeIdentity;
  readonly config: P2PConfig;
  readonly room: ResolvedRoom;
  readonly endpoint: string;
  readonly publishedName: PublishedPeerName;
  readonly registry: RuntimeRegistry;
}

/** Lifecycle handlers plus a read-only inspection seam for focused tests. */
export interface PiToPiLifecycle {
  readonly onSessionStart: (event: SessionStartEvent, ctx: ExtensionContext) => Promise<void>;
  readonly onSessionInfoChanged: (
    event: SessionInfoChangedEvent,
    ctx: ExtensionContext,
  ) => Promise<void>;
  readonly onSessionShutdown: (event: SessionShutdownEvent, ctx: ExtensionContext) => Promise<void>;
  readonly current: () => PiToPiRuntime | undefined;
}

interface ActiveRuntime extends PiToPiRuntime {
  stopPromise?: Promise<void>;
}

function readSessionName(ctx: ExtensionContext): string | undefined {
  try {
    return typeof ctx.sessionManager.getSessionName === 'function'
      ? ctx.sessionManager.getSessionName()
      : undefined;
  } catch {
    return undefined;
  }
}

function resolveEndpoint(
  endpoint: PiToPiEndpointFactory | undefined,
  identity: RuntimeIdentity,
  ctx: ExtensionContext,
): string {
  const value =
    typeof endpoint === 'function'
      ? endpoint(identity, ctx)
      : (endpoint ?? `unbound:${identity.runtimeId}`);
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError('lifecycle endpoint must be a non-empty string');
  }
  return value;
}

/**
 * Create lifecycle handlers for one extension factory invocation.
 *
 * Factory evaluation only creates in-memory lifecycle state. Registry paths,
 * record files, and lease timers are created after Pi emits `session_start`.
 */
export function createPiToPiLifecycle(
  pi: Pick<ExtensionAPI, 'getFlag'>,
  options: PiToPiLifecycleOptions = {},
): PiToPiLifecycle {
  const identityLifecycle: RuntimeLifecycle = createRuntimeLifecycle();
  const createRegistry =
    options.createRegistry ?? ((registryOptions) => new RuntimeRegistry(registryOptions));
  let active: ActiveRuntime | undefined;
  let stopping: Promise<void> | undefined;

  function stopRuntime(runtime: ActiveRuntime): Promise<void> {
    if (runtime.stopPromise !== undefined) {
      return runtime.stopPromise;
    }

    if (active === runtime) {
      active = undefined;
    }

    const cleanup = (async () => {
      try {
        await runtime.registry.shutdown();
      } finally {
        identityLifecycle.shutdown(runtime.identity.runtimeId);
      }
    })();
    runtime.stopPromise = cleanup;
    stopping = cleanup;

    function clearStopping(): void {
      if (stopping === cleanup) {
        stopping = undefined;
      }
    }
    void cleanup.then(clearStopping, clearStopping);
    return cleanup;
  }

  return {
    async onSessionStart(_event, ctx): Promise<void> {
      void _event;
      const previous = active;
      if (previous !== undefined) {
        await stopRuntime(previous);
      }
      if (stopping !== undefined) {
        await stopping;
      }

      const sessionId = ctx.sessionManager.getSessionId();
      const sessionName = readSessionName(ctx);
      const config = resolveP2PConfig({ flags: readP2PFlags(pi), sessionName });
      const room = resolveRoom({ project: config.projectOverride, cwd: ctx.cwd });
      const identity = identityLifecycle.start(sessionId);
      const publishedName = createInitialPeerName(identity.runtimeId, config.name);
      let endpoint: string;
      let registry: RuntimeRegistry;
      try {
        endpoint = resolveEndpoint(options.endpoint, identity, ctx);
        registry = createRegistry({
          ...options.registryOptions,
          identity,
          room,
          networkName: publishedName.networkName,
          endpoint,
        });
      } catch (error) {
        identityLifecycle.shutdown(identity.runtimeId);
        throw error;
      }
      const runtime: ActiveRuntime = {
        identity,
        config,
        room,
        endpoint,
        publishedName,
        registry,
      };
      active = runtime;

      try {
        await registry.start();
      } catch (error) {
        try {
          await stopRuntime(runtime);
        } catch (cleanupError) {
          options.onError?.(cleanupError);
        }
        throw error;
      }
    },

    async onSessionInfoChanged(event, _ctx): Promise<void> {
      void _ctx;
      const runtime = active;
      if (runtime === undefined || runtime.config.nameOverride !== undefined) {
        return;
      }

      const publishedName = synchronizePeerName(runtime.publishedName, event.name, {
        nameOverride: runtime.config.nameOverride,
      });
      if (publishedName.networkName === runtime.publishedName.networkName) {
        return;
      }

      const config = resolveP2PConfig({
        sessionName: event.name,
        projectOverride: runtime.config.projectOverride,
      });
      await runtime.registry.updateNetworkName(publishedName.networkName);
      if (active === runtime) {
        active = {
          ...runtime,
          config,
          publishedName,
        };
      }
    },

    async onSessionShutdown(_event, _ctx): Promise<void> {
      void _event;
      void _ctx;
      const runtime = active;
      const cleanup = runtime === undefined ? stopping : stopRuntime(runtime);
      if (cleanup === undefined) {
        return;
      }

      try {
        await cleanup;
      } catch (error) {
        options.onError?.(error);
      }
    },

    current(): PiToPiRuntime | undefined {
      return active;
    },
  };
}

/** Alias for callers that use the shorter lifecycle terminology. */
export const createLifecycle = createPiToPiLifecycle;
