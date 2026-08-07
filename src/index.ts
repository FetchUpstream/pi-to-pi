import type {
  ExtensionAPI,
  ExtensionContext,
  SessionShutdownEvent,
  SessionStartEvent,
} from '@earendil-works/pi-coding-agent';

import { resolveP2PConfig, readP2PFlags, registerP2PFlags, type P2PConfig } from './config.js';
import { createRuntimeLifecycle, type RuntimeIdentity, type RuntimeLifecycle } from './identity.js';

/** Runtime-scoped identity and configuration visible to later P2P layers. */
export interface PiToPiRuntime {
  readonly identity: RuntimeIdentity;
  readonly config: P2PConfig;
}

/** Lifecycle handlers plus an inspection seam for focused lifecycle tests. */
export interface PiToPiLifecycle {
  readonly onSessionStart: (event: SessionStartEvent, ctx: ExtensionContext) => void;
  readonly onSessionShutdown: (event: SessionShutdownEvent, ctx: ExtensionContext) => void;
  readonly current: () => PiToPiRuntime | undefined;
}

/**
 * Create lifecycle handlers for one extension factory invocation.
 *
 * State is allocated only when Pi evaluates the factory, not when this module
 * is imported. No socket, timer, watcher, or session resource is created here.
 */
export function createPiToPiLifecycle(pi: Pick<ExtensionAPI, 'getFlag'>): PiToPiLifecycle {
  const identityLifecycle: RuntimeLifecycle = createRuntimeLifecycle();
  let active: PiToPiRuntime | undefined;

  return {
    onSessionStart(_event, ctx): void {
      void _event;
      const sessionId = ctx.sessionManager.getSessionId();
      const sessionName =
        typeof ctx.sessionManager.getSessionName === 'function'
          ? ctx.sessionManager.getSessionName()
          : undefined;
      const config = resolveP2PConfig({ flags: readP2PFlags(pi), sessionName });
      const identity = identityLifecycle.start(sessionId);
      active = Object.freeze({ identity, config });
    },
    onSessionShutdown(_event, _ctx): void {
      void _event;
      void _ctx;
      identityLifecycle.shutdown();
      active = undefined;
    },
    current(): PiToPiRuntime | undefined {
      return active;
    },
  };
}

/** Alias for callers that use the shorter lifecycle terminology. */
export const createLifecycle = createPiToPiLifecycle;

/**
 * Register the Pi-to-Pi extension.
 *
 * Registration is intentionally limited to namespaced configuration and native
 * session lifecycle hooks. Runtime-scoped resources belong in those handlers.
 */
export default function registerPiToPi(pi: ExtensionAPI): void {
  registerP2PFlags(pi);
  const lifecycle = createPiToPiLifecycle(pi);

  pi.on('session_start', lifecycle.onSessionStart);
  pi.on('session_shutdown', lifecycle.onSessionShutdown);
}
