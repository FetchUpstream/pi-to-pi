/**
 * Discovery advertisements and authenticated targeting contracts.
 *
 * The registry is intentionally presence-only.  It stores runtime identity,
 * Agent Card capabilities/limits, a current opaque routing endpoint, and lease
 * metadata.  It does not store binding credentials, application content,
 * fingerprints, task state, or deduplication records.
 */

import { DEFAULT_PROTOCOL_LIMITS } from '../config.js';
import type { SessionRuntimeIdentity } from '../identity.js';
import type {
  AgentCapabilities,
  AgentCard,
  ContentCapability,
  OperationCapability,
  ProtocolLimits,
} from '../protocol/agent-card.js';
import { createProtocolError, type ProtocolError } from '../protocol/errors.js';
import {
  OPERATION_NAMES,
  PROTOCOL_VERSION,
  type OperationName,
  type ProtocolEnvelope,
  type ProtocolVersion,
  type RoomId,
  type RuntimeId,
  type SenderIdentity,
  type SessionId,
  type UtcTimestamp,
} from '../protocol/messages.js';
import type { RoomIdentity } from '../room.js';
import {
  DEFAULT_LEASE_RENEWAL_INTERVAL_MS,
  DEFAULT_LEASE_TTL_MS,
  Lease,
  type LeaseClock,
  type LeaseExpiryOptions,
  type LeaseRenewalResult,
  type LeaseScheduler,
  type LeaseSnapshot,
  type RoutingEndpoint,
  type SerializedLease,
  type SerializedLeaseOptions,
} from './lease.js';
import { SerializedLease as SerializedLeaseImplementation } from './lease.js';

export { DEFAULT_LEASE_RENEWAL_INTERVAL_MS, DEFAULT_LEASE_TTL_MS, Lease };
export type {
  CurrentRoutingEndpoint,
  EndpointDescriptor,
  LeaseClock,
  LeaseExpiryOptions,
  LeaseLifecycleState,
  LeaseOwnerIdentity,
  LeaseRenewal,
  LeaseRenewalResult,
  LeaseScheduler,
  LeaseSnapshot,
  LeaseState,
  RoutingEndpoint,
  RoutingEndpointDescriptor,
  SerializedLeaseOptions,
} from './lease.js';

/** An endpoint and lease are transport metadata, not application payload. */
export type RoutingAddress = RoutingEndpoint;
export type CurrentEndpoint = RoutingEndpoint;

/** A Card augmented with the discovery-only room, endpoint, and lease fields. */
export type AdvertisedAgentCard = AgentCard & {
  readonly roomId: RoomId;
  readonly endpoint: RoutingEndpoint;
  readonly leaseExpiresAt: UtcTimestamp;
};
export type DiscoveryAgentCard = AdvertisedAgentCard;

/**
 * Input accepted by publication.  `bindingMetadata` is deliberately accepted
 * only as a separate field and is ignored; it is never copied into a card or
 * logical registry record.
 */
export interface AgentCardPublication {
  readonly card: AgentCard;
  readonly roomId?: RoomId;
  readonly endpoint: RoutingEndpoint;
  readonly leaseExpiresAt?: string | number | Date;
  readonly leaseTtlMs?: number;
  readonly bindingMetadata?: BindingMetadata;
}
export type AgentAdvertisementInput = AgentCardPublication;
export type DiscoveryAdvertisementInput = AgentCardPublication;

/** One live runtime advertisement returned by discovery. */
export interface RuntimeAdvertisement {
  readonly identity: SessionRuntimeIdentity;
  readonly sessionId: SessionId;
  readonly runtimeId: RuntimeId;
  readonly roomId: RoomId;
  readonly card: AdvertisedAgentCard;
  /** Alias retained for callers that name the nested card explicitly. */
  readonly agentCard: AdvertisedAgentCard;
  readonly endpoint: RoutingEndpoint;
  readonly lease: LeaseSnapshot;
  readonly leaseExpiresAt: UtcTimestamp;
  /** Flattened aliases make the advertised contract easy to consume. */
  readonly supportedProtocolVersions: readonly ProtocolVersion[];
  readonly operations: readonly OperationCapability[];
  readonly contentCapabilities: readonly ContentCapability[];
  readonly capabilities: AgentCapabilities;
  readonly limits: ProtocolLimits;
}
export type RegistryRecord = RuntimeAdvertisement;
export type RegisteredRuntime = RuntimeAdvertisement;
export type DiscoveryRecord = RuntimeAdvertisement;
export type AgentCardAdvertisement = RuntimeAdvertisement;
export type PeerAdvertisement = RuntimeAdvertisement;
export type RuntimeRegistration = RuntimeAdvertisement;

export interface AgentCardRegistryOptions {
  /** Canonical room identity supplied by the room module. */
  readonly roomIdentity?: Pick<RoomIdentity, 'roomId'>;
  readonly room?: Pick<RoomIdentity, 'roomId'>;
  readonly roomId?: RoomId;
  /** Local runtime identity used for publication and recipient targeting. */
  readonly identity?: SessionRuntimeIdentity;
  readonly runtimeId?: RuntimeId;
  readonly runtimeInstanceId?: RuntimeId;
  readonly sessionId?: SessionId;
  readonly now?: LeaseClock;
  readonly leaseTtlMs?: number;
  readonly leaseRenewalIntervalMs?: number;
  readonly scheduler?: LeaseScheduler;
}
export type DiscoveryRegistryOptions = AgentCardRegistryOptions;

export interface RegistryListOptions {
  readonly now?: number | Date;
}
export interface RegistryCleanupOptions extends RegistryListOptions {
  readonly ttlMs?: number;
}
export interface RegistryRenewalOptions extends LeaseExpiryOptions {
  readonly endpoint?: RoutingEndpoint;
}

export interface RegistryLeaseOptions extends Omit<
  SerializedLeaseOptions,
  'renew' | 'identity' | 'endpoint' | 'ttlMs' | 'renewalIntervalMs'
> {
  readonly ttlMs?: number;
  readonly renewalIntervalMs?: number;
}

export type AgentCardSource =
  | AgentCardPublication
  | AgentCard
  | (() => AgentCardPublication | AgentCard | PromiseLike<AgentCardPublication | AgentCard>);

export type RegistryErrorCode =
  'malformed' | 'expired' | 'cross_room' | 'duplicate' | 'unauthorized' | 'not_found';

export class AgentCardRegistryError extends Error {
  public readonly code: RegistryErrorCode;

  public constructor(code: RegistryErrorCode, message: string) {
    super(message);
    this.name = 'AgentCardRegistryError';
    this.code = code;
  }
}

