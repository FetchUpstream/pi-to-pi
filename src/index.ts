import type {
  ExtensionAPI,
  ExtensionContext,
  SessionInfoChangedEvent,
  SessionShutdownEvent,
  SessionStartEvent,
} from '@earendil-works/pi-coding-agent';

import { resolveP2PConfig, readP2PFlags, registerP2PFlags, type P2PConfig } from './config.js';
import { createRuntimeLifecycle, type RuntimeIdentity, type RuntimeLifecycle } from './identity.js';
import { resolveRoom, type ResolvedRoom } from './room.js';

/** Runtime-scoped identity and configuration visible to later P2P layers. */
export interface PiToPiRuntime {
  readonly identity: RuntimeIdentity;
  readonly config: P2PConfig;
  /** One room resolved at session_start and reused for this runtime. */
  readonly room: ResolvedRoom;
}

/** Lifecycle handlers plus an inspection seam for focused lifecycle tests. */
export interface PiToPiLifecycle {
  readonly onSessionStart: (event: SessionStartEvent, ctx: ExtensionContext) => void;
  readonly onSessionInfoChanged: (event: SessionInfoChangedEvent, ctx: ExtensionContext) => void;
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
      const room = resolveRoom({ project: config.projectOverride, cwd: ctx.cwd });
      const identity = identityLifecycle.start(sessionId);
      active = Object.freeze({ identity, config, room });
    },
    onSessionInfoChanged(event, _ctx): void {
      void _ctx;
      if (active === undefined || active.config.nameOverride !== undefined) {
        return;
      }

      const config = resolveP2PConfig({ sessionName: event.name });
      active = Object.freeze({ ...active, config });
    },
    onSessionShutdown(_event, _ctx): void {
      void _event;
      void _ctx;
      const runtime = active;
      if (runtime === undefined) {
        return;
      }

      identityLifecycle.shutdown(runtime.identity.runtimeId);
      if (active?.identity.runtimeId === runtime.identity.runtimeId) {
        active = undefined;
      }
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
  pi.on('session_info_changed', lifecycle.onSessionInfoChanged);
  pi.on('session_shutdown', lifecycle.onSessionShutdown);
}
