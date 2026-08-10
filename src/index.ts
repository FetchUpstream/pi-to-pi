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
export {
  PiToPiRuntimeComposition,
  type PiToPiRuntimeCompositionOptions,
} from './runtime/composition.js';
export { LocalIpcBridge, ProtocolWireCodec, ProtocolWireError } from './runtime/wire-bridge.js';
export {
  DiagnosticEventRing,
  formatDiagnosticSnapshot,
  type DiagnosticEvent,
  type DiagnosticSnapshot,
} from './diagnostics.js';
export {
  GhIssueReporter,
  fingerprint,
  ghCommandRunner,
  renderIssueBody,
  type IssueReporter,
  type IssueReportResult,
  type ModelIssueReport,
} from './issue-reporter.js';
export interface PiToPiExtensionOptions extends PiToPiLifecycleOptions {
  /** Compatibility seam; normal installations resolve the active composition adapter. */
  readonly adapter?: PiAdapter;
}

/** Register flags, stable tools, and lifecycle callbacks without allocating runtime resources. */
export default function registerPiToPi(
  pi: ExtensionAPI,
  options: PiToPiExtensionOptions = {},
): void {
  registerP2PFlags(pi);
  const lifecycle: PiToPiLifecycle = createPiToPiLifecycle(pi, options);
  if (typeof (pi as Partial<ExtensionAPI>).registerTool === 'function') {
    registerPiTools(pi, () => options.adapter ?? lifecycle.current()?.composition.adapter);
  }

  pi.on('session_start', async (event, ctx) => {
    await lifecycle.onSessionStart(event, ctx);
    lifecycle.current()?.composition.bind({
      sendMessage: pi.sendMessage.bind(pi),
      isIdle: ctx.isIdle.bind(ctx),
    });
  });
  pi.on('session_info_changed', lifecycle.onSessionInfoChanged);
  pi.on('session_shutdown', async (event, ctx) => {
    await lifecycle.onSessionShutdown(event, ctx);
  });
}