export class AgentCardRegistryConflictError extends AgentCardRegistryError {
  public constructor(message = 'runtime identity is already registered') {
    super('duplicate', message);
    this.name = 'AgentCardRegistryConflictError';
  }
}

export class AgentCardRegistryAuthorizationError extends AgentCardRegistryError {
  public constructor(message = 'runtime is not authorized to mutate this advertisement') {
    super('unauthorized', message);
    this.name = 'AgentCardRegistryAuthorizationError';
  }
}

export interface LocalRuntimeTarget {
  readonly runtimeId: RuntimeId;
  readonly roomId: RoomId;
}
export type VerificationTarget = LocalRuntimeTarget;

/** Binding credentials are metadata and never part of a protocol payload. */
export type BindingMetadata = Readonly<Record<string, unknown>>;
export type BindingCredentialsMetadata = BindingMetadata;

export interface BindingAuthenticationContext {
  readonly claimedSender: SenderIdentity;
  readonly recipientRuntimeId: RuntimeId;
  readonly roomId: RoomId;
  readonly localRuntimeId: RuntimeId;
  readonly localRoomId: RoomId;
}

export interface BindingAuthenticationSuccess {
  readonly authenticated: true;
  readonly identity: SessionRuntimeIdentity;
}

export interface BindingAuthenticationFailure {
  readonly authenticated: false;
}

export type BindingAuthenticationResult =
  BindingAuthenticationSuccess | BindingAuthenticationFailure;
export type BindingAuthResult = BindingAuthenticationResult;
export type BindingAwaitable<Value> = Value | PromiseLike<Value>;

/**
 * A binding supplies authentication; the registry does not select a concrete
 * token, socket, OS credential, or cryptographic mechanism.
 */
export interface BindingAuthenticator<Metadata extends BindingMetadata = BindingMetadata> {
  readonly authenticate?: (
    metadata: Metadata | undefined,
    context: BindingAuthenticationContext,
  ) => BindingAwaitable<BindingAuthenticationResult>;
  /** `verify` is a naming-compatible alternative for binding adapters. */
  readonly verify?: (
    metadata: Metadata | undefined,
    context: BindingAuthenticationContext,
  ) => BindingAwaitable<BindingAuthenticationResult>;
}
export type BindingAuth = BindingAuthenticator;

export interface TargetedOperation {
  readonly sender: SenderIdentity;
  readonly recipientRuntimeId: RuntimeId;
  readonly roomId: RoomId;
}

/** A protocol envelope plus binding-only metadata kept outside application data. */
export interface AuthenticatedOperation<Envelope extends TargetedOperation = TargetedOperation> {
  readonly envelope: Envelope;
  readonly bindingMetadata?: BindingMetadata;
  /** Alias accepted at the binding boundary; never retained in a registry record. */
  readonly metadata?: BindingMetadata;
}
export type InboundOperation<Envelope extends TargetedOperation = TargetedOperation> =
  AuthenticatedOperation<Envelope>;

export interface AuthorizedTarget<Envelope extends TargetedOperation = TargetedOperation> {
  readonly ok: true;
  readonly envelope: Envelope;
  readonly sender: SessionRuntimeIdentity;
  readonly recipientRuntimeId: RuntimeId;
  readonly roomId: RoomId;
}

export interface TargetVerificationFailure {
  readonly ok: false;
  readonly error: ProtocolError;
}

export type TargetVerificationResult<Envelope extends TargetedOperation = TargetedOperation> =
  AuthorizedTarget<Envelope> | TargetVerificationFailure;

export class TargetAuthorizationError extends Error {
  public readonly error: ProtocolError;

  public constructor(error: ProtocolError) {
    super(error.message);
    this.name = 'TargetAuthorizationError';
    this.error = error;
  }
}

interface StoredRuntimeAdvertisement {
  readonly record: RuntimeAdvertisement;
  readonly expiresAtMs: number;
  readonly ttlMs: number;
}

interface PublicationParts {
  readonly card: AgentCard;
  readonly roomId?: RoomId;
  readonly endpoint: RoutingEndpoint;
  readonly leaseExpiresAt?: string | number | Date;
  readonly leaseTtlMs?: number;
}

const MAX_ENDPOINT_LENGTH = 16_384;
const MAX_NAME_LENGTH = 512;
const MAX_DESCRIPTION_LENGTH = 8_192;
const FORBIDDEN_METADATA_KEYS = new Set([
  'apiKey',
  'apiToken',
  'capabilitySecret',
  'capabilityToken',
  'credentials',
  'password',
  'secret',
  'token',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmptyText(value: unknown, label: string, maxLength = MAX_NAME_LENGTH): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > maxLength) {
    throw new AgentCardRegistryError('malformed', `${label} must be bounded non-empty text`);
  }
  return value;
}

function roomValue(value: unknown, label: string): RoomId {
  const result = nonEmptyText(value, label, 256);
  return result as RoomId;
}

function runtimeValue(value: unknown, label: string): RuntimeId {
  const result = nonEmptyText(value, label, 256);
  return result as RuntimeId;
}

function sessionValue(value: unknown, label: string): SessionId {
  const result = nonEmptyText(value, label, 512);
  return result as SessionId;
}

function resolveRoom(options: AgentCardRegistryOptions): RoomId {
  const supplied = options.roomIdentity?.roomId ?? options.room?.roomId ?? options.roomId;
  if (supplied === undefined) {
    throw new AgentCardRegistryError('malformed', 'a canonical room identity is required');
  }
  return roomValue(supplied, 'roomId');
}

function resolveIdentity(options: AgentCardRegistryOptions): SessionRuntimeIdentity | undefined {
  const runtimeId = options.identity?.runtimeId ?? options.runtimeId ?? options.runtimeInstanceId;
  const sessionId = options.identity?.sessionId ?? options.sessionId;
  if (runtimeId === undefined && sessionId === undefined) {
    return undefined;
  }
  if (runtimeId === undefined) {
    throw new AgentCardRegistryError('malformed', 'runtimeId is required for a local identity');
  }
  const normalizedRuntimeId = runtimeValue(runtimeId, 'runtimeId');
  if (sessionId === undefined) {
    // Recipient targeting only needs the local runtime ID.  A full session/runtime
    // pair is still required when this registry publishes its own card.
    return undefined;
  }
  const identity = Object.freeze({
    runtimeId: normalizedRuntimeId,
    sessionId: sessionValue(sessionId, 'sessionId'),
  });
  if (options.identity !== undefined) {
    if (
      identity.runtimeId !== options.identity.runtimeId ||
      identity.sessionId !== options.identity.sessionId
    ) {
      throw new AgentCardRegistryError('malformed', 'identity aliases must agree');
    }
  }
  return identity;
}

