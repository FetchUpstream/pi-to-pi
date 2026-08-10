import { DEFAULT_PROTOCOL_LIMITS, createProtocolConfig, type ProtocolConfig } from '../config.js';
import type { AgentCard } from './agent-card.js';
import {
  OPERATION_NAMES,
  PROTOCOL_VERSION,
  type ContentCapability,
  type OperationCapability,
  type ProtocolCapabilities,
  type ProtocolLimits,
  type ProtocolVersion,
  type PeerDescribeResult,
} from './messages.js';

export interface ProtocolCapabilityOptions {
  readonly limits?: Partial<ProtocolConfig>;
  readonly supportedWireVersions?: readonly ProtocolVersion[];
  readonly operations?: readonly OperationCapability[];
  readonly contentCapabilities?: readonly ContentCapability[];
  readonly supportsStructuredResponses?: boolean;
  readonly supportsCancellation?: boolean;
  readonly supportsNotifications?: boolean;
}

/** Build the exact v1 capability projection from effective bounded policy. */
export function createProtocolCapabilities(
  options: ProtocolCapabilityOptions = {},
): ProtocolCapabilities {
  const limits: ProtocolLimits = createProtocolConfig(options.limits);
  const supportedWireVersions = options.supportedWireVersions ?? [PROTOCOL_VERSION];
  if (supportedWireVersions.some((version) => version !== PROTOCOL_VERSION)) {
    throw new RangeError('only protocol wire version 1.0 is supported');
  }
  const operations = options.operations ?? OPERATION_NAMES.map((operation) => ({ operation }));
  const contentCapabilities = options.contentCapabilities ?? [
    { type: 'text' },
    { type: 'json', supportsSchema: true },
  ];
  return Object.freeze({
    supportedWireVersions: Object.freeze([...supportedWireVersions]),
    operations: Object.freeze(operations.map((operation) => Object.freeze({ ...operation }))),
    contentCapabilities: Object.freeze(
      contentCapabilities.map((capability) => Object.freeze({ ...capability })),
    ),
    supportsStructuredResponses: options.supportsStructuredResponses ?? true,
    supportsCancellation: options.supportsCancellation ?? true,
    supportsNotifications: options.supportsNotifications ?? true,
    limits: Object.freeze({ ...limits }),
  });
}

export const createProtocolCapabilityProjection = createProtocolCapabilities;
export const projectProtocolCapabilities = createProtocolCapabilities;
export const getProtocolCapabilities = createProtocolCapabilities;

/** Construct the non-task peer.describe result without altering the discovery card. */
export function createPeerDescribeResult(
  agentCard: AgentCard,
  options: ProtocolCapabilityOptions = {},
): PeerDescribeResult {
  const capabilities = createProtocolCapabilities(options);
  return Object.freeze({ agentCard, capabilities, protocolCapabilities: capabilities });
}

export const buildPeerDescribeResult = createPeerDescribeResult;
export const createPeerDescription = createPeerDescribeResult;

/** Defaults are exposed as a value for adapters that only need policy limits. */
export const DEFAULT_CAPABILITY_LIMITS: Readonly<ProtocolLimits> = DEFAULT_PROTOCOL_LIMITS;
