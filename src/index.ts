import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

import { registerP2PFlags } from './config.js';
import {
  createPiToPiLifecycle,
  type PiToPiLifecycle,
  type PiToPiLifecycleOptions,
} from './pi/lifecycle.js';
import { PiAdapter, registerPiTools } from './pi/adapter.js';
export {
  createPiToPiLifecycle,
  createLifecycle,
  type PiToPiLifecycle,
  type PiToPiLifecycleOptions,
  type PiToPiRegistryOptions,
  type PiToPiRuntime,
} from './pi/lifecycle.js';
export {
  PiAdapter,
  registerPiTools,
  type PiAdapterOptions,
  type PiMessageDelivery,
} from './pi/adapter.js';

export {
  AgentCardRegistry,
  AgentCardRecordRegistry,
  AgentCardRegistryError,
  createAgentCardRegistry,
  createDiscoveryAgentCardRegistry,
  cleanupAgentCardState,
  cleanupStaleAgentCards,
  listLiveAgentCards,
  listLiveAgentCardPeers,
  readAgentCard,
  removeAgentCard,
  resolveAgentCardRoom,
  runtimeInstanceIdFromRuntimeId,
  type AgentCardCleanupOptions,
  type AgentCardCleanupResult,
  type AgentCardEndpointInput,
  type AgentCardListingOptions,
  type AgentCardMetadataPatch,
  type AgentCardPeerRecord,
  type AgentCardRegistryOptions,
  type AgentCardRoomInput,
} from './discovery/agent-card-registry.js';

/**
 * Register the Pi-to-Pi extension.
 *
 * Factory evaluation only registers flags and lifecycle handlers. Runtime
 * registry records and lease timers are created from `session_start`.
 */
export interface PiToPiExtensionOptions extends PiToPiLifecycleOptions {
  /** Supplied by the runtime wiring layer; this module never creates transport or discovery resources. */
  readonly adapter?: PiAdapter;
}

export default function registerPiToPi(
  pi: ExtensionAPI,
  options: PiToPiExtensionOptions = {},
): void {
  registerP2PFlags(pi);
  const lifecycle: PiToPiLifecycle = createPiToPiLifecycle(pi, options);
  const adapter = options.adapter;
  if (adapter !== undefined) {
    registerPiTools(pi, adapter);
  }

  pi.on('session_start', async (event, ctx) => {
    await lifecycle.onSessionStart(event, ctx);
    adapter?.bind({ sendMessage: pi.sendMessage.bind(pi), isIdle: ctx.isIdle.bind(ctx) });
  });
  pi.on('session_info_changed', lifecycle.onSessionInfoChanged);
  pi.on('session_shutdown', async (event, ctx) => {
    adapter?.clear();
    await lifecycle.onSessionShutdown(event, ctx);
  });
}