function resolveDuration(value: number | undefined, fallback: number, label: string): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result <= 0) {
    throw new AgentCardRegistryError('malformed', `${label} must be a positive safe integer`);
  }
  return result;
}

function resolveNow(value: number | Date | undefined, clock: LeaseClock): number {
  const result = value instanceof Date ? value.getTime() : (value ?? clock());
  if (!Number.isFinite(result)) {
    throw new AgentCardRegistryError('malformed', 'registry time must be finite');
  }
  return result;
}

function parseExpiry(value: string | number | Date, label: string): number {
  const result =
    value instanceof Date ? value.getTime() : typeof value === 'number' ? value : Date.parse(value);
  if (!Number.isFinite(result)) {
    throw new AgentCardRegistryError('malformed', `${label} must be a finite timestamp`);
  }
  return result;
}

function isoTimestamp(value: number): UtcTimestamp {
  const result = new Date(value);
  if (!Number.isFinite(result.getTime())) {
    throw new AgentCardRegistryError(
      'malformed',
      'lease expiry is outside the supported date range',
    );
  }
  return result.toISOString() as UtcTimestamp;
}

function cloneEndpoint(endpoint: RoutingEndpoint, runtimeId?: RuntimeId): RoutingEndpoint {
  validateEndpoint(endpoint, runtimeId);
  if (typeof endpoint === 'string') {
    return endpoint;
  }
  const copy: {
    address: string;
    kind?: string;
    transport?: string;
    runtimeId?: RuntimeId;
  } = { address: endpoint.address };
  if (endpoint.kind !== undefined) {
    copy.kind = endpoint.kind;
  }
  if (endpoint.transport !== undefined) {
    copy.transport = endpoint.transport;
  }
  if (endpoint.runtimeId !== undefined) {
    copy.runtimeId = endpoint.runtimeId;
  }
  return Object.freeze(copy);
}

function validateEndpoint(endpoint: RoutingEndpoint, runtimeId?: RuntimeId): void {
  if (typeof endpoint === 'string') {
    if (endpoint.trim().length === 0 || endpoint.length > MAX_ENDPOINT_LENGTH) {
      throw new AgentCardRegistryError(
        'malformed',
        'routing endpoint must be bounded non-empty text',
      );
    }
    return;
  }
  if (!isRecord(endpoint)) {
    throw new AgentCardRegistryError('malformed', 'routing endpoint must be an opaque descriptor');
  }
  if (typeof endpoint.address !== 'string' || endpoint.address.trim().length === 0) {
    throw new AgentCardRegistryError(
      'malformed',
      'routing endpoint address must be non-empty text',
    );
  }
  if (endpoint.address.length > MAX_ENDPOINT_LENGTH) {
    throw new AgentCardRegistryError('malformed', 'routing endpoint address is too large');
  }
  if (endpoint.kind !== undefined && typeof endpoint.kind !== 'string') {
    throw new AgentCardRegistryError('malformed', 'routing endpoint kind must be text');
  }
  if (endpoint.transport !== undefined && typeof endpoint.transport !== 'string') {
    throw new AgentCardRegistryError('malformed', 'routing endpoint transport must be text');
  }
  if (endpoint.kind === undefined && endpoint.transport === undefined) {
    throw new AgentCardRegistryError(
      'malformed',
      'routing endpoint must identify its transport kind',
    );
  }
  if (
    endpoint.kind !== undefined &&
    endpoint.transport !== undefined &&
    endpoint.kind !== endpoint.transport
  ) {
    throw new AgentCardRegistryError('malformed', 'routing endpoint kind and transport must agree');
  }
  if (endpoint.runtimeId !== undefined && endpoint.runtimeId !== runtimeId) {
    throw new AgentCardRegistryError(
      'unauthorized',
      'routing endpoint is not owned by the runtime',
    );
  }
  for (const key of Object.keys(endpoint)) {
    if (FORBIDDEN_METADATA_KEYS.has(key)) {
      throw new AgentCardRegistryError('malformed', 'routing endpoint cannot carry credentials');
    }
  }
}

function unique<T>(values: readonly T[], label: string): void {
  if (new Set(values).size !== values.length) {
    throw new AgentCardRegistryError('malformed', `${label} must not contain duplicates`);
  }
}

function cloneCard(card: AgentCard, identity?: SessionRuntimeIdentity): AgentCard {
  if (!isRecord(card)) {
    throw new AgentCardRegistryError('malformed', 'Agent Card must be an object');
  }
  const name = nonEmptyText(card.name, 'Agent Card name');
  const sessionId = sessionValue(card.sessionId, 'Agent Card sessionId');
  const runtimeId = runtimeValue(card.runtimeId, 'Agent Card runtimeId');
  if (
    identity !== undefined &&
    (sessionId !== identity.sessionId || runtimeId !== identity.runtimeId)
  ) {
    throw new AgentCardRegistryError(
      'unauthorized',
      'Agent Card identity does not match its runtime',
    );
  }

  if (
    !Array.isArray(card.supportedProtocolVersions) ||
    card.supportedProtocolVersions.length === 0
  ) {
    throw new AgentCardRegistryError(
      'malformed',
      'Agent Card must advertise supported protocol versions',
    );
  }
  const versions = card.supportedProtocolVersions.map((version) => {
    if (version !== PROTOCOL_VERSION) {
      throw new AgentCardRegistryError(
        'malformed',
        'Agent Card advertises an unsupported protocol version',
      );
    }
    return version;
  });
  unique(versions, 'supportedProtocolVersions');

  if (!Array.isArray(card.operations) || card.operations.length === 0) {
    throw new AgentCardRegistryError('malformed', 'Agent Card must advertise supported operations');
  }
  const operations = card.operations.map((capability) => cloneOperationCapability(capability));
  unique(
    operations.map((capability) => capability.operation),
    'operations',
  );
  for (const capability of operations) {
    if (!OPERATION_NAMES.includes(capability.operation)) {
      throw new AgentCardRegistryError('malformed', 'Agent Card advertises an unknown operation');
    }
  }

  if (!Array.isArray(card.contentCapabilities) || card.contentCapabilities.length === 0) {
    throw new AgentCardRegistryError('malformed', 'Agent Card must advertise content capabilities');
  }
  const contentCapabilities = card.contentCapabilities.map((capability) =>
    cloneContentCapability(capability),
  );
  unique(
    contentCapabilities.map((capability) => capability.type),
    'contentCapabilities',
  );

  const capabilities = cloneCapabilities(card.capabilities);
  const limits = cloneLimits(card.limits);
  const description = card.description;
  if (
    description !== undefined &&
    (typeof description !== 'string' || description.length > MAX_DESCRIPTION_LENGTH)
  ) {
    throw new AgentCardRegistryError('malformed', 'Agent Card description is too large');
  }

  return Object.freeze({
    name,
    ...(description === undefined ? {} : { description }),
    sessionId,
    runtimeId,
    supportedProtocolVersions: Object.freeze(versions),
    operations: Object.freeze(operations),
    contentCapabilities: Object.freeze(contentCapabilities),
    capabilities,
    limits,
  });
}

