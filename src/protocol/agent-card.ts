/**
 * Versioned, discovery-only metadata published by a running Pi runtime.
 *
 * Agent Cards deliberately describe presence and transport capabilities only. They
 * must not be used as a message, task, credential, or capability-token store.
 */

export const AGENT_CARD_PROTOCOL_VERSION = 1 as const;
export const SUPPORTED_AGENT_CARD_PROTOCOL_VERSIONS = [AGENT_CARD_PROTOCOL_VERSION] as const;
export type AgentCardProtocolVersion = (typeof SUPPORTED_AGENT_CARD_PROTOCOL_VERSIONS)[number];

export const DEFAULT_LEASE_TTL_MS = 90_000;
export const DEFAULT_LEASE_RENEWAL_INTERVAL_MS = 30_000;

export const MAX_AGENT_CARD_SIZE_BYTES = 64 * 1024;
export const MAX_AGENT_ID_LENGTH = 128;
export const MAX_ROOM_ID_LENGTH = 256;
export const MAX_DISPLAY_NAME_LENGTH = 128;
export const MAX_PURPOSE_LENGTH = 512;
export const MAX_WORKING_DIRECTORY_LABEL_LENGTH = 256;
export const MAX_ROLE_TAG_LENGTH = 64;
export const MAX_ROLE_TAGS = 32;
export const MAX_ENDPOINT_ADDRESS_LENGTH = 2_048;
export const MAX_CONTEXT_TOKENS = 1_000_000_000;
export const MAX_INBOUND_QUEUE_DEPTH = 10_000;
export const MAX_MESSAGE_SIZE_BYTES = 16 * 1024 * 1024;
export const MAX_SUPPORTED_CONTENT_TYPES = 32;
export const MAX_CONTENT_TYPE_LENGTH = 128;

export const AGENT_STATES = ['idle', 'busy', 'draining'] as const;
export type AgentState = (typeof AGENT_STATES)[number];

/** Local endpoint transports supported by the first registry contract. */
export const ENDPOINT_TRANSPORTS = ['unix', 'named-pipe'] as const;
export type EndpointTransport = (typeof ENDPOINT_TRANSPORTS)[number];

/** Protocol-level capability names, rather than model/tool inventory. */
export const AGENT_CAPABILITY_NAMES = [
  'structured-replies',
  'cancellation',
  'status-updates',
] as const;
export type AgentCapabilityName = (typeof AGENT_CAPABILITY_NAMES)[number];

export interface AgentModel {
  readonly provider: string;
  readonly id: string;
}

/** A present context estimate may still have unknown individual measurements. */
export interface ContextUsage {
  readonly tokens: number | null;
  readonly percent: number | null;
}

/**
 * Protocol capabilities advertised by a runtime. This is intentionally not a
 * list of every tool exposed to a model.
 */
export interface AgentCapabilities {
  readonly structuredReplies: boolean;
  readonly cancellation: boolean;
  readonly statusUpdates: boolean;
  readonly maxMessageSize: number;
  readonly supportedContentTypes: readonly string[];
}

/** Singular alias useful to callers that refer to one capability set. */
export type AgentCapability = AgentCapabilities;

/**
 * Opaque endpoint metadata. The runtime identity is repeated here so a future
 * transport can bind an endpoint to the exact lease owner.
 */
export interface EndpointDescriptor {
  readonly kind: EndpointTransport;
  readonly address: string;
  readonly runtimeInstanceId: string;
}

export type AgentEndpoint = EndpointDescriptor;
export type ModelInfo = AgentModel;
export type AgentContextUsage = ContextUsage;

/**
 * The v1 Agent Card. Nullable fields are required members: null means that Pi
 * does not currently have that value, while empty arrays mean no entries.
 */
export interface AgentCard {
  readonly protocolVersion: AgentCardProtocolVersion;
  readonly sessionId: string;
  readonly runtimeInstanceId: string;
  readonly displayName: string;
  readonly roomId: string;
  readonly purpose: string | null;
  readonly workingDirectoryLabel: string | null;
  readonly roleTags: readonly string[];
  readonly model: AgentModel | null;
  readonly capabilities: AgentCapabilities;
  readonly state: AgentState;
  readonly contextUsage: ContextUsage | null;
  readonly inboundQueueDepth: number;
  readonly endpoint: EndpointDescriptor;
  readonly runtimeStartedAt: string;
  readonly leaseExpiresAt: string;
}

export type NullableAgentModel = AgentModel | null;
export type NullableContextUsage = ContextUsage | null;

/** Return null for every unavailable optional text value; never fabricate text. */
export function normalizeOptionalText(value: string | null | undefined): string | null {
  if (value === null || value === undefined) {
    return null;
  }

  const normalized = value.trim();
  return normalized.length === 0 ? null : normalized;
}

/** Preserve Pi's model when present and make absence explicit as null. */
export function normalizeModel(value: AgentModel | null | undefined): NullableAgentModel {
  if (value === null || value === undefined) {
    return null;
  }

  return {
    provider: value.provider,
    id: value.id,
  };
}

/**
 * Normalize Pi's context usage after compaction. Unknown subvalues remain null;
 * zero is never used as a sentinel for an unavailable measurement.
 */
export function normalizeContextUsage(
  value:
    | {
        readonly tokens?: number | null;
        readonly percent?: number | null;
      }
    | null
    | undefined,
): NullableContextUsage {
  if (value === null || value === undefined) {
    return null;
  }

  return {
    tokens: value.tokens ?? null,
    percent: value.percent ?? null,
  };
}

/** Create a stable but non-secret display fallback from the runtime identity. */
export function createFallbackDisplayName(runtimeInstanceId: string): string {
  const safeRuntimeSuffix = runtimeInstanceId
    .trim()
    .replace(/[^A-Za-z0-9]/gu, '')
    .slice(-12);
  return `pi-to-pi-${safeRuntimeSuffix || 'runtime'}`;
}

/**
 * Resolve Pi's effective display name. A missing, empty, or whitespace-only
 * session name is not replaced with prompt text or a filesystem-derived value.
 */
export function resolveDisplayName(
  sessionName: string | null | undefined,
  runtimeInstanceId: string,
): string {
  const normalizedName = sessionName?.trim();
  return normalizedName ? normalizedName : createFallbackDisplayName(runtimeInstanceId);
}

/** Alias named after the rule used by lifecycle/card construction code. */
export const effectiveDisplayName = resolveDisplayName;
