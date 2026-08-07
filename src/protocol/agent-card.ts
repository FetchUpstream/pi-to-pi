import type {
  ContentType,
  OperationName,
  ProtocolVersion,
  RuntimeId,
  SessionId,
} from './messages.js';

/** A capability advertised for one of the fixed v1 operations. */
export interface OperationCapability {
  readonly operation: OperationName;
  readonly description?: string;
}

/** Content forms accepted by a peer. */
export interface ContentCapability {
  readonly type: ContentType;
  /** True when the peer accepts expected JSON response schemas. */
  readonly supportsSchema?: boolean;
}

export interface AgentCapabilities {
  readonly supportsCancellation: boolean;
  readonly supportsNotifications: boolean;
}

/** Effective limits used by this runtime and advertised through peer.describe. */
export interface ProtocolLimits {
  /** Default lifetime for ordinary message.request operations. */
  readonly requestTtlMs: number;
  /** Maximum lifetime for ordinary message.request operations. */
  readonly maxRequestTtlMs: number;
  /** Maximum lifetime for control operations such as status/cancel/describe. */
  readonly maxControlTtlMs: number;
  /** Maximum serialized envelope size. */
  readonly maxEnvelopeBytes: number;
  /** Maximum serialized expected-response schema size. */
  readonly maxSchemaBytes: number;
  /** Maximum number of queued inbound requests. */
  readonly maxQueueEntries: number;
}

export type V1ProtocolLimits = ProtocolLimits;
export type CapabilityLimits = ProtocolLimits;

/**
 * The stable identity and capability advertisement returned by peer.describe.
 * `runtimeId` identifies the live endpoint; `sessionId` may survive reload.
 */
export interface AgentCard {
  readonly name: string;
  readonly description?: string;
  readonly sessionId: SessionId;
  readonly runtimeId: RuntimeId;
  readonly supportedProtocolVersions: readonly ProtocolVersion[];
  readonly operations: readonly OperationCapability[];
  readonly contentCapabilities: readonly ContentCapability[];
  readonly capabilities: AgentCapabilities;
  readonly limits: ProtocolLimits;
}

export type PeerAgentCard = AgentCard;