function cloneOperationCapability(value: OperationCapability): OperationCapability {
  if (!isRecord(value) || typeof value.operation !== 'string') {
    throw new AgentCardRegistryError('malformed', 'operation capability is malformed');
  }
  const operation = value.operation as OperationName;
  if (value.description !== undefined && typeof value.description !== 'string') {
    throw new AgentCardRegistryError('malformed', 'operation capability description must be text');
  }
  return Object.freeze({
    operation,
    ...(value.description === undefined ? {} : { description: value.description }),
  });
}

function cloneContentCapability(value: ContentCapability): ContentCapability {
  if (!isRecord(value) || (value.type !== 'text' && value.type !== 'json')) {
    throw new AgentCardRegistryError('malformed', 'content capability is malformed');
  }
  if (value.supportsSchema !== undefined && typeof value.supportsSchema !== 'boolean') {
    throw new AgentCardRegistryError('malformed', 'content capability schema flag must be boolean');
  }
  return Object.freeze({
    type: value.type,
    ...(value.supportsSchema === undefined ? {} : { supportsSchema: value.supportsSchema }),
  });
}

function cloneCapabilities(value: AgentCapabilities): AgentCapabilities {
  if (!isRecord(value)) {
    throw new AgentCardRegistryError('malformed', 'Agent Card capabilities are malformed');
  }
  if (
    typeof value.supportsCancellation !== 'boolean' ||
    typeof value.supportsNotifications !== 'boolean'
  ) {
    throw new AgentCardRegistryError('malformed', 'Agent Card capability flags must be boolean');
  }
  return Object.freeze({
    supportsCancellation: value.supportsCancellation,
    supportsNotifications: value.supportsNotifications,
  });
}

function cloneLimits(value: ProtocolLimits): ProtocolLimits {
  if (!isRecord(value)) {
    throw new AgentCardRegistryError('malformed', 'Agent Card limits are malformed');
  }
  const fields = Object.keys(DEFAULT_PROTOCOL_LIMITS) as Array<keyof ProtocolLimits>;
  const limits = {} as ProtocolLimits;
  for (const field of fields) {
    const limit = value[field];
    const ceiling = DEFAULT_PROTOCOL_LIMITS[field];
    if (!Number.isSafeInteger(limit) || limit <= 0 || limit > ceiling) {
      throw new AgentCardRegistryError(
        'malformed',
        `Agent Card limit ${field} must be a positive value no greater than ${ceiling}`,
      );
    }
    (limits as Record<keyof ProtocolLimits, number>)[field] = limit;
  }
  if (limits.requestTtlMs > limits.maxRequestTtlMs) {
    throw new AgentCardRegistryError('malformed', 'requestTtlMs must not exceed maxRequestTtlMs');
  }
  return Object.freeze(limits);
}

function extractPublication(input: AgentCardPublication | AgentCard): PublicationParts {
  if (!isRecord(input)) {
    throw new AgentCardRegistryError('malformed', 'Agent Card publication must be an object');
  }
  const raw = input as Record<string, unknown>;
  const nestedCard = isRecord(raw.card) ? raw.card : undefined;
  const card = (nestedCard ?? raw) as unknown as AgentCard;
  const roomId = (raw.roomId ?? nestedCard?.roomId) as RoomId | undefined;
  const endpoint = (raw.endpoint ?? nestedCard?.endpoint) as RoutingEndpoint | undefined;
  if (endpoint === undefined) {
    throw new AgentCardRegistryError('malformed', 'current routing endpoint is required');
  }
  const leaseExpiresAt = Object.hasOwn(raw, 'leaseExpiresAt')
    ? raw.leaseExpiresAt
    : nestedCard?.leaseExpiresAt;
  if (
    leaseExpiresAt !== undefined &&
    typeof leaseExpiresAt !== 'string' &&
    typeof leaseExpiresAt !== 'number' &&
    !(leaseExpiresAt instanceof Date)
  ) {
    throw new AgentCardRegistryError('malformed', 'leaseExpiresAt must be a timestamp');
  }
  const leaseTtlMs = Object.hasOwn(raw, 'leaseTtlMs') ? raw.leaseTtlMs : nestedCard?.leaseTtlMs;
  if (leaseTtlMs !== undefined && typeof leaseTtlMs !== 'number') {
    throw new AgentCardRegistryError('malformed', 'leaseTtlMs must be a number');
  }
  return {
    card,
    roomId,
    endpoint,
    ...(leaseExpiresAt === undefined ? {} : { leaseExpiresAt }),
    ...(leaseTtlMs === undefined ? {} : { leaseTtlMs }),
  };
}

function cardWithDiscoveryFields(
  card: AgentCard,
  roomId: RoomId,
  endpoint: RoutingEndpoint,
  leaseExpiresAt: UtcTimestamp,
): AdvertisedAgentCard {
  return Object.freeze({
    ...card,
    roomId,
    endpoint,
    leaseExpiresAt,
  });
}

function leaseSnapshot(
  identity: SessionRuntimeIdentity,
  endpoint: RoutingEndpoint,
  now: number,
  expiresAt: number,
  ttlMs: number,
  renewalIntervalMs: number,
): LeaseSnapshot {
  return Object.freeze({
    state: 'active',
    running: true,
    stopped: false,
    sessionId: identity.sessionId,
    runtimeId: identity.runtimeId,
    endpoint,
    ttlMs,
    renewalIntervalMs,
    issuedAt: now,
    lastRenewedAt: now,
    expiresAt,
    leaseExpiresAt: isoTimestamp(expiresAt),
    lastError: null,
  });
}

function publicationWithoutLeaseFields(record: RuntimeAdvertisement): AgentCardPublication {
  return {
    card: record.card,
    roomId: record.roomId,
    endpoint: record.endpoint,
    leaseTtlMs: record.lease.ttlMs,
  };
}

function isLive(record: StoredRuntimeAdvertisement, now: number): boolean {
  return now < record.expiresAtMs;
}

function safeError(code: 'unauthorized' | 'cross_room'): ProtocolError {
  return createProtocolError(
    code,
    code === 'cross_room'
      ? 'operation room does not match the local room'
      : 'operation is unauthorized',
  );
}

