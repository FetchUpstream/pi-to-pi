import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

import { registerP2PFlags } from './config.js';
import {
  createPiToPiLifecycle,
  type PiToPiLifecycle,
  type PiToPiLifecycleOptions,
} from './pi/lifecycle.js';

export {
  createPiToPiLifecycle,
  createLifecycle,
  type PiToPiLifecycle,
  type PiToPiLifecycleOptions,
  type PiToPiRegistryOptions,
  type PiToPiRuntime,
} from './pi/lifecycle.js';

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
export default function registerPiToPi(
  pi: ExtensionAPI,
  options: PiToPiLifecycleOptions = {},
): void {
  registerP2PFlags(pi);
  const lifecycle: PiToPiLifecycle = createPiToPiLifecycle(pi, options);

  pi.on('session_start', lifecycle.onSessionStart);
  pi.on('session_info_changed', lifecycle.onSessionInfoChanged);
  pi.on('session_shutdown', lifecycle.onSessionShutdown);
}