function isTargetedOperation(value: unknown): value is TargetedOperation {
  if (!isRecord(value) || !isRecord(value.sender)) {
    return false;
  }
  return (
    typeof value.sender.sessionId === 'string' &&
    typeof value.sender.runtimeId === 'string' &&
    typeof value.recipientRuntimeId === 'string' &&
    typeof value.roomId === 'string'
  );
}

function unwrapInbound<Envelope extends TargetedOperation>(
  input: AuthenticatedOperation<Envelope> | Envelope,
): { envelope: Envelope; metadata: BindingMetadata | undefined } {
  if (isRecord(input) && 'envelope' in input && isTargetedOperation(input.envelope)) {
    const metadata = (input.bindingMetadata ?? input.metadata) as BindingMetadata | undefined;
    return { envelope: input.envelope as Envelope, metadata };
  }
  return { envelope: input as Envelope, metadata: undefined };
}

function authenticatedIdentity(value: unknown): SessionRuntimeIdentity | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const candidate = isRecord(value.identity)
    ? value.identity
    : isRecord(value.sender)
      ? value.sender
      : value;
  if (
    typeof candidate.sessionId !== 'string' ||
    candidate.sessionId.length === 0 ||
    typeof candidate.runtimeId !== 'string' ||
    candidate.runtimeId.length === 0
  ) {
    return undefined;
  }
  return Object.freeze({
    sessionId: candidate.sessionId as SessionId,
    runtimeId: candidate.runtimeId as RuntimeId,
  });
}

async function authenticateBinding(
  authenticator: BindingAuthenticator,
  metadata: BindingMetadata | undefined,
  context: BindingAuthenticationContext,
): Promise<SessionRuntimeIdentity | undefined> {
  const method = authenticator.authenticate ?? authenticator.verify;
  if (method === undefined) {
    return undefined;
  }
  try {
    const result = await method.call(authenticator, metadata, context);
    if (isRecord(result) && result.authenticated === false) {
      return undefined;
    }
    if (isRecord(result) && result.authenticated === true) {
      return authenticatedIdentity(result);
    }
    return authenticatedIdentity(result);
  } catch {
    // Binding failures are intentionally collapsed to the safe unauthorized
    // result; no binding detail is allowed to reach an application response.
    return undefined;
  }
}

function unauthorizedResult(): TargetVerificationFailure {
  return Object.freeze({ ok: false, error: safeError('unauthorized') });
}

function crossRoomResult(): TargetVerificationFailure {
  return Object.freeze({ ok: false, error: safeError('cross_room') });
}

/**
 * Verify a binding-authenticated sender and target before any application
 * lookup.  The order is intentional: binding validity and claimed sender are
 * checked first, exact room equality is checked second, and recipient targeting
 * is checked last.  A caller can therefore safely invoke task/dedupe lookup
 * only after receiving an `ok: true` result.
 */
export function verifyAuthenticatedTarget<Envelope extends TargetedOperation>(
  input: AuthenticatedOperation<Envelope> | Envelope,
  authenticator: BindingAuthenticator,
  target: VerificationTarget,
): Promise<TargetVerificationResult<Envelope>>;
export function verifyAuthenticatedTarget<Envelope extends TargetedOperation>(
  input: Envelope,
  metadata: BindingMetadata | undefined,
  authenticator: BindingAuthenticator,
  target: VerificationTarget,
): Promise<TargetVerificationResult<Envelope>>;
export async function verifyAuthenticatedTarget<Envelope extends TargetedOperation>(
  input: AuthenticatedOperation<Envelope> | Envelope,
  authenticatorOrMetadata: BindingAuthenticator | BindingMetadata | undefined,
  targetOrAuthenticator: VerificationTarget | BindingAuthenticator,
  maybeTarget?: VerificationTarget,
): Promise<TargetVerificationResult<Envelope>> {
  const authenticator = (
    maybeTarget === undefined ? authenticatorOrMetadata : targetOrAuthenticator
  ) as BindingAuthenticator;
  const target = (
    maybeTarget === undefined ? targetOrAuthenticator : maybeTarget
  ) as VerificationTarget;
  const verificationInput =
    maybeTarget === undefined
      ? input
      : ({
          envelope: input,
          bindingMetadata: authenticatorOrMetadata,
        } as AuthenticatedOperation<Envelope>);
  const { envelope, metadata } = unwrapInbound(verificationInput);
  if (!isTargetedOperation(envelope)) {
    return unauthorizedResult();
  }

  const context: BindingAuthenticationContext = Object.freeze({
    claimedSender: envelope.sender,
    recipientRuntimeId: envelope.recipientRuntimeId,
    roomId: envelope.roomId,
    localRuntimeId: target.runtimeId,
    localRoomId: target.roomId,
  });
  const authenticated = await authenticateBinding(authenticator, metadata, context);
  if (
    authenticated === undefined ||
    authenticated.sessionId !== envelope.sender.sessionId ||
    authenticated.runtimeId !== envelope.sender.runtimeId
  ) {
    return unauthorizedResult();
  }

  // Room mismatch is deliberately distinguishable only after authentication.
  // No task, request, or dedupe identifier is inspected on either failure path.
  if (envelope.roomId !== target.roomId) {
    return crossRoomResult();
  }
  if (envelope.recipientRuntimeId !== target.runtimeId) {
    return unauthorizedResult();
  }

  return Object.freeze({
    ok: true,
    envelope,
    sender: authenticated,
    recipientRuntimeId: envelope.recipientRuntimeId,
    roomId: envelope.roomId,
  });
}

export const verifyAuthenticatedSender = verifyAuthenticatedTarget;
export const verifyInboundTarget = verifyAuthenticatedTarget;
export const verifyBindingTarget = verifyAuthenticatedTarget;
export const verifySenderIdentity = verifyAuthenticatedTarget;
export const verifyRecipientTarget = verifyAuthenticatedTarget;
export const authorizeInbound = verifyAuthenticatedTarget;

/** Run a caller-supplied lookup only after target verification succeeds. */
export async function authorizeBeforeLookup<Envelope extends TargetedOperation, Result>(
  input: AuthenticatedOperation<Envelope> | Envelope,
  authenticator: BindingAuthenticator,
  target: VerificationTarget,
  lookup: (authorized: AuthorizedTarget<Envelope>) => Result | PromiseLike<Result>,
): Promise<TargetVerificationFailure | Result> {
  const verification = await verifyAuthenticatedTarget(input, authenticator, target);
  if (!verification.ok) {
    return verification;
  }
  return lookup(verification);
}

/** Throwing form for routers that use exceptions at their binding boundary. */
export async function assertAuthenticatedTarget<Envelope extends TargetedOperation>(
  input: AuthenticatedOperation<Envelope> | Envelope,
  authenticator: BindingAuthenticator,
  target: VerificationTarget,
): Promise<AuthorizedTarget<Envelope>> {
  const result = await verifyAuthenticatedTarget(input, authenticator, target);
  if (!result.ok) {
    throw new TargetAuthorizationError(result.error);
  }
  return result;
}

/** Presence-only registry keyed by the exact runtime identity. */
export class AgentCardRegistry {
  public readonly roomId: RoomId;
  public readonly identity: SessionRuntimeIdentity | undefined;
  public readonly runtimeId: RuntimeId | undefined;
  public readonly leaseTtlMs: number;
  public readonly leaseRenewalIntervalMs: number;

  private readonly now: LeaseClock;
  private readonly scheduler: LeaseScheduler | undefined;
  private readonly records = new Map<RuntimeId, StoredRuntimeAdvertisement>();

  public constructor(options: AgentCardRegistryOptions);
  public constructor(
    room: Pick<RoomIdentity, 'roomId'> | RoomId,
    runtimeId?: RuntimeId,
    options?: Omit<
      AgentCardRegistryOptions,
      'roomIdentity' | 'room' | 'roomId' | 'runtimeId' | 'runtimeInstanceId'
    >,
  );
  public constructor(
    optionsOrRoom: AgentCardRegistryOptions | Pick<RoomIdentity, 'roomId'> | RoomId,
    runtimeId?: RuntimeId,
    constructionOptions: Omit<
      AgentCardRegistryOptions,
      'roomIdentity' | 'room' | 'roomId' | 'runtimeId' | 'runtimeInstanceId'
    > = {},
  ) {
    const options: AgentCardRegistryOptions =
      typeof optionsOrRoom === 'string'
        ? {
            ...constructionOptions,
            roomId: optionsOrRoom,
            ...(runtimeId === undefined ? {} : { runtimeId }),
          }
        : runtimeId === undefined
          ? (optionsOrRoom as AgentCardRegistryOptions)
          : {
              ...constructionOptions,
              roomIdentity: optionsOrRoom as Pick<RoomIdentity, 'roomId'>,
              runtimeId,
            };
    this.roomId = resolveRoom(options);
    this.identity = resolveIdentity(options);
    this.runtimeId =
      this.identity?.runtimeId ??
      (options.runtimeId === undefined
        ? options.runtimeInstanceId
        : runtimeValue(options.runtimeId, 'runtimeId'));
    this.leaseTtlMs = resolveDuration(options.leaseTtlMs, DEFAULT_LEASE_TTL_MS, 'leaseTtlMs');
    this.leaseRenewalIntervalMs = resolveDuration(
      options.leaseRenewalIntervalMs,
      DEFAULT_LEASE_RENEWAL_INTERVAL_MS,
      'leaseRenewalIntervalMs',
    );
    this.now = options.now ?? Date.now;
    this.scheduler = options.scheduler;
  }

  /** Publish one complete metadata-only card and its current routing endpoint. */
  public register(publication: AgentCardPublication | AgentCard): RuntimeAdvertisement;
  public register(
    card: AgentCard,
    endpoint: RoutingEndpoint,
    options?: Omit<AgentCardPublication, 'card' | 'endpoint'>,
  ): RuntimeAdvertisement;
  public register(
    publicationOrCard: AgentCardPublication | AgentCard,
    endpoint?: RoutingEndpoint,
    options: Omit<AgentCardPublication, 'card' | 'endpoint'> = {},
  ): RuntimeAdvertisement {
    const publication =
      endpoint === undefined
        ? extractPublication(publicationOrCard)
        : extractPublication({ ...options, card: publicationOrCard as AgentCard, endpoint });
    const parts = this.validatePublication(publication);
    const now = this.clock();
    const ttlMs = resolveDuration(parts.leaseTtlMs, this.leaseTtlMs, 'leaseTtlMs');
    const expiresAtMs =
      parts.leaseExpiresAt === undefined
        ? now + ttlMs
        : parseExpiry(parts.leaseExpiresAt, 'leaseExpiresAt');
    if (expiresAtMs <= now) {
      throw new AgentCardRegistryError('expired', 'Agent Card lease has expired');
    }

    const identity = Object.freeze({
      sessionId: parts.card.sessionId,
      runtimeId: parts.card.runtimeId,
    });
    const existing = this.records.get(identity.runtimeId);
    if (existing !== undefined) {
      if (existing.record.sessionId !== identity.sessionId) {
        throw new AgentCardRegistryConflictError('runtime ID is bound to another session identity');
      }
      if (!isLive(existing, now)) {
        throw new AgentCardRegistryError(
          'expired',
          'an expired runtime cannot be revived; register a replacement runtime identity',
        );
      }
    }

    const endpointCopy = cloneEndpoint(parts.endpoint, identity.runtimeId);
    const baseCard = cloneCard(parts.card, identity);
    const leaseExpiry = isoTimestamp(expiresAtMs);
    const card = cardWithDiscoveryFields(baseCard, this.roomId, endpointCopy, leaseExpiry);
    const lease = leaseSnapshot(
      identity,
      endpointCopy,
      existing?.record.lease.issuedAt ?? now,
      expiresAtMs,
      ttlMs,
      this.leaseRenewalIntervalMs,
    );
    const record = makeRuntimeAdvertisement(identity, this.roomId, card, endpointCopy, lease);
    this.records.set(identity.runtimeId, { record, expiresAtMs, ttlMs });
    return record;
  }

  public publish(publication: AgentCardPublication | AgentCard): RuntimeAdvertisement;
  public publish(
    card: AgentCard,
    endpoint: RoutingEndpoint,
    options?: Omit<AgentCardPublication, 'card' | 'endpoint'>,
  ): RuntimeAdvertisement;
  public publish(
    publicationOrCard: AgentCardPublication | AgentCard,
    endpoint?: RoutingEndpoint,
    options: Omit<AgentCardPublication, 'card' | 'endpoint'> = {},
  ): RuntimeAdvertisement {
    return endpoint === undefined
      ? this.register(publicationOrCard)
      : this.register(publicationOrCard as AgentCard, endpoint, options);
  }

  public registerRuntime(publication: AgentCardPublication | AgentCard): RuntimeAdvertisement {
    return this.register(publication);
  }

  public publishRuntime(publication: AgentCardPublication | AgentCard): RuntimeAdvertisement {
    return this.publish(publication);
  }
  /** Renew only an existing, still-live runtime identity. */
  public renew(
    owner: RuntimeId | SessionRuntimeIdentity,
    publication?: AgentCardPublication | AgentCard,
    options: RegistryRenewalOptions = {},
  ): RuntimeAdvertisement {
    const runtimeId = typeof owner === 'string' ? owner : owner.runtimeId;
    const existing = this.records.get(runtimeId);
    if (existing === undefined) {
      throw new AgentCardRegistryError('not_found', 'runtime advertisement is not registered');
    }
    if (!isLive(existing, this.clock())) {
      throw new AgentCardRegistryError('expired', 'runtime advertisement lease has expired');
    }
    if (typeof owner !== 'string' && owner.sessionId !== existing.record.sessionId) {
      throw new AgentCardRegistryAuthorizationError();
    }

    const source = publication ?? publicationWithoutLeaseFields(existing.record);
    const parsed =
      options.endpoint !== undefined
        ? 'card' in (source as object)
          ? { ...extractPublication(source as AgentCardPublication), endpoint: options.endpoint }
          : { card: source as AgentCard, roomId: this.roomId, endpoint: options.endpoint }
        : 'card' in (source as object)
          ? extractPublication(source as AgentCardPublication)
          : extractPublication(source as AgentCard);
    if (
      parsed.card.runtimeId !== runtimeId ||
      parsed.card.sessionId !== existing.record.sessionId
    ) {
      throw new AgentCardRegistryAuthorizationError();
    }
    const ttlMs = resolveDuration(options.ttlMs, existing.ttlMs, 'leaseTtlMs');
    const renewed = this.register({
      ...parsed,
      leaseTtlMs: ttlMs,
      leaseExpiresAt: isoTimestamp(resolveNow(options.now, this.now) + ttlMs),
    });
    return renewed;
  }

  public renewRuntime(
    owner: RuntimeId | SessionRuntimeIdentity,
    publication?: AgentCardPublication | AgentCard,
    options: RegistryRenewalOptions = {},
  ): RuntimeAdvertisement {
    return this.renew(owner, publication, options);
  }

  public updateEndpoint(
    owner: RuntimeId | SessionRuntimeIdentity,
    endpoint: RoutingEndpoint,
    options: Omit<RegistryRenewalOptions, 'endpoint'> = {},
  ): RuntimeAdvertisement {
    return this.renew(owner, undefined, { ...options, endpoint });
  }
  /** Remove only an exact runtime record; an old runtime cannot remove its replacement. */
  public unregister(owner: RuntimeId | SessionRuntimeIdentity): boolean {
    const runtimeId = typeof owner === 'string' ? owner : owner.runtimeId;
    const existing = this.records.get(runtimeId);
    if (existing === undefined) {
      return false;
    }
    if (typeof owner !== 'string' && owner.sessionId !== existing.record.sessionId) {
      return false;
    }
    this.records.delete(runtimeId);
    return true;
  }

  public remove(owner?: RuntimeId | SessionRuntimeIdentity): boolean {
    const resolvedOwner = owner ?? this.runtimeId;
    return resolvedOwner === undefined ? false : this.unregister(resolvedOwner);
  }

  public removeRuntime(owner?: RuntimeId | SessionRuntimeIdentity): boolean {
    return this.remove(owner);
  }

  /** Return one live record without exposing expired presence. */
  public get(
    runtimeId: RuntimeId,
    options: RegistryListOptions = {},
  ): RuntimeAdvertisement | undefined {
    const record = this.records.get(runtimeId);
    if (record === undefined || !isLive(record, resolveNow(options.now, this.now))) {
      return undefined;
    }
    return record.record;
  }

  public lookup(
    runtimeId: RuntimeId,
    options: RegistryListOptions = {},
  ): RuntimeAdvertisement | undefined {
    return this.get(runtimeId, options);
  }

  /** List only live advertisements in this exact room. */
  public list(options: RegistryListOptions = {}): RuntimeAdvertisement[] {
    const now = resolveNow(options.now, this.now);
    return [...this.records.values()]
      .filter((record) => isLive(record, now) && record.record.roomId === this.roomId)
      .map((record) => record.record)
      .sort((left, right) => left.runtimeId.localeCompare(right.runtimeId));
  }

  public discover(options: RegistryListOptions = {}): RuntimeAdvertisement[] {
    return this.list(options);
  }

  public listRuntimes(options: RegistryListOptions = {}): RuntimeAdvertisement[] {
    return this.list(options);
  }

  public has(runtimeId: RuntimeId, options: RegistryListOptions = {}): boolean {
    return this.get(runtimeId, options) !== undefined;
  }

  /** Return the current endpoint only while the runtime's lease is live. */
  public currentEndpoint(runtimeId = this.runtimeId): RoutingEndpoint | undefined {
    return runtimeId === undefined ? undefined : this.get(runtimeId)?.endpoint;
  }

  public endpointFor(runtimeId: RuntimeId): RoutingEndpoint | undefined {
    return this.currentEndpoint(runtimeId);
  }

  /** Remove records only after expiry plus two TTLs. */
  public cleanup(options: RegistryCleanupOptions = {}): number {
    const now = resolveNow(options.now, this.now);
    const ttlMs = resolveDuration(options.ttlMs, this.leaseTtlMs, 'ttlMs');
    let removed = 0;
    for (const [runtimeId, record] of this.records) {
      if (now >= record.expiresAtMs + 2 * ttlMs) {
        // Re-read the current map entry immediately before deletion.  A
        // synchronous renew/register cannot race this line, and an async
        // adapter must perform its own ownership check before calling here.
        const current = this.records.get(runtimeId);
        if (current === record && now >= current.expiresAtMs + 2 * ttlMs) {
          this.records.delete(runtimeId);
          removed += 1;
        }
      }
    }
    return removed;
  }

  public cleanupStaleRecords(options: RegistryCleanupOptions = {}): number {
    return this.cleanup(options);
  }

  /** Create an owner lease that publishes/renews only the source runtime. */
  public createLease(source: AgentCardSource, options: RegistryLeaseOptions = {}): SerializedLease {
    let owner: SessionRuntimeIdentity | undefined;
    if (typeof source !== 'function') {
      const parts = extractPublication(source);
      owner = Object.freeze({ sessionId: parts.card.sessionId, runtimeId: parts.card.runtimeId });
    }
    const resolveSource = async (): Promise<AgentCardPublication | AgentCard> =>
      typeof source === 'function' ? await source() : source;
    const renewal = async (): Promise<LeaseRenewalResult> => {
      const publication = await resolveSource();
      const parts =
        'card' in (publication as object)
          ? extractPublication(publication as AgentCardPublication)
          : extractPublication(publication as AgentCard);
      owner ??= Object.freeze({ sessionId: parts.card.sessionId, runtimeId: parts.card.runtimeId });
      const record =
        this.get(owner.runtimeId) === undefined
          ? this.register(publication)
          : this.renew(owner, publication, { ttlMs: options.ttlMs });
      return { endpoint: record.endpoint, identity: owner };
    };
    return new SerializedLeaseImplementation({
      ...options,
      identity: owner,
      ttlMs: options.ttlMs ?? this.leaseTtlMs,
      renewalIntervalMs: options.renewalIntervalMs ?? this.leaseRenewalIntervalMs,
      scheduler: options.scheduler ?? this.scheduler,
      now: options.now ?? this.now,
      renew: renewal,
    });
  }

  public async startLease(
    source: AgentCardSource,
    options: RegistryLeaseOptions = {},
  ): Promise<SerializedLease> {
    const lease = this.createLease(source, options);
    await lease.start();
    return lease;
  }

  /** Verify an inbound operation against this registry's local room/runtime. */
  public verifyAuthenticatedTarget<Envelope extends TargetedOperation>(
    input: AuthenticatedOperation<Envelope> | Envelope,
    authenticator: BindingAuthenticator,
  ): Promise<TargetVerificationResult<Envelope>> {
    if (this.runtimeId === undefined) {
      return Promise.resolve(unauthorizedResult());
    }
    return verifyAuthenticatedTarget(input, authenticator, {
      runtimeId: this.runtimeId,
      roomId: this.roomId,
    });
  }

  public verifyAuthenticatedSender<Envelope extends TargetedOperation>(
    input: AuthenticatedOperation<Envelope> | Envelope,
    authenticator: BindingAuthenticator,
  ): Promise<TargetVerificationResult<Envelope>> {
    return this.verifyAuthenticatedTarget(input, authenticator);
  }

  public verifyInboundTarget<Envelope extends TargetedOperation>(
    input: AuthenticatedOperation<Envelope> | Envelope,
    authenticator: BindingAuthenticator,
  ): Promise<TargetVerificationResult<Envelope>> {
    return this.verifyAuthenticatedTarget(input, authenticator);
  }

  public authorizeBeforeLookup<Envelope extends TargetedOperation, Result>(
    input: AuthenticatedOperation<Envelope> | Envelope,
    authenticator: BindingAuthenticator,
    lookup: (authorized: AuthorizedTarget<Envelope>) => Result | PromiseLike<Result>,
  ): Promise<TargetVerificationFailure | Result> {
    if (this.runtimeId === undefined) {
      return Promise.resolve(unauthorizedResult());
    }
    return authorizeBeforeLookup(
      input,
      authenticator,
      {
        runtimeId: this.runtimeId,
        roomId: this.roomId,
      },
      lookup,
    );
  }

  private validatePublication(publication: PublicationParts): PublicationParts {
    const roomId =
      publication.roomId === undefined ? this.roomId : roomValue(publication.roomId, 'roomId');
    if (roomId !== this.roomId) {
      throw new AgentCardRegistryError(
        'cross_room',
        'Agent Card room does not match the local room',
      );
    }
    const card = cloneCard(publication.card);
    const endpoint = cloneEndpoint(publication.endpoint, card.runtimeId);
    return {
      card,
      roomId,
      endpoint,
      ...(publication.leaseExpiresAt === undefined
        ? {}
        : { leaseExpiresAt: publication.leaseExpiresAt }),
      ...(publication.leaseTtlMs === undefined ? {} : { leaseTtlMs: publication.leaseTtlMs }),
    };
  }

  private clock(): number {
    return resolveNow(undefined, this.now);
  }
}

function makeRuntimeAdvertisement(
  identity: SessionRuntimeIdentity,
  roomId: RoomId,
  card: AdvertisedAgentCard,
  endpoint: RoutingEndpoint,
  lease: LeaseSnapshot,
): RuntimeAdvertisement {
  const record = {
    identity,
    sessionId: identity.sessionId,
    runtimeId: identity.runtimeId,
    roomId,
    card,
    agentCard: card,
    endpoint,
    lease,
    leaseExpiresAt: card.leaseExpiresAt,
    supportedProtocolVersions: card.supportedProtocolVersions,
    operations: card.operations,
    contentCapabilities: card.contentCapabilities,
    capabilities: card.capabilities,
    limits: card.limits,
  };
  return Object.freeze(record);
}

/** Short aliases used by discovery callers. */
export class Registry extends AgentCardRegistry {}
export class AgentRegistry extends AgentCardRegistry {}
export class DiscoveryRegistry extends AgentCardRegistry {}

export const createAgentCardRegistry = (options: AgentCardRegistryOptions): AgentCardRegistry =>
  new AgentCardRegistry(options);
export const createRegistry = createAgentCardRegistry;
export const createDiscoveryRegistry = createAgentCardRegistry;

export function publishAgentCard(
  registryOrOptions: AgentCardRegistry | AgentCardRegistryOptions,
  publication: AgentCardPublication | AgentCard,
): RuntimeAdvertisement {
  const registry =
    registryOrOptions instanceof AgentCardRegistry
      ? registryOrOptions
      : new AgentCardRegistry(registryOrOptions);
  return registry.publish(publication);
}

export const publishAdvertisement = publishAgentCard;
export const publishCard = publishAgentCard;

export function listAgentCards(
  registryOrOptions: AgentCardRegistry | AgentCardRegistryOptions,
  options: RegistryListOptions = {},
): RuntimeAdvertisement[] {
  const registry =
    registryOrOptions instanceof AgentCardRegistry
      ? registryOrOptions
      : new AgentCardRegistry(registryOrOptions);
  return registry.list(options);
}

export const discoverAgentCards = listAgentCards;
export const discoverAdvertisements = listAgentCards;
export const listCards = listAgentCards;

export function cleanupStaleAgentCards(
  registryOrOptions: AgentCardRegistry | AgentCardRegistryOptions,
  options: RegistryCleanupOptions = {},
): number {
  const registry =
    registryOrOptions instanceof AgentCardRegistry
      ? registryOrOptions
      : new AgentCardRegistry(registryOrOptions);
  return registry.cleanup(options);
}

export const cleanupExpiredAgentCards = cleanupStaleAgentCards;
export const cleanupExpiredRecords = cleanupStaleAgentCards;

/** A small runtime guard for callers that receive an arbitrary protocol value. */
export function isProtocolEnvelope(value: unknown): value is ProtocolEnvelope {
  return (
    isTargetedOperation(value) && typeof (value as { operation?: unknown }).operation === 'string'
  );
}
