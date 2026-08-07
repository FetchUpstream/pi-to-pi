/**
 * Discovery advertisements and authenticated targeting contracts.
 *
 * The registry is intentionally presence-only.  It stores runtime identity,
 * Agent Card capabilities/limits, a current opaque routing endpoint, and lease
 * metadata.  It does not store binding credentials, application content,
 * fingerprints, task state, or deduplication records.
 */

import { DEFAULT_PROTOCOL_LIMITS } from '../config.js';
import {
  isSessionRuntimeIdentity,
  isUuidV4,
  runtimeIdentitiesEqual,
  type SessionRuntimeIdentity,
} from '../identity.js';
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
import { isRoomId, roomStorageKey, roomsEqual, type RoomIdentity } from '../room.js';
import { validateEnvelope, validateOperationResponse } from '../protocol/validation.js';
import {
  DEFAULT_LEASE_RENEWAL_INTERVAL_MS,
  DEFAULT_LEASE_TTL_MS,
  Lease,
  LeaseExpiredError,
  LeaseStoppedError,
  type LeaseClock,
  type LeaseExpiryOptions,
  type LeaseRenewalResult,
  type LeaseScheduler,
  type LeaseSnapshot,
  type RoutingEndpoint,
  type RoutingEndpointDescriptor,
  type SerializedLease,
  type SerializedLeaseOptions,
} from './lease.js';
import { SerializedLease as SerializedLeaseImplementation } from './lease.js';

export { DEFAULT_LEASE_RENEWAL_INTERVAL_MS, DEFAULT_LEASE_TTL_MS, Lease };
export type {
  CurrentRoutingEndpoint,
  EndpointDescriptor,
  LeaseClock,
  LeaseEndpointUpdate,
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
  'renew' | 'identity' | 'endpoint' | 'ttlMs' | 'renewalIntervalMs' | 'onEndpointUpdate'
> {
  readonly ttlMs?: number;
  readonly renewalIntervalMs?: number;
}

export type AgentCardSource =
  | AgentCardPublication
  | AgentCard
  | (() => AgentCardPublication | AgentCard | PromiseLike<AgentCardPublication | AgentCard>);

export type RegistryErrorCode =
  'malformed' | 'expired' | 'cross_room' | 'duplicate' | 'unauthorized' | 'not_found' | 'busy';

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

export type TargetedOperation = Pick<ProtocolEnvelope, 'sender' | 'recipientRuntimeId' | 'roomId'>;

const AUTHENTICATED_OPERATION_BRAND: unique symbol = Symbol('authenticated-operation');
const trustedAuthenticatedOperations = new WeakSet<object>();

/** Options for constructing a binding-authenticated operation. */
export interface AuthenticatedOperationOptions {
  /** Original request deadline used to validate a message.reply when known. */
  readonly expectedRequestExpiresAt?: string | number | Date;
}
/** A validated protocol envelope plus binding-only metadata kept outside application data. */
export interface AuthenticatedOperation<Envelope extends ProtocolEnvelope = ProtocolEnvelope> {
  readonly envelope: Envelope;
  readonly bindingMetadata?: BindingMetadata;
  /** Alias accepted at the binding boundary; never retained in a registry record. */
  readonly metadata?: BindingMetadata;
  /** Out-of-band deadline context; never serialized as part of the envelope. */
  readonly expectedRequestExpiresAt?: string | number;
  readonly [AUTHENTICATED_OPERATION_BRAND]: true;
}

const DEFERRED_REPLY_REQUEST_DEADLINE = '9999-12-31T23:59:59.999Z';
type AuthenticatedRequestDeadline = string | number;

function snapshotExpectedRequestExpiresAt(
  value: string | number | Date | undefined,
): AuthenticatedRequestDeadline | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value === 'string' || typeof value === 'number') {
    return value;
  }
  const milliseconds = dateMilliseconds(value);
  if (milliseconds === undefined) {
    throw new AgentCardRegistryError(
      'malformed',
      'expectedRequestExpiresAt must be a finite timestamp',
    );
  }
  return isoTimestamp(milliseconds);
}

function validationExpectedRequestExpiresAt(
  value: unknown,
  expectedRequestExpiresAt: string | number | Date | undefined,
): AuthenticatedRequestDeadline | undefined {
  if (expectedRequestExpiresAt !== undefined) {
    return snapshotExpectedRequestExpiresAt(expectedRequestExpiresAt);
  }
  return inboundProperty(value, 'operation') === 'message.reply'
    ? DEFERRED_REPLY_REQUEST_DEADLINE
    : undefined;
}

/** Construct the only wrapper form accepted as a binding-authenticated input. */
export function createAuthenticatedOperation<Envelope extends ProtocolEnvelope>(
  envelope: Envelope,
  bindingMetadata?: BindingMetadata,
  options: AuthenticatedOperationOptions = {},
): AuthenticatedOperation<Envelope> {
  const validationView = createCanonicalEnvelopeValidationView(envelope);
  const expectedRequestExpiresAt = snapshotExpectedRequestExpiresAt(
    options.expectedRequestExpiresAt,
  );
  const validatedEnvelope = validateAuthenticatedEnvelope(validationView, expectedRequestExpiresAt);
  if (bindingMetadata !== undefined && !isRecord(bindingMetadata)) {
    throw new AgentCardRegistryError('malformed', 'binding metadata must be an object');
  }
  const envelopeSnapshot = cloneFrozenSnapshot(validatedEnvelope);
  const metadataSnapshot =
    bindingMetadata === undefined ? undefined : cloneFrozenSnapshot(bindingMetadata);
  const wrapper = Object.freeze({
    [AUTHENTICATED_OPERATION_BRAND]: true as const,
    envelope: envelopeSnapshot as Envelope,
    ...(metadataSnapshot === undefined ? {} : { bindingMetadata: metadataSnapshot }),
    ...(expectedRequestExpiresAt === undefined ? {} : { expectedRequestExpiresAt }),
  });
  trustedAuthenticatedOperations.add(wrapper);
  return wrapper as AuthenticatedOperation<Envelope>;
}

export type InboundOperation<Envelope extends ProtocolEnvelope = ProtocolEnvelope> =
  AuthenticatedOperation<Envelope>;

export interface AuthorizedTarget<Envelope extends ProtocolEnvelope = ProtocolEnvelope> {
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

export type TargetVerificationResult<Envelope extends ProtocolEnvelope = ProtocolEnvelope> =
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
  readonly owner: SessionRuntimeIdentity;
  readonly expiresAtMs: number;
  readonly ttlMs: number;
  readonly generation: number;
}

interface RetiredRuntimeIdentity {
  readonly owner: SessionRuntimeIdentity;
  readonly generation: number;
  readonly retiredAtMs: number;
}

interface PublicationParts {
  readonly card: AgentCard;
  readonly roomId?: RoomId;
  readonly endpoint: RoutingEndpoint;
  readonly leaseExpiresAt?: string | number | Date;
  readonly leaseTtlMs?: number;
}

const MAX_ENDPOINT_LENGTH = 16_384;
const MAX_ENDPOINT_KEYS = 4;
const MAX_ENDPOINT_BYTES = 64 * 1024;
const MAX_RETIRED_RUNTIME_IDENTITIES = 1_024;
const RETIRED_RUNTIME_GRACE_MS = 10 * 60 * 1000;
const MAX_NAME_LENGTH = 256;
const MAX_DESCRIPTION_LENGTH = 1_024;
const MAX_SUPPORTED_PROTOCOL_VERSIONS = 1;
const MAX_OPERATION_CAPABILITIES = OPERATION_NAMES.length;
const MAX_CONTENT_CAPABILITIES = 2;
const CANONICAL_CARD_VALIDATION_OPERATION_ID = '00000000-0000-4000-8000-000000000000';
const CANONICAL_CARD_VALIDATION_TRACE_ID = '00000000000000000000000000000000';
const CONTROL_CHARACTER_PATTERN = /\p{C}/u;
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
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  try {
    return !Array.isArray(value);
  } catch {
    return false;
  }
}

function validateAuthenticatedEnvelope(
  value: unknown,
  expectedRequestExpiresAt?: string | number | Date,
): ProtocolEnvelope {
  const validationDeadline = validationExpectedRequestExpiresAt(value, expectedRequestExpiresAt);
  let result: ReturnType<typeof validateEnvelope>;
  try {
    result = validateEnvelope(value, {
      maxEnvelopeBytes: DEFAULT_PROTOCOL_LIMITS.maxEnvelopeBytes,
      ...(validationDeadline === undefined ? {} : { expectedRequestExpiresAt: validationDeadline }),
    });
  } catch {
    throw new AgentCardRegistryError('malformed', 'authenticated envelope is invalid');
  }
  if (!result.ok) {
    const code = result.error.code === 'expired' ? 'expired' : 'malformed';
    throw new AgentCardRegistryError(
      code,
      `authenticated envelope is invalid: ${result.error.message}`,
    );
  }
  return result.value;
}
const MAX_AUTHENTICATED_SNAPSHOT_DEPTH = 128;
const MAX_AUTHENTICATED_SNAPSHOT_NODES = DEFAULT_PROTOCOL_LIMITS.maxEnvelopeBytes;
const MAX_AUTHENTICATED_SNAPSHOT_KEYS = DEFAULT_PROTOCOL_LIMITS.maxEnvelopeBytes;
const MAX_AUTHENTICATED_SNAPSHOT_BYTES = DEFAULT_PROTOCOL_LIMITS.maxEnvelopeBytes;

interface AuthenticatedSnapshotBudget {
  nodes: number;
  keys: number;
  bytes: number;
}

function authenticatedSnapshotError(message: string): never {
  throw new AgentCardRegistryError('malformed', message);
}
interface CanonicalEnvelopeValidationBudget {
  nodes: number;
  keys: number;
  bytes: number;
}

const MAX_CANONICAL_ENVELOPE_VALIDATION_DEPTH = 128;
const MAX_CANONICAL_ENVELOPE_VALIDATION_NODES = DEFAULT_PROTOCOL_LIMITS.maxEnvelopeBytes;
const MAX_CANONICAL_ENVELOPE_VALIDATION_KEYS = DEFAULT_PROTOCOL_LIMITS.maxEnvelopeBytes;
const MAX_CANONICAL_ENVELOPE_VALIDATION_BYTES = DEFAULT_PROTOCOL_LIMITS.maxEnvelopeBytes;
const INVALID_CANONICAL_ENVELOPE_VALUE = Symbol('invalid-canonical-envelope-value');

function canonicalEnvelopeValidationError(message: string): never {
  throw new AgentCardRegistryError('malformed', message);
}

function safeCanonicalDescriptor(value: object, key: string): PropertyDescriptor | undefined {
  try {
    return Object.getOwnPropertyDescriptor(value, key);
  } catch {
    canonicalEnvelopeValidationError('authenticated envelope cannot be inspected safely');
  }
}

function safeCanonicalKeys(value: object): string[] {
  try {
    return Object.keys(value);
  } catch {
    canonicalEnvelopeValidationError('authenticated envelope cannot be inspected safely');
  }
}

function safeCanonicalPrototype(value: object): object | null {
  try {
    return Object.getPrototypeOf(value);
  } catch {
    canonicalEnvelopeValidationError('authenticated envelope cannot be inspected safely');
  }
}

function safeCanonicalIsArray(value: object): boolean {
  try {
    return Array.isArray(value);
  } catch {
    canonicalEnvelopeValidationError('authenticated envelope cannot be inspected safely');
  }
}

function addCanonicalEnvelopeValidationBytes(
  budget: CanonicalEnvelopeValidationBudget,
  bytes: number,
): void {
  if (
    !Number.isSafeInteger(bytes) ||
    bytes < 0 ||
    budget.bytes > MAX_CANONICAL_ENVELOPE_VALIDATION_BYTES - bytes
  ) {
    canonicalEnvelopeValidationError('authenticated envelope exceeds its validation budget');
  }
  budget.bytes += bytes;
}

function createCanonicalEnvelopeValidationView(
  value: unknown,
  budget: CanonicalEnvelopeValidationBudget = { nodes: 0, keys: 0, bytes: 0 },
  depth = 0,
  active = new Set<object>(),
): unknown {
  if (depth > MAX_CANONICAL_ENVELOPE_VALIDATION_DEPTH) {
    canonicalEnvelopeValidationError('authenticated envelope exceeds its depth budget');
  }
  budget.nodes += 1;
  if (budget.nodes > MAX_CANONICAL_ENVELOPE_VALIDATION_NODES) {
    canonicalEnvelopeValidationError('authenticated envelope exceeds its node budget');
  }
  if (value === null || value === undefined) {
    return value;
  }
  if (typeof value === 'string') {
    addCanonicalEnvelopeValidationBytes(budget, Buffer.byteLength(value, 'utf8') + 2);
    return value;
  }
  if (typeof value === 'number') {
    addCanonicalEnvelopeValidationBytes(budget, 16);
    return value;
  }
  if (typeof value === 'boolean') {
    addCanonicalEnvelopeValidationBytes(budget, value ? 4 : 5);
    return value;
  }
  if (typeof value !== 'object') {
    return value;
  }
  if (active.has(value)) {
    canonicalEnvelopeValidationError('authenticated envelope cannot contain cycles');
  }
  if (safeCanonicalIsArray(value)) {
    const lengthDescriptor = safeCanonicalDescriptor(value, 'length');
    const length =
      lengthDescriptor !== undefined && 'value' in lengthDescriptor
        ? lengthDescriptor.value
        : undefined;
    if (
      !Number.isSafeInteger(length) ||
      length < 0 ||
      length > MAX_CANONICAL_ENVELOPE_VALIDATION_KEYS
    ) {
      canonicalEnvelopeValidationError('authenticated envelope array exceeds its key budget');
    }
    active.add(value);
    try {
      const copy = new Array(length);
      addCanonicalEnvelopeValidationBytes(budget, 2);
      for (let index = 0; index < length; index += 1) {
        budget.keys += 1;
        if (budget.keys > MAX_CANONICAL_ENVELOPE_VALIDATION_KEYS) {
          canonicalEnvelopeValidationError('authenticated envelope exceeds its key budget');
        }
        const descriptor = safeCanonicalDescriptor(value, String(index));
        if (descriptor === undefined) {
          continue;
        }
        if (!('value' in descriptor) || !descriptor.enumerable) {
          canonicalEnvelopeValidationError(
            'authenticated envelope cannot contain accessors or hidden data',
          );
        }
        copy[index] = createCanonicalEnvelopeValidationView(
          descriptor.value,
          budget,
          depth + 1,
          active,
        );
      }
      const keys = safeCanonicalKeys(value);
      if (keys.length > MAX_CANONICAL_ENVELOPE_VALIDATION_KEYS) {
        canonicalEnvelopeValidationError('authenticated envelope exceeds its key budget');
      }
      for (const key of keys) {
        const numericKey = Number(key);
        if (
          !Number.isSafeInteger(numericKey) ||
          numericKey < 0 ||
          String(numericKey) !== key ||
          numericKey >= length
        ) {
          canonicalEnvelopeValidationError(
            'authenticated envelope arrays cannot contain extra fields',
          );
        }
      }
      return copy;
    } finally {
      active.delete(value);
    }
  }
  const prototype = safeCanonicalPrototype(value);
  if (prototype !== Object.prototype && prototype !== null) {
    return INVALID_CANONICAL_ENVELOPE_VALUE;
  }
  active.add(value);
  try {
    const keys = safeCanonicalKeys(value);
    if (keys.length > MAX_CANONICAL_ENVELOPE_VALIDATION_KEYS) {
      canonicalEnvelopeValidationError('authenticated envelope exceeds its key budget');
    }
    const copy = Object.create(null) as Record<string, unknown>;
    addCanonicalEnvelopeValidationBytes(budget, 2);
    for (const key of keys) {
      budget.keys += 1;
      if (budget.keys > MAX_CANONICAL_ENVELOPE_VALIDATION_KEYS) {
        canonicalEnvelopeValidationError('authenticated envelope exceeds its key budget');
      }
      const descriptor = safeCanonicalDescriptor(value, key);
      if (descriptor === undefined || !('value' in descriptor) || !descriptor.enumerable) {
        canonicalEnvelopeValidationError(
          'authenticated envelope cannot contain accessors or hidden data',
        );
      }
      addCanonicalEnvelopeValidationBytes(budget, Buffer.byteLength(key, 'utf8') + 3);
      copy[key] = createCanonicalEnvelopeValidationView(
        descriptor.value,
        budget,
        depth + 1,
        active,
      );
    }
    return copy;
  } finally {
    active.delete(value);
  }
}

function addSnapshotBytes(budget: AuthenticatedSnapshotBudget, bytes: number): void {
  if (
    !Number.isSafeInteger(bytes) ||
    bytes < 0 ||
    budget.bytes > MAX_AUTHENTICATED_SNAPSHOT_BYTES - bytes
  ) {
    authenticatedSnapshotError('authenticated snapshot exceeds its byte budget');
  }
  budget.bytes += bytes;
}

function snapshotJsonBytes(value: unknown): number {
  if (typeof value === 'string') {
    if (Buffer.byteLength(value, 'utf8') > MAX_AUTHENTICATED_SNAPSHOT_BYTES) {
      authenticatedSnapshotError('authenticated snapshot exceeds its byte budget');
    }
  }
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch {
    authenticatedSnapshotError('authenticated snapshot contains an unserializable value');
  }
  if (serialized === undefined) {
    authenticatedSnapshotError('authenticated snapshot contains an unserializable value');
  }
  return Buffer.byteLength(serialized, 'utf8');
}

/** Clone and recursively freeze bounded canonical data at the binding boundary. */
function safeSnapshotDescriptor(value: object, key: string): PropertyDescriptor | undefined {
  try {
    return Object.getOwnPropertyDescriptor(value, key);
  } catch {
    authenticatedSnapshotError('authenticated snapshot cannot be inspected safely');
  }
}

function safeSnapshotKeys(value: object): string[] {
  try {
    return Object.keys(value);
  } catch {
    authenticatedSnapshotError('authenticated snapshot cannot be inspected safely');
  }
}

function safeSnapshotPrototype(value: object): object | null {
  try {
    return Object.getPrototypeOf(value);
  } catch {
    authenticatedSnapshotError('authenticated snapshot cannot be inspected safely');
  }
}

function safeSnapshotIsArray(value: object): boolean {
  try {
    return Array.isArray(value);
  } catch {
    authenticatedSnapshotError('authenticated snapshot cannot be inspected safely');
  }
}

/** Clone and recursively freeze bounded canonical data at the binding boundary. */
function cloneFrozenSnapshot<T>(
  value: T,
  budget: AuthenticatedSnapshotBudget = { nodes: 0, keys: 0, bytes: 0 },
  depth = 0,
  active = new Set<object>(),
): T {
  if (depth > MAX_AUTHENTICATED_SNAPSHOT_DEPTH) {
    authenticatedSnapshotError('authenticated snapshot exceeds its depth budget');
  }
  budget.nodes += 1;
  if (budget.nodes > MAX_AUTHENTICATED_SNAPSHOT_NODES) {
    authenticatedSnapshotError('authenticated snapshot exceeds its node budget');
  }
  if (value === null) {
    addSnapshotBytes(budget, 4);
    return value;
  }
  if (value === undefined) {
    return value;
  }
  if (typeof value === 'string') {
    addSnapshotBytes(budget, snapshotJsonBytes(value));
    return value;
  }
  if (typeof value === 'boolean') {
    addSnapshotBytes(budget, value ? 4 : 5);
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      authenticatedSnapshotError('authenticated snapshot contains a non-finite number');
    }
    addSnapshotBytes(budget, snapshotJsonBytes(value));
    return value;
  }
  if (typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint') {
    authenticatedSnapshotError('authenticated snapshot contains an unsupported value');
  }
  if (typeof value !== 'object') {
    authenticatedSnapshotError('authenticated snapshot contains an unsupported value');
  }
  if (active.has(value)) {
    authenticatedSnapshotError('authenticated snapshot cannot contain cycles');
  }
  active.add(value);
  try {
    if (safeSnapshotIsArray(value)) {
      const lengthDescriptor = safeSnapshotDescriptor(value, 'length');
      const length =
        lengthDescriptor !== undefined && 'value' in lengthDescriptor
          ? lengthDescriptor.value
          : undefined;
      if (!Number.isSafeInteger(length) || length < 0 || length > MAX_AUTHENTICATED_SNAPSHOT_KEYS) {
        authenticatedSnapshotError('authenticated snapshot array exceeds its key budget');
      }
      const copy: unknown[] = [];
      addSnapshotBytes(budget, 2);
      for (let index = 0; index < length; index += 1) {
        budget.keys += 1;
        if (budget.keys > MAX_AUTHENTICATED_SNAPSHOT_KEYS) {
          authenticatedSnapshotError('authenticated snapshot exceeds its key budget');
        }
        if (index > 0) {
          addSnapshotBytes(budget, 1);
        }
        const descriptor = safeSnapshotDescriptor(value, String(index));
        if (descriptor === undefined) {
          addSnapshotBytes(budget, 4);
          copy.push(null);
          continue;
        }
        if (!('value' in descriptor) || !descriptor.enumerable) {
          authenticatedSnapshotError(
            'authenticated snapshot cannot contain accessors or hidden data',
          );
        }
        const child = cloneFrozenSnapshot(descriptor.value, budget, depth + 1, active);
        copy.push(child === undefined ? null : child);
      }
      const keys = safeSnapshotKeys(value);
      if (keys.length > MAX_AUTHENTICATED_SNAPSHOT_KEYS) {
        authenticatedSnapshotError('authenticated snapshot exceeds its key budget');
      }
      for (const key of keys) {
        const numericKey = Number(key);
        if (
          !Number.isSafeInteger(numericKey) ||
          numericKey < 0 ||
          String(numericKey) !== key ||
          numericKey >= length
        ) {
          authenticatedSnapshotError('authenticated snapshot arrays cannot contain extra fields');
        }
      }
      addSnapshotBytes(budget, 1);
      return Object.freeze(copy) as T;
    }
    const prototype = safeSnapshotPrototype(value);
    if (prototype !== Object.prototype && prototype !== null) {
      authenticatedSnapshotError('authenticated snapshot must contain plain objects');
    }
    const copy = Object.create(null) as Record<string, unknown>;
    addSnapshotBytes(budget, 1);
    let first = true;
    const keys = safeSnapshotKeys(value);
    if (keys.length > MAX_AUTHENTICATED_SNAPSHOT_KEYS) {
      authenticatedSnapshotError('authenticated snapshot exceeds its key budget');
    }
    for (const key of keys) {
      budget.keys += 1;
      if (budget.keys > MAX_AUTHENTICATED_SNAPSHOT_KEYS) {
        authenticatedSnapshotError('authenticated snapshot exceeds its key budget');
      }
      const descriptor = safeSnapshotDescriptor(value, key);
      if (descriptor === undefined || !('value' in descriptor) || !descriptor.enumerable) {
        authenticatedSnapshotError(
          'authenticated snapshot cannot contain accessors or hidden data',
        );
      }
      if (!first) {
        addSnapshotBytes(budget, 1);
      }
      first = false;
      addSnapshotBytes(budget, snapshotJsonBytes(key) + 1);
      const child = cloneFrozenSnapshot(descriptor.value, budget, depth + 1, active);
      if (child !== undefined) {
        copy[key] = child;
      }
    }
    addSnapshotBytes(budget, 1);
    return Object.freeze(copy) as T;
  } finally {
    active.delete(value);
  }
}

function nonEmptyText(value: unknown, label: string, maxLength = MAX_NAME_LENGTH): string {
  if (
    typeof value !== 'string' ||
    value.trim().length === 0 ||
    value.length > maxLength ||
    CONTROL_CHARACTER_PATTERN.test(value)
  ) {
    throw new AgentCardRegistryError('malformed', `${label} must be bounded safe text`);
  }
  return value;
}

function roomValue(value: unknown, label: string): RoomId {
  if (!isRoomId(value)) {
    throw new AgentCardRegistryError('malformed', `${label} must be a canonical room identity`);
  }
  return roomStorageKey(value);
}

function runtimeValue(value: unknown, label: string): RuntimeId {
  if (!isUuidV4(value)) {
    throw new AgentCardRegistryError('malformed', `${label} must be a canonical runtime identity`);
  }
  return value;
}

function sessionValue(value: unknown, label: string): SessionId {
  return nonEmptyText(value, label, 512) as SessionId;
}

function isCanonicalIdentity(value: unknown): value is SessionRuntimeIdentity {
  return (
    isSessionRuntimeIdentity(value) && value.sessionId.length <= 512 && isUuidV4(value.runtimeId)
  );
}

function canonicalIdentity(
  sessionId: unknown,
  runtimeId: unknown,
  label: string,
): SessionRuntimeIdentity {
  const candidate = { sessionId, runtimeId };
  if (!isCanonicalIdentity(candidate)) {
    throw new AgentCardRegistryError('malformed', `${label} must be canonical`);
  }
  return Object.freeze({
    sessionId: candidate.sessionId,
    runtimeId: candidate.runtimeId,
  });
}

function resolveRoom(options: AgentCardRegistryOptions): RoomId {
  const aliases = [options.roomIdentity?.roomId, options.room?.roomId, options.roomId].filter(
    (value): value is RoomId => value !== undefined,
  );
  if (aliases.length === 0) {
    throw new AgentCardRegistryError('malformed', 'a canonical room identity is required');
  }
  const roomIds = aliases.map((value) => roomValue(value, 'roomId'));
  if (roomIds.some((value) => value !== roomIds[0])) {
    throw new AgentCardRegistryError('malformed', 'room aliases must agree');
  }
  return roomIds[0];
}

function resolveIdentity(options: AgentCardRegistryOptions): SessionRuntimeIdentity | undefined {
  const runtimeAliases = [
    options.identity?.runtimeId,
    options.runtimeId,
    options.runtimeInstanceId,
  ].filter((value): value is RuntimeId => value !== undefined);
  const sessionAliases = [options.identity?.sessionId, options.sessionId].filter(
    (value): value is SessionId => value !== undefined,
  );
  if (runtimeAliases.length === 0 && sessionAliases.length === 0) {
    return undefined;
  }
  if (runtimeAliases.length === 0) {
    throw new AgentCardRegistryError('malformed', 'runtimeId is required for a local identity');
  }
  const runtimeId = runtimeValue(runtimeAliases[0], 'runtimeId');
  if (runtimeAliases.some((candidate) => candidate !== runtimeId)) {
    throw new AgentCardRegistryError('malformed', 'runtimeId aliases must agree');
  }
  if (sessionAliases.some((candidate) => candidate !== sessionAliases[0])) {
    throw new AgentCardRegistryError('malformed', 'sessionId aliases must agree');
  }
  if (sessionAliases.length === 0) {
    // Recipient targeting only needs the local runtime ID.  A full session/runtime
    // pair is still required when this registry publishes its own card.
    return undefined;
  }
  return canonicalIdentity(sessionAliases[0], runtimeId, 'local identity');
}

function resolveDuration(value: number | undefined, fallback: number, label: string): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result <= 0) {
    throw new AgentCardRegistryError('malformed', `${label} must be a positive safe integer`);
  }
  return result;
}

function validateLeaseTiming(ttlMs: number, renewalIntervalMs: number): void {
  if (renewalIntervalMs >= ttlMs) {
    throw new AgentCardRegistryError(
      'malformed',
      'leaseRenewalIntervalMs must be less than leaseTtlMs',
    );
  }
}

const BUILTIN_DATE = Date;
const BUILTIN_DATE_GET_TIME = Date.prototype.getTime;
const BUILTIN_DATE_TO_ISO_STRING = Date.prototype.toISOString;
const BUILTIN_DATE_PARSE = Date.parse;
const MAX_LEASE_EXPIRY_STRING_LENGTH = 256;

function dateMilliseconds(value: unknown): number | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }
  try {
    return BUILTIN_DATE_GET_TIME.call(value);
  } catch {
    return undefined;
  }
}

function isDateValue(value: unknown): value is Date {
  return dateMilliseconds(value) !== undefined;
}

function resolveNow(value: number | Date | undefined, clock: LeaseClock): number {
  let result: number | undefined;
  if (value === undefined) {
    try {
      result = clock();
    } catch {
      throw new AgentCardRegistryError('malformed', 'registry time cannot be read safely');
    }
  } else if (typeof value === 'number') {
    result = value;
  } else {
    result = dateMilliseconds(value);
  }
  if (typeof result !== 'number' || !Number.isFinite(result)) {
    throw new AgentCardRegistryError('malformed', 'registry time must be finite');
  }
  return result;
}

function parseExpiry(value: string | number | Date, label: string): number {
  let result: number | undefined;
  if (typeof value === 'number') {
    result = value;
  } else if (typeof value === 'string') {
    result = undefined;
    if (value.length > MAX_LEASE_EXPIRY_STRING_LENGTH) {
      throw new AgentCardRegistryError('malformed', `${label} must be a bounded timestamp`);
    }
    try {
      result = BUILTIN_DATE_PARSE(value);
    } catch {
      throw new AgentCardRegistryError('malformed', `${label} must be a finite timestamp`);
    }
  } else {
    result = dateMilliseconds(value);
  }
  if (typeof result !== 'number' || !Number.isFinite(result)) {
    throw new AgentCardRegistryError('malformed', `${label} must be a finite timestamp`);
  }
  return result;
}

function isoTimestamp(value: number): UtcTimestamp {
  const result = new BUILTIN_DATE(value);
  let milliseconds: number;
  try {
    milliseconds = BUILTIN_DATE_GET_TIME.call(result);
  } catch {
    throw new AgentCardRegistryError(
      'malformed',
      'lease expiry is outside the supported date range',
    );
  }
  if (!Number.isFinite(milliseconds)) {
    throw new AgentCardRegistryError(
      'malformed',
      'lease expiry is outside the supported date range',
    );
  }
  try {
    return BUILTIN_DATE_TO_ISO_STRING.call(result) as UtcTimestamp;
  } catch {
    throw new AgentCardRegistryError(
      'malformed',
      'lease expiry is outside the supported date range',
    );
  }
}

function cloneEndpoint(endpoint: RoutingEndpoint, runtimeId?: RuntimeId): RoutingEndpoint {
  const normalized = validateEndpoint(endpoint, runtimeId);
  if (typeof normalized === 'string') {
    return normalized;
  }
  return Object.freeze({
    address: normalized.address,
    ...(normalized.kind === undefined ? {} : { kind: normalized.kind }),
    ...(normalized.transport === undefined ? {} : { transport: normalized.transport }),
    ...(normalized.runtimeId === undefined ? {} : { runtimeId: normalized.runtimeId }),
  });
}

function endpointsEqual(left: RoutingEndpoint, right: RoutingEndpoint): boolean {
  if (typeof left === 'string' || typeof right === 'string') {
    return typeof left === 'string' && typeof right === 'string' && left === right;
  }
  return (
    left.address === right.address &&
    left.kind === right.kind &&
    left.transport === right.transport &&
    left.runtimeId === right.runtimeId
  );
}

function validateEndpoint(endpoint: RoutingEndpoint, runtimeId?: RuntimeId): RoutingEndpoint {
  if (typeof endpoint === 'string') {
    if (
      endpoint.trim().length === 0 ||
      endpoint.length > MAX_ENDPOINT_LENGTH ||
      Buffer.byteLength(endpoint, 'utf8') > MAX_ENDPOINT_BYTES ||
      CONTROL_CHARACTER_PATTERN.test(endpoint)
    ) {
      throw new AgentCardRegistryError(
        'malformed',
        'routing endpoint must be bounded non-empty text',
      );
    }
    return endpoint;
  }
  if (!isRecord(endpoint)) {
    throw new AgentCardRegistryError('malformed', 'routing endpoint must be an opaque descriptor');
  }
  let prototype: object | null;
  try {
    prototype = Object.getPrototypeOf(endpoint);
  } catch {
    throw new AgentCardRegistryError(
      'malformed',
      'routing endpoint descriptor cannot be inspected safely',
    );
  }
  if (prototype !== Object.prototype && prototype !== null) {
    throw new AgentCardRegistryError(
      'malformed',
      'routing endpoint descriptor must be a plain object',
    );
  }
  let keys: string[];
  let symbols: symbol[];
  try {
    keys = Object.getOwnPropertyNames(endpoint);
    symbols = Object.getOwnPropertySymbols(endpoint);
  } catch {
    throw new AgentCardRegistryError(
      'malformed',
      'routing endpoint descriptor cannot be inspected safely',
    );
  }
  if (symbols.length > 0 || keys.length > MAX_ENDPOINT_KEYS) {
    throw new AgentCardRegistryError(
      'malformed',
      'routing endpoint descriptor has too many fields',
    );
  }
  const allowedKeys = new Set(['address', 'kind', 'transport', 'runtimeId']);
  for (const key of keys) {
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(endpoint, key);
    } catch {
      throw new AgentCardRegistryError(
        'malformed',
        'routing endpoint descriptor cannot be inspected safely',
      );
    }
    if (descriptor === undefined || !('value' in descriptor) || !descriptor.enumerable) {
      throw new AgentCardRegistryError(
        'malformed',
        'routing endpoint descriptor cannot contain accessors or hidden fields',
      );
    }
    if (!allowedKeys.has(key)) {
      throw new AgentCardRegistryError(
        'malformed',
        FORBIDDEN_METADATA_KEYS.has(key)
          ? 'routing endpoint cannot carry credentials'
          : 'routing endpoint contains an unknown field',
      );
    }
  }
  const ownValue = (key: string): unknown => {
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(endpoint, key);
    } catch {
      throw new AgentCardRegistryError(
        'malformed',
        'routing endpoint descriptor cannot be inspected safely',
      );
    }
    if (descriptor === undefined) {
      return undefined;
    }
    if (!('value' in descriptor) || !descriptor.enumerable) {
      throw new AgentCardRegistryError(
        'malformed',
        'routing endpoint descriptor cannot contain accessors or hidden fields',
      );
    }
    return descriptor.value;
  };
  const address = ownValue('address');
  if (
    typeof address !== 'string' ||
    address.trim().length === 0 ||
    address.length > MAX_ENDPOINT_LENGTH ||
    Buffer.byteLength(address, 'utf8') > MAX_ENDPOINT_BYTES ||
    CONTROL_CHARACTER_PATTERN.test(address)
  ) {
    throw new AgentCardRegistryError(
      'malformed',
      'routing endpoint address must be bounded non-empty text',
    );
  }
  const kind = ownValue('kind');
  if (
    kind !== undefined &&
    (typeof kind !== 'string' ||
      kind.trim().length === 0 ||
      kind.length > MAX_ENDPOINT_LENGTH ||
      Buffer.byteLength(kind, 'utf8') > MAX_ENDPOINT_BYTES ||
      CONTROL_CHARACTER_PATTERN.test(kind))
  ) {
    throw new AgentCardRegistryError(
      'malformed',
      'routing endpoint kind must be bounded non-empty text',
    );
  }
  const transport = ownValue('transport');
  if (
    transport !== undefined &&
    (typeof transport !== 'string' ||
      transport.trim().length === 0 ||
      transport.length > MAX_ENDPOINT_LENGTH ||
      Buffer.byteLength(transport, 'utf8') > MAX_ENDPOINT_BYTES ||
      CONTROL_CHARACTER_PATTERN.test(transport))
  ) {
    throw new AgentCardRegistryError(
      'malformed',
      'routing endpoint transport must be bounded non-empty text',
    );
  }
  if (kind !== undefined && transport !== undefined && kind !== transport) {
    throw new AgentCardRegistryError('malformed', 'routing endpoint kind and transport must agree');
  }
  const endpointRuntimeId = ownValue('runtimeId');
  let canonicalEndpointRuntimeId: RuntimeId | undefined;
  if (endpointRuntimeId !== undefined) {
    canonicalEndpointRuntimeId = runtimeValue(endpointRuntimeId, 'routing endpoint runtimeId');
    if (runtimeId !== undefined && canonicalEndpointRuntimeId !== runtimeId) {
      throw new AgentCardRegistryError(
        'unauthorized',
        'routing endpoint is not owned by the runtime',
      );
    }
  }
  const normalized: RoutingEndpointDescriptor = {
    address,
    ...(kind === undefined ? {} : { kind }),
    ...(transport === undefined ? {} : { transport }),
    ...(canonicalEndpointRuntimeId === undefined ? {} : { runtimeId: canonicalEndpointRuntimeId }),
  };
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(normalized);
  } catch {
    throw new AgentCardRegistryError('malformed', 'routing endpoint is not JSON serializable');
  }
  if (serialized === undefined || Buffer.byteLength(serialized, 'utf8') > MAX_ENDPOINT_BYTES) {
    throw new AgentCardRegistryError('malformed', 'routing endpoint exceeds its size limit');
  }
  return normalized;
}

function unique<T>(values: readonly T[], label: string): void {
  if (new Set(values).size !== values.length) {
    throw new AgentCardRegistryError('malformed', `${label} must not contain duplicates`);
  }
}

function validateCardArrayBudget(card: AgentCard): void {
  const arrays: readonly [string, unknown, number][] = [
    ['supportedProtocolVersions', card.supportedProtocolVersions, MAX_SUPPORTED_PROTOCOL_VERSIONS],
    ['operations', card.operations, MAX_OPERATION_CAPABILITIES],
    ['contentCapabilities', card.contentCapabilities, MAX_CONTENT_CAPABILITIES],
  ];
  for (const [label, value, maximum] of arrays) {
    if (Array.isArray(value) && value.length > maximum) {
      throw new AgentCardRegistryError('malformed', `Agent Card ${label} exceeds its array budget`);
    }
  }
}

/** Apply the canonical peer.describe Agent Card validation and envelope budget. */
function validateCanonicalAgentCard(card: AgentCard): void {
  const result = validateOperationResponse({
    protocolVersion: PROTOCOL_VERSION,
    operation: 'peer.describe',
    operationId: CANONICAL_CARD_VALIDATION_OPERATION_ID,
    traceId: CANONICAL_CARD_VALIDATION_TRACE_ID,
    result: { agentCard: card },
  });
  if (!result.ok) {
    throw new AgentCardRegistryError('malformed', `Agent Card is invalid: ${result.error.message}`);
  }
}

function cloneCard(card: AgentCard, identity?: SessionRuntimeIdentity): AgentCard {
  const snapshot = cloneFrozenSnapshot(card);
  if (!isRecord(snapshot)) {
    throw new AgentCardRegistryError('malformed', 'Agent Card must be an object');
  }
  card = snapshot as AgentCard;
  validateCardArrayBudget(card);
  validateCanonicalAgentCard(card);
  const name = nonEmptyText(card.name, 'Agent Card name');
  const sessionId = sessionValue(card.sessionId, 'Agent Card sessionId');
  const runtimeId = runtimeValue(card.runtimeId, 'Agent Card runtimeId');
  if (identity !== undefined && !runtimeIdentitiesEqual({ sessionId, runtimeId }, identity)) {
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
    (typeof description !== 'string' ||
      description.trim().length === 0 ||
      description.length > MAX_DESCRIPTION_LENGTH ||
      CONTROL_CHARACTER_PATTERN.test(description))
  ) {
    throw new AgentCardRegistryError('malformed', 'Agent Card description is invalid');
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
  if (
    value.description !== undefined &&
    (typeof value.description !== 'string' ||
      value.description.trim().length === 0 ||
      CONTROL_CHARACTER_PATTERN.test(value.description))
  ) {
    throw new AgentCardRegistryError(
      'malformed',
      'operation capability description must be bounded safe text',
    );
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

interface PublicationField {
  readonly present: boolean;
  readonly value: unknown;
}

function publicationField(value: Record<string, unknown>, key: string): PublicationField {
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = Object.getOwnPropertyDescriptor(value, key);
  } catch {
    throw new AgentCardRegistryError(
      'malformed',
      'Agent Card publication cannot be inspected safely',
    );
  }
  if (descriptor === undefined) {
    return { present: false, value: undefined };
  }
  if (!('value' in descriptor) || !descriptor.enumerable) {
    throw new AgentCardRegistryError(
      'malformed',
      'Agent Card publication cannot contain accessors or hidden fields',
    );
  }
  return { present: true, value: descriptor.value };
}
function publicationOptionsSnapshot(options: Record<string, unknown>): Record<string, unknown> {
  if (!isRecord(options)) {
    throw new AgentCardRegistryError(
      'malformed',
      'Agent Card publication options must be an object',
    );
  }
  const snapshot: Record<string, unknown> = {};
  for (const key of ['roomId', 'leaseExpiresAt', 'leaseTtlMs']) {
    const field = publicationField(options, key);
    if (field.present && field.value !== undefined) {
      snapshot[key] = field.value;
    }
  }
  return snapshot;
}

function extractPublication(input: AgentCardPublication | AgentCard): PublicationParts {
  if (!isRecord(input)) {
    throw new AgentCardRegistryError('malformed', 'Agent Card publication must be an object');
  }
  const raw = input as Record<string, unknown>;
  const rawCard = publicationField(raw, 'card');
  const nestedCard = isRecord(rawCard.value) ? rawCard.value : undefined;
  const card = (nestedCard ?? raw) as unknown as AgentCard;
  const rawRoom = publicationField(raw, 'roomId');
  const nestedRoom =
    nestedCard === undefined
      ? { present: false, value: undefined }
      : publicationField(nestedCard, 'roomId');
  const roomAliases = [rawRoom.value, nestedRoom.value].filter(
    (value): value is RoomId => value !== undefined,
  );
  const roomValues = roomAliases.map((value) => roomValue(value, 'roomId'));
  if (roomValues.length > 1 && roomValues.some((value) => value !== roomValues[0])) {
    throw new AgentCardRegistryError('malformed', 'room aliases must agree');
  }
  const roomId = roomValues[0];
  const rawEndpoint = publicationField(raw, 'endpoint');
  const nestedEndpoint =
    nestedCard === undefined
      ? { present: false, value: undefined }
      : publicationField(nestedCard, 'endpoint');
  const endpoint = (rawEndpoint.value ?? nestedEndpoint.value) as RoutingEndpoint | undefined;
  if (endpoint === undefined) {
    throw new AgentCardRegistryError('malformed', 'current routing endpoint is required');
  }
  const rawExpiry = publicationField(raw, 'leaseExpiresAt');
  const nestedExpiry =
    nestedCard === undefined
      ? { present: false, value: undefined }
      : publicationField(nestedCard, 'leaseExpiresAt');
  const leaseExpiresAt = (rawExpiry.present ? rawExpiry.value : nestedExpiry.value) as
    string | number | Date | undefined;
  if (
    leaseExpiresAt !== undefined &&
    typeof leaseExpiresAt !== 'string' &&
    typeof leaseExpiresAt !== 'number' &&
    !isDateValue(leaseExpiresAt)
  ) {
    throw new AgentCardRegistryError('malformed', 'leaseExpiresAt must be a timestamp');
  }
  if (
    typeof leaseExpiresAt === 'string' &&
    leaseExpiresAt.length > MAX_LEASE_EXPIRY_STRING_LENGTH
  ) {
    throw new AgentCardRegistryError('malformed', 'leaseExpiresAt must be a bounded timestamp');
  }
  const rawTtl = publicationField(raw, 'leaseTtlMs');
  const nestedTtl =
    nestedCard === undefined
      ? { present: false, value: undefined }
      : publicationField(nestedCard, 'leaseTtlMs');
  const leaseTtlMs = rawTtl.present ? rawTtl.value : nestedTtl.value;
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
function assertSerializedEnvelopeSize(value: unknown, label: string): void {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new AgentCardRegistryError('malformed', `${label} is not JSON serializable`);
  }
  if (serialized === undefined) {
    throw new AgentCardRegistryError('malformed', `${label} is not JSON serializable`);
  }
  const bytes = Buffer.byteLength(serialized, 'utf8');
  if (bytes > DEFAULT_PROTOCOL_LIMITS.maxEnvelopeBytes) {
    throw new AgentCardRegistryError('malformed', `${label} exceeds the envelope size limit`);
  }
}

function cardWithDiscoveryFields(
  card: AgentCard,
  roomId: RoomId,
  endpoint: RoutingEndpoint,
  leaseExpiresAt: UtcTimestamp,
): AdvertisedAgentCard {
  const advertised = Object.freeze({
    ...card,
    roomId,
    endpoint,
    leaseExpiresAt,
  });
  assertSerializedEnvelopeSize(advertised, 'advertised Agent Card');
  return advertised;
}

function leaseSnapshot(
  identity: SessionRuntimeIdentity,
  endpoint: RoutingEndpoint,
  issuedAt: number,
  lastRenewedAt: number,
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
    issuedAt,
    lastRenewedAt,
    expiresAt,
    leaseExpiresAt: isoTimestamp(expiresAt),
    lastError: null,
  });
}

function publicationWithoutLeaseFields(record: RuntimeAdvertisement): AgentCardPublication {
  const card = { ...record.card };
  delete (card as { leaseExpiresAt?: UtcTimestamp }).leaseExpiresAt;
  return {
    card: card as AgentCard,
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

const UNREADABLE_INBOUND_VALUE = Symbol('unreadable-inbound-value');
function inboundProperty(value: unknown, key: string): unknown {
  try {
    if (!isRecord(value)) {
      return UNREADABLE_INBOUND_VALUE;
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !('value' in descriptor)) {
      return UNREADABLE_INBOUND_VALUE;
    }
    return descriptor.value;
  } catch {
    return UNREADABLE_INBOUND_VALUE;
  }
}

function isTargetedOperation(value: unknown): value is ProtocolEnvelope {
  try {
    if (!isRecord(value)) {
      return false;
    }
    const sender = inboundProperty(value, 'sender');
    const recipientRuntimeId = inboundProperty(value, 'recipientRuntimeId');
    const roomId = inboundProperty(value, 'roomId');
    return (
      sender !== UNREADABLE_INBOUND_VALUE &&
      isCanonicalIdentity(sender) &&
      recipientRuntimeId !== UNREADABLE_INBOUND_VALUE &&
      isUuidV4(recipientRuntimeId) &&
      roomId !== UNREADABLE_INBOUND_VALUE &&
      isRoomId(roomId)
    );
  } catch {
    return false;
  }
}

function unwrapInbound<Envelope extends ProtocolEnvelope>(
  input: AuthenticatedOperation<Envelope>,
):
  | {
      readonly envelope: unknown;
      readonly metadata: BindingMetadata | undefined;
      readonly expectedRequestExpiresAt: string | number | undefined;
    }
  | undefined {
  if (!isRecord(input) || !trustedAuthenticatedOperations.has(input)) {
    return undefined;
  }
  const envelope = inboundProperty(input, 'envelope');
  if (envelope === UNREADABLE_INBOUND_VALUE) {
    return undefined;
  }
  const bindingMetadata = inboundProperty(input, 'bindingMetadata');
  const aliasMetadata = inboundProperty(input, 'metadata');
  const rawMetadata =
    bindingMetadata !== UNREADABLE_INBOUND_VALUE && bindingMetadata !== undefined
      ? bindingMetadata
      : aliasMetadata;
  const metadata =
    rawMetadata === UNREADABLE_INBOUND_VALUE || rawMetadata === undefined
      ? undefined
      : isRecord(rawMetadata)
        ? (rawMetadata as BindingMetadata)
        : undefined;
  const rawExpectedRequestExpiresAt = inboundProperty(input, 'expectedRequestExpiresAt');
  const expectedRequestExpiresAt =
    typeof rawExpectedRequestExpiresAt === 'string' ||
    typeof rawExpectedRequestExpiresAt === 'number'
      ? rawExpectedRequestExpiresAt
      : undefined;
  return { envelope, metadata, expectedRequestExpiresAt };
}

function authenticatedIdentity(value: unknown): SessionRuntimeIdentity | undefined {
  try {
    const authenticated = inboundProperty(value, 'authenticated');
    const identity = inboundProperty(value, 'identity');
    if (
      authenticated !== true ||
      identity === UNREADABLE_INBOUND_VALUE ||
      !isCanonicalIdentity(identity)
    ) {
      return undefined;
    }
    return Object.freeze({
      sessionId: identity.sessionId,
      runtimeId: identity.runtimeId,
    });
  } catch {
    return undefined;
  }
}

async function authenticateBinding(
  authenticator: BindingAuthenticator,
  metadata: BindingMetadata | undefined,
  context: BindingAuthenticationContext,
): Promise<SessionRuntimeIdentity | undefined> {
  try {
    const method = authenticator.authenticate ?? authenticator.verify;
    if (typeof method !== 'function') {
      return undefined;
    }
    const result = await method.call(authenticator, metadata, context);
    if (!isRecord(result) || inboundProperty(result, 'authenticated') !== true) {
      return undefined;
    }
    return authenticatedIdentity(result);
  } catch {
    // Binding failures, including accessor/proxy failures while discovering
    // the verifier, are intentionally collapsed to safe unauthorized state.
    return undefined;
  }
}
interface InboundTargetSnapshot {
  readonly sender?: SessionRuntimeIdentity;
  readonly recipientRuntimeId?: RuntimeId;
  readonly roomId?: RoomId;
}

function readInboundTarget(value: unknown): InboundTargetSnapshot {
  try {
    const rawSender = inboundProperty(value, 'sender');
    const sessionId =
      rawSender === UNREADABLE_INBOUND_VALUE
        ? UNREADABLE_INBOUND_VALUE
        : inboundProperty(rawSender, 'sessionId');
    const runtimeId =
      rawSender === UNREADABLE_INBOUND_VALUE
        ? UNREADABLE_INBOUND_VALUE
        : inboundProperty(rawSender, 'runtimeId');
    const senderCandidate = { sessionId, runtimeId };
    const sender =
      sessionId !== UNREADABLE_INBOUND_VALUE &&
      runtimeId !== UNREADABLE_INBOUND_VALUE &&
      isCanonicalIdentity(senderCandidate)
        ? Object.freeze({
            sessionId: senderCandidate.sessionId,
            runtimeId: senderCandidate.runtimeId,
          })
        : undefined;
    const rawRecipientRuntimeId = inboundProperty(value, 'recipientRuntimeId');
    const recipientRuntimeId =
      rawRecipientRuntimeId !== UNREADABLE_INBOUND_VALUE && isUuidV4(rawRecipientRuntimeId)
        ? rawRecipientRuntimeId
        : undefined;
    const rawRoomId = inboundProperty(value, 'roomId');
    const roomId =
      rawRoomId !== UNREADABLE_INBOUND_VALUE && isRoomId(rawRoomId) ? rawRoomId : undefined;
    return {
      ...(sender === undefined ? {} : { sender }),
      ...(recipientRuntimeId === undefined ? {} : { recipientRuntimeId }),
      ...(roomId === undefined ? {} : { roomId }),
    };
  } catch {
    return {};
  }
}

function malformedInboundResult(
  message = 'authenticated envelope is malformed',
): TargetVerificationFailure {
  return Object.freeze({
    ok: false,
    error: createProtocolError('malformed', message),
  });
}

function validateInboundAfterAuthentication(
  value: unknown,
  expectedRequestExpiresAt?: string | number | Date,
): { readonly ok: true; readonly envelope: ProtocolEnvelope } | TargetVerificationFailure {
  try {
    const validationView = createCanonicalEnvelopeValidationView(value);
    const envelope = validateAuthenticatedEnvelope(validationView, expectedRequestExpiresAt);
    const snapshot = cloneFrozenSnapshot(envelope);
    if (!isTargetedOperation(snapshot)) {
      return malformedInboundResult();
    }
    return { ok: true, envelope: snapshot as ProtocolEnvelope };
  } catch (error: unknown) {
    if (error instanceof AgentCardRegistryError && error.code === 'expired') {
      return Object.freeze({
        ok: false,
        error: createProtocolError('expired', 'authenticated envelope has expired'),
      });
    }
    return malformedInboundResult();
  }
}

function unauthorizedResult(): TargetVerificationFailure {
  return Object.freeze({ ok: false, error: safeError('unauthorized') });
}

function crossRoomResult(): TargetVerificationFailure {
  return Object.freeze({ ok: false, error: safeError('cross_room') });
}

/** Options for binding-authenticated target verification. */
export interface TargetVerificationOptions {
  /** Original request deadline used to enforce a message.reply deadline. */
  readonly expectedRequestExpiresAt?: string | number | Date;
}

/**
 * Verify a binding-authenticated sender and target before any application
 * lookup.  The order is intentional: binding validity and claimed sender are
 * checked first, exact room equality is checked second, and recipient targeting
 * is checked last.  A caller can therefore safely invoke task/dedupe lookup
 * only after receiving an `ok: true` result.
 */

export async function verifyAuthenticatedTarget<Envelope extends ProtocolEnvelope>(
  input: AuthenticatedOperation<Envelope>,
  authenticator: BindingAuthenticator,
  target: VerificationTarget,
  options: TargetVerificationOptions = {},
): Promise<TargetVerificationResult<Envelope>> {
  try {
    const unwrapped = unwrapInbound(input);
    if (unwrapped === undefined) {
      return unauthorizedResult();
    }
    const localRuntimeId = target.runtimeId;
    const localRoomId = target.roomId;
    if (!isUuidV4(localRuntimeId) || !isRoomId(localRoomId)) {
      return unauthorizedResult();
    }
    const preliminary = readInboundTarget(unwrapped.envelope);
    const fallbackSender: SenderIdentity = Object.freeze({
      sessionId: '' as SessionId,
      runtimeId: localRuntimeId,
    });
    const context: BindingAuthenticationContext = Object.freeze({
      claimedSender: preliminary.sender ?? fallbackSender,
      recipientRuntimeId: preliminary.recipientRuntimeId ?? localRuntimeId,
      roomId: preliminary.roomId ?? localRoomId,
      localRuntimeId,
      localRoomId,
    });
    // Authentication intentionally precedes canonical envelope validation so
    // malformed or adversarial input cannot probe validation/task state. The
    // authenticator boundary also collapses getter/proxy failures safely.
    const authenticated = await authenticateBinding(authenticator, unwrapped.metadata, context);
    if (
      authenticated === undefined ||
      preliminary.sender === undefined ||
      !runtimeIdentitiesEqual(authenticated, preliminary.sender)
    ) {
      return unauthorizedResult();
    }
    if (preliminary.roomId !== undefined && !roomsEqual(preliminary.roomId, localRoomId)) {
      return crossRoomResult();
    }
    if (
      preliminary.recipientRuntimeId !== undefined &&
      preliminary.recipientRuntimeId !== localRuntimeId
    ) {
      return unauthorizedResult();
    }
    const expectedRequestExpiresAt =
      options.expectedRequestExpiresAt ?? unwrapped.expectedRequestExpiresAt;
    const validated = validateInboundAfterAuthentication(
      unwrapped.envelope,
      expectedRequestExpiresAt,
    );
    if (!validated.ok) {
      return validated;
    }
    const envelope = validated.envelope;
    if (!isTargetedOperation(envelope)) {
      return malformedInboundResult();
    }
    if (!runtimeIdentitiesEqual(authenticated, envelope.sender)) {
      return unauthorizedResult();
    }
    if (!roomsEqual(envelope.roomId, localRoomId)) {
      return crossRoomResult();
    }
    if (envelope.recipientRuntimeId !== localRuntimeId) {
      return unauthorizedResult();
    }
    return Object.freeze({
      ok: true,
      envelope: envelope as Envelope,
      sender: authenticated,
      recipientRuntimeId: envelope.recipientRuntimeId,
      roomId: envelope.roomId,
    });
  } catch {
    return unauthorizedResult();
  }
}

export const verifyAuthenticatedSender = verifyAuthenticatedTarget;
export const verifyInboundTarget = verifyAuthenticatedTarget;
export const verifyBindingTarget = verifyAuthenticatedTarget;
export const verifySenderIdentity = verifyAuthenticatedTarget;
export const verifyRecipientTarget = verifyAuthenticatedTarget;
export const authorizeInbound = verifyAuthenticatedTarget;

/** Run a caller-supplied lookup only after target verification succeeds. */
export async function authorizeBeforeLookup<Envelope extends ProtocolEnvelope, Result>(
  input: AuthenticatedOperation<Envelope>,
  authenticator: BindingAuthenticator,
  target: VerificationTarget,
  lookup: (authorized: AuthorizedTarget<Envelope>) => Result | PromiseLike<Result>,
  options: TargetVerificationOptions = {},
): Promise<TargetVerificationFailure | Result> {
  const verification = await verifyAuthenticatedTarget(input, authenticator, target, options);
  if (!verification.ok) {
    return verification;
  }
  return lookup(verification);
}

/** Throwing form for routers that use exceptions at their binding boundary. */
export async function assertAuthenticatedTarget<Envelope extends ProtocolEnvelope>(
  input: AuthenticatedOperation<Envelope>,
  authenticator: BindingAuthenticator,
  target: VerificationTarget,
  options: TargetVerificationOptions = {},
): Promise<AuthorizedTarget<Envelope>> {
  const result = await verifyAuthenticatedTarget(input, authenticator, target, options);
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
  private readonly retiredIds = new Map<RuntimeId, RetiredRuntimeIdentity>();
  private nextGeneration = 0;
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
    const configuredRuntimeId =
      this.identity?.runtimeId ?? options.runtimeId ?? options.runtimeInstanceId;
    this.runtimeId =
      configuredRuntimeId === undefined
        ? undefined
        : runtimeValue(configuredRuntimeId, 'runtimeId');
    this.leaseTtlMs = resolveDuration(options.leaseTtlMs, DEFAULT_LEASE_TTL_MS, 'leaseTtlMs');
    this.leaseRenewalIntervalMs = resolveDuration(
      options.leaseRenewalIntervalMs,
      DEFAULT_LEASE_RENEWAL_INTERVAL_MS,
      'leaseRenewalIntervalMs',
    );
    validateLeaseTiming(this.leaseTtlMs, this.leaseRenewalIntervalMs);
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
    this.assertMutationIdentity();
    const publication =
      endpoint === undefined
        ? extractPublication(publicationOrCard)
        : extractPublication({
            ...publicationOptionsSnapshot(options),
            card: publicationOrCard as AgentCard,
            endpoint,
          });
    return this.registerParts(this.validatePublication(publication));
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
    this.assertMutationIdentity();
    const ownerIdentity = this.requireOwnerIdentity(owner);
    this.assertLocalOwner(ownerIdentity);
    const runtimeId = ownerIdentity.runtimeId;
    const existing = this.records.get(runtimeId);
    if (existing === undefined) {
      throw new AgentCardRegistryError('not_found', 'runtime advertisement is not registered');
    }
    const now = this.clock();
    if (!isLive(existing, now)) {
      this.retireRecord(existing, now);
      throw new AgentCardRegistryError('expired', 'runtime advertisement lease has expired');
    }
    if (!runtimeIdentitiesEqual(ownerIdentity, existing.owner)) {
      throw new AgentCardRegistryAuthorizationError();
    }

    const source = publication ?? publicationWithoutLeaseFields(existing.record);
    const sourceParts = extractPublication(source);
    const endpointOverride = publicationField(options as Record<string, unknown>, 'endpoint')
      .value as RoutingEndpoint | undefined;
    const parsed = this.validatePublication(
      endpointOverride === undefined ? sourceParts : { ...sourceParts, endpoint: endpointOverride },
    );
    if (parsed.card.runtimeId !== runtimeId || parsed.card.sessionId !== existing.owner.sessionId) {
      throw new AgentCardRegistryAuthorizationError();
    }
    const ttlMs = resolveDuration(options.ttlMs, existing.ttlMs, 'leaseTtlMs');
    const renewalIntervalMs = existing.record.lease.renewalIntervalMs;
    validateLeaseTiming(ttlMs, renewalIntervalMs);
    const expiresAtMs = resolveNow(options.now, this.now) + ttlMs;
    return this.renewExact(
      ownerIdentity,
      existing.generation,
      parsed,
      ttlMs,
      expiresAtMs,
      renewalIntervalMs,
    );
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
    this.assertMutationIdentity();
    if (
      typeof owner === 'string' &&
      this.identity !== undefined &&
      owner !== this.identity.runtimeId
    ) {
      throw new AgentCardRegistryAuthorizationError();
    }
    const ownerIdentity = this.resolveUnregisterOwner(owner);
    if (ownerIdentity === undefined) {
      return false;
    }
    this.assertLocalOwner(ownerIdentity);
    const existing = this.records.get(ownerIdentity.runtimeId);
    if (existing === undefined) {
      return false;
    }
    return this.unregisterExact(ownerIdentity, existing.generation);
  }

  public remove(owner?: RuntimeId | SessionRuntimeIdentity): boolean {
    const resolvedOwner = owner ?? this.identity;
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
    const canonicalRuntimeId = runtimeValue(runtimeId, 'runtimeId');
    const now = resolveNow(options.now, this.now);
    this.pruneRetired(now);
    const record = this.records.get(canonicalRuntimeId);
    if (record === undefined) {
      return undefined;
    }
    if (!isLive(record, now)) {
      this.retireRecord(record, now);
      return undefined;
    }
    return roomsEqual(record.record.roomId, this.roomId) ? record.record : undefined;
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
    this.pruneRetired(now);
    const records: RuntimeAdvertisement[] = [];
    for (const record of this.records.values()) {
      if (!isLive(record, now)) {
        this.retireRecord(record, now);
        continue;
      }
      if (roomsEqual(record.record.roomId, this.roomId)) {
        records.push(record.record);
      }
    }
    return Object.freeze(
      records.sort((left, right) => left.runtimeId.localeCompare(right.runtimeId)),
    ) as unknown as RuntimeAdvertisement[];
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
    this.pruneRetired(now);
    const ttlMs = resolveDuration(options.ttlMs, this.leaseTtlMs, 'ttlMs');
    let removed = 0;
    for (const [runtimeId, record] of this.records) {
      if (now >= record.expiresAtMs + 2 * ttlMs) {
        // Re-read the current map entry immediately before deletion.  A
        const current = this.records.get(runtimeId);
        if (current === record && now >= current.expiresAtMs + 2 * ttlMs) {
          if (this.retireRecord(current, now)) {
            const currentBeforeDelete = this.records.get(runtimeId);
            if (currentBeforeDelete === record) {
              this.records.delete(runtimeId);
              removed += 1;
            }
          }
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
    this.assertMutationIdentity();
    const effectiveTtlMs = resolveDuration(options.ttlMs, this.leaseTtlMs, 'ttlMs');
    const effectiveRenewalIntervalMs = resolveDuration(
      options.renewalIntervalMs,
      this.leaseRenewalIntervalMs,
      'renewalIntervalMs',
    );
    validateLeaseTiming(effectiveTtlMs, effectiveRenewalIntervalMs);
    let owner: SessionRuntimeIdentity | undefined;
    let committedOwner: SessionRuntimeIdentity | undefined;
    let registrationGeneration: number | undefined;
    let endpointOverride: RoutingEndpoint | undefined;
    let endpointOverrideBaseline: RoutingEndpoint | undefined;
    let stopHandled = false;
    let leaseLifecycleGeneration = 0;
    const leaseHolder: { value?: SerializedLease } = {};
    if (typeof source !== 'function') {
      const parts = extractPublication(source);
      const validatedParts = this.validatePublication(parts);
      owner = canonicalIdentity(
        validatedParts.card.sessionId,
        validatedParts.card.runtimeId,
        'lease owner',
      );
      this.assertLocalOwner(owner);
    }
    const resolveSource = async (): Promise<AgentCardPublication | AgentCard> =>
      typeof source === 'function' ? await source() : source;
    const assertLeaseActive = (): void => {
      const lifecycle = leaseHolder.value?.lifecycle;
      if (lifecycle === 'stopped') {
        throw new LeaseStoppedError();
      }
      if (lifecycle === 'expired') {
        throw new LeaseExpiredError();
      }
    };
    const applyEndpointOverride = (parts: PublicationParts): PublicationParts => {
      if (endpointOverride === undefined) {
        return parts;
      }
      if (
        endpointOverrideBaseline !== undefined &&
        !endpointsEqual(parts.endpoint, endpointOverrideBaseline)
      ) {
        endpointOverride = undefined;
        endpointOverrideBaseline = undefined;
        return parts;
      }
      return { ...parts, endpoint: endpointOverride };
    };
    const renewal = async (): Promise<LeaseRenewalResult> => {
      assertLeaseActive();
      const ownerAtStart = owner;
      const committedOwnerAtStart = committedOwner;
      const existingAtStart =
        ownerAtStart === undefined ? undefined : this.records.get(ownerAtStart.runtimeId);
      const committedGenerationAtStart = registrationGeneration;
      const publication = await resolveSource();
      assertLeaseActive();
      const parts = extractPublication(publication);
      const validatedParts = this.validatePublication(parts);
      const publicationOwner = canonicalIdentity(
        validatedParts.card.sessionId,
        validatedParts.card.runtimeId,
        'lease owner',
      );
      if (owner === undefined) {
        owner = publicationOwner;
        this.assertLocalOwner(publicationOwner);
      } else if (!runtimeIdentitiesEqual(owner, publicationOwner)) {
        throw new AgentCardRegistryAuthorizationError('lease source changed its runtime identity');
      }
      const sourceEndpoint = validatedParts.endpoint;
      const effectiveParts = applyEndpointOverride(validatedParts);
      assertLeaseActive();

      const current = this.records.get(owner.runtimeId);
      let record: RuntimeAdvertisement;
      if (current === undefined) {
        if (existingAtStart !== undefined || committedGenerationAtStart !== undefined) {
          throw new AgentCardRegistryError(
            'not_found',
            'lease owner record was removed before renewal',
          );
        }
        const lifecycleAtClock = leaseHolder.value?.lifecycle;
        const ownerAtClock = owner;
        const committedOwnerAtClock = committedOwner;
        const registrationGenerationAtClock = registrationGeneration;
        const leaseLifecycleGenerationAtClock = leaseLifecycleGeneration;
        const registrationNow = this.clock();
        assertLeaseActive();
        if (
          leaseHolder.value?.lifecycle !== lifecycleAtClock ||
          owner !== ownerAtClock ||
          committedOwner !== committedOwnerAtClock ||
          registrationGeneration !== registrationGenerationAtClock ||
          leaseLifecycleGeneration !== leaseLifecycleGenerationAtClock
        ) {
          throw new AgentCardRegistryAuthorizationError(
            'lease owner lifecycle changed before registration commit',
          );
        }
        const currentAfterClock = this.records.get(owner.runtimeId);
        if (currentAfterClock !== undefined) {
          throw new AgentCardRegistryConflictError(
            'runtime identity was registered reentrantly before this registration committed',
          );
        }
        const freshExpiry = registrationNow + effectiveTtlMs;
        const publicationForRegistration: AgentCardPublication = {
          card: effectiveParts.card,
          endpoint: effectiveParts.endpoint,
          ...(effectiveParts.roomId === undefined ? {} : { roomId: effectiveParts.roomId }),
          ...(effectiveParts.leaseExpiresAt === undefined
            ? {}
            : { leaseExpiresAt: effectiveParts.leaseExpiresAt }),
        };
        const registrationParts = this.validatePublication(publicationForRegistration);
        assertLeaseActive();
        if (
          leaseHolder.value?.lifecycle !== lifecycleAtClock ||
          owner !== ownerAtClock ||
          committedOwner !== committedOwnerAtClock ||
          registrationGeneration !== registrationGenerationAtClock ||
          leaseLifecycleGeneration !== leaseLifecycleGenerationAtClock ||
          this.records.get(owner.runtimeId) !== undefined
        ) {
          throw new AgentCardRegistryAuthorizationError(
            'lease owner lifecycle changed before registration commit',
          );
        }
        record = this.registerParts(registrationParts, {
          ttlMs: effectiveTtlMs,
          renewalIntervalMs: effectiveRenewalIntervalMs,
          now: registrationNow,
          expiresAtMs: freshExpiry,
        });
        committedOwner = owner;
      } else {
        const expectedGeneration = committedGenerationAtStart;
        if (committedOwnerAtStart === undefined || expectedGeneration === undefined) {
          throw new AgentCardRegistryConflictError(
            'runtime identity was registered by another owner before this lease renewal',
          );
        }
        const ttlMs = effectiveTtlMs;
        const renewalNow = this.clock();
        const renewalDeadline = renewalNow + ttlMs;
        try {
          record = this.renewExact(
            owner,
            expectedGeneration,
            effectiveParts,
            ttlMs,
            renewalDeadline,
            effectiveRenewalIntervalMs,
          );
        } catch (error: unknown) {
          // An endpoint update may have committed while the source callback
          // was pending.  Rebase onto that still-owned generation so the
          // callback's completed source endpoint can become the next winner.
          const latest = this.records.get(owner.runtimeId);
          if (
            !(error instanceof AgentCardRegistryAuthorizationError) ||
            error.message !== 'runtime advertisement owner generation is stale' ||
            latest === undefined ||
            !runtimeIdentitiesEqual(latest.owner, owner)
          ) {
            throw error;
          }
          record = this.renewExact(
            owner,
            latest.generation,
            effectiveParts,
            ttlMs,
            renewalDeadline,
            effectiveRenewalIntervalMs,
          );
        }
      }
      const currentAfterRenewal = this.records.get(owner.runtimeId);
      registrationGeneration = currentAfterRenewal?.generation;
      if (registrationGeneration === undefined) {
        throw new AgentCardRegistryError('not_found', 'lease owner record was removed');
      }
      committedOwner ??= owner;
      if (endpointOverride !== undefined && endpointOverrideBaseline === undefined) {
        endpointOverrideBaseline = sourceEndpoint;
      }
      const result: LeaseRenewalResult = {
        endpoint: record.endpoint,
        identity: owner,
        endpointGeneration: registrationGeneration,
        ...(record.lease.issuedAt === null ? {} : { issuedAt: record.lease.issuedAt }),
        ...(record.lease.lastRenewedAt === null
          ? {}
          : { lastRenewedAt: record.lease.lastRenewedAt }),
        ...(record.lease.expiresAt === null ? {} : { expiresAt: record.lease.expiresAt }),
      };
      return result;
    };
    const persistEndpoint = (endpoint: RoutingEndpoint): LeaseRenewalResult | undefined => {
      assertLeaseActive();
      const expectedOwner = owner;
      if (committedOwner === undefined || registrationGeneration === undefined) {
        const current =
          expectedOwner === undefined ? undefined : this.records.get(expectedOwner.runtimeId);
        if (current !== undefined) {
          throw new AgentCardRegistryConflictError(
            'runtime identity was registered by another owner before this endpoint update',
          );
        }
        endpointOverride = endpoint;
        endpointOverrideBaseline = undefined;
        return undefined;
      }
      const current = this.records.get(committedOwner.runtimeId);
      if (
        current === undefined ||
        current.generation !== registrationGeneration ||
        !runtimeIdentitiesEqual(current.owner, committedOwner)
      ) {
        throw new AgentCardRegistryAuthorizationError(
          'runtime advertisement owner generation is stale',
        );
      }
      const baseline = current.record.endpoint;
      this.updateEndpoint(committedOwner, endpoint);
      endpointOverride = endpoint;
      endpointOverrideBaseline = baseline;
      const currentAfterUpdate = this.records.get(committedOwner.runtimeId);
      registrationGeneration = currentAfterUpdate?.generation;
      if (currentAfterUpdate === undefined || registrationGeneration === undefined) {
        throw new AgentCardRegistryError('not_found', 'runtime owner record was removed');
      }
      return {
        endpoint: currentAfterUpdate.record.endpoint,
        identity: committedOwner,
        endpointGeneration: registrationGeneration,
        ...(currentAfterUpdate.record.lease.issuedAt === null
          ? {}
          : { issuedAt: currentAfterUpdate.record.lease.issuedAt }),
        ...(currentAfterUpdate.record.lease.lastRenewedAt === null
          ? {}
          : { lastRenewedAt: currentAfterUpdate.record.lease.lastRenewedAt }),
        ...(currentAfterUpdate.record.lease.expiresAt === null
          ? {}
          : { expiresAt: currentAfterUpdate.record.lease.expiresAt }),
      };
    };
    const onStop = (): void => {
      if (stopHandled) {
        return;
      }
      stopHandled = true;
      leaseLifecycleGeneration += 1;
      let callbackError: unknown;
      let callbackFailed = false;
      try {
        if (committedOwner !== undefined && registrationGeneration !== undefined) {
          const removed = this.unregisterExact(committedOwner, registrationGeneration);
          if (!removed) {
            this.ensureStoppedLeaseTombstone(committedOwner, registrationGeneration);
          }
          registrationGeneration = undefined;
          committedOwner = undefined;
        }
      } catch (error: unknown) {
        callbackFailed = true;
        callbackError = error;
      }
      try {
        options.onStop?.();
      } catch (error: unknown) {
        if (!callbackFailed) {
          callbackFailed = true;
          callbackError = error;
        }
      }
      if (callbackFailed) {
        throw callbackError;
      }
    };
    const lease = new SerializedLeaseImplementation({
      ...options,
      identity: owner,
      ttlMs: effectiveTtlMs,
      renewalIntervalMs: effectiveRenewalIntervalMs,
      scheduler: options.scheduler ?? this.scheduler,
      now: options.now ?? this.now,
      onStop,
      onEndpointUpdate: persistEndpoint,
      renew: renewal,
    });
    leaseHolder.value = lease;
    return lease;
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
  public verifyAuthenticatedTarget<Envelope extends ProtocolEnvelope>(
    input: AuthenticatedOperation<Envelope>,
    authenticator: BindingAuthenticator,
    options: TargetVerificationOptions = {},
  ): Promise<TargetVerificationResult<Envelope>> {
    if (this.runtimeId === undefined) {
      return Promise.resolve(unauthorizedResult());
    }
    return verifyAuthenticatedTarget(
      input,
      authenticator,
      {
        runtimeId: this.runtimeId,
        roomId: this.roomId,
      },
      options,
    );
  }

  public verifyAuthenticatedSender<Envelope extends ProtocolEnvelope>(
    input: AuthenticatedOperation<Envelope>,
    authenticator: BindingAuthenticator,
    options: TargetVerificationOptions = {},
  ): Promise<TargetVerificationResult<Envelope>> {
    return this.verifyAuthenticatedTarget(input, authenticator, options);
  }
  public verifyInboundTarget<Envelope extends ProtocolEnvelope>(
    input: AuthenticatedOperation<Envelope>,
    authenticator: BindingAuthenticator,
    options: TargetVerificationOptions = {},
  ): Promise<TargetVerificationResult<Envelope>> {
    return this.verifyAuthenticatedTarget(input, authenticator, options);
  }

  public authorizeBeforeLookup<Envelope extends ProtocolEnvelope, Result>(
    input: AuthenticatedOperation<Envelope>,
    authenticator: BindingAuthenticator,
    lookup: (authorized: AuthorizedTarget<Envelope>) => Result | PromiseLike<Result>,
    options: TargetVerificationOptions = {},
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
      options,
    );
  }
  private assertMutationIdentity(): void {
    if (this.runtimeId !== undefined && this.identity === undefined) {
      throw new AgentCardRegistryAuthorizationError(
        'a full local session/runtime identity is required for mutation',
      );
    }
  }

  private assertLocalOwner(owner: SessionRuntimeIdentity): void {
    if (this.identity !== undefined && !runtimeIdentitiesEqual(owner, this.identity)) {
      throw new AgentCardRegistryAuthorizationError(
        'mutation owner does not match the local runtime identity',
      );
    }
  }

  private requireOwnerIdentity(owner: RuntimeId | SessionRuntimeIdentity): SessionRuntimeIdentity {
    if (typeof owner === 'string') {
      throw new AgentCardRegistryAuthorizationError(
        'an exact session/runtime lease owner is required',
      );
    }
    return canonicalIdentity(owner.sessionId, owner.runtimeId, 'lease owner');
  }

  private resolveUnregisterOwner(
    owner: RuntimeId | SessionRuntimeIdentity,
  ): SessionRuntimeIdentity | undefined {
    if (typeof owner === 'string') {
      return this.identity?.runtimeId === owner ? this.identity : undefined;
    }
    try {
      return canonicalIdentity(owner.sessionId, owner.runtimeId, 'lease owner');
    } catch {
      return undefined;
    }
  }
  private registerParts(
    parts: PublicationParts,
    overrides: {
      readonly ttlMs?: number;
      readonly renewalIntervalMs?: number;
      readonly now?: number;
      readonly expiresAtMs?: number;
    } = {},
  ): RuntimeAdvertisement {
    const now = overrides.now ?? this.clock();
    const publicationTtlMs = resolveDuration(parts.leaseTtlMs, this.leaseTtlMs, 'leaseTtlMs');
    const ttlMs = resolveDuration(overrides.ttlMs, publicationTtlMs, 'leaseTtlMs');
    const renewalIntervalMs = resolveDuration(
      overrides.renewalIntervalMs,
      this.leaseRenewalIntervalMs,
      'leaseRenewalIntervalMs',
    );
    validateLeaseTiming(ttlMs, renewalIntervalMs);
    const freshDeadline = now + ttlMs;
    const suppliedExpiry =
      parts.leaseExpiresAt === undefined
        ? undefined
        : parseExpiry(parts.leaseExpiresAt, 'leaseExpiresAt');
    if (
      overrides.expiresAtMs === undefined &&
      suppliedExpiry !== undefined &&
      suppliedExpiry <= now
    ) {
      throw new AgentCardRegistryError('expired', 'Agent Card lease has expired');
    }
    // A supplied source expiry is authoritative when it is earlier than the
    // configured/requested lease deadline; source metadata must never be extended.
    const expiresAtMs = Math.min(
      overrides.expiresAtMs ?? freshDeadline,
      freshDeadline,
      suppliedExpiry ?? Number.POSITIVE_INFINITY,
    );
    if (!Number.isFinite(expiresAtMs) || expiresAtMs <= now) {
      throw new AgentCardRegistryError('expired', 'Agent Card lease has expired');
    }
    this.pruneRetired(now);

    const identity = canonicalIdentity(
      parts.card.sessionId,
      parts.card.runtimeId,
      'Agent Card identity',
    );
    if (this.retiredIds.has(identity.runtimeId)) {
      throw new AgentCardRegistryError(
        'expired',
        'a retired runtime identity cannot be reused; register a replacement runtime identity',
      );
    }
    const existing = this.records.get(identity.runtimeId);
    if (existing !== undefined) {
      if (!isLive(existing, now)) {
        this.retireRecord(existing, now);
        throw new AgentCardRegistryError(
          'expired',
          'an expired runtime cannot be revived; register a replacement runtime identity',
        );
      }
      throw new AgentCardRegistryConflictError(
        'runtime identity is already registered; renew the exact existing owner instead',
      );
    }
    if (this.retiredIds.size >= MAX_RETIRED_RUNTIME_IDENTITIES) {
      throw new AgentCardRegistryError(
        'busy',
        'retired runtime tombstone capacity is exhausted; retry after the grace period',
      );
    }

    const endpointCopy = cloneEndpoint(parts.endpoint, identity.runtimeId);
    const baseCard = cloneCard(parts.card, identity);
    const leaseExpiry = isoTimestamp(expiresAtMs);
    const card = cardWithDiscoveryFields(baseCard, this.roomId, endpointCopy, leaseExpiry);
    const lease = leaseSnapshot(
      identity,
      endpointCopy,
      now,
      now,
      expiresAtMs,
      ttlMs,
      renewalIntervalMs,
    );
    const record = makeRuntimeAdvertisement(identity, this.roomId, card, endpointCopy, lease);

    // Accessors and owner callbacks are rejected or snapshotted above, but a
    // reentrant caller may still have committed or retired this identity while
    // the candidate record was being built.  Never overwrite that newer state.
    const currentBeforeCommit = this.records.get(identity.runtimeId);
    if (currentBeforeCommit !== undefined) {
      throw new AgentCardRegistryConflictError(
        'runtime identity was registered reentrantly before this registration committed',
      );
    }
    if (this.retiredIds.has(identity.runtimeId)) {
      throw new AgentCardRegistryError(
        'expired',
        'runtime identity was retired reentrantly before this registration committed',
      );
    }
    if (this.retiredIds.size >= MAX_RETIRED_RUNTIME_IDENTITIES) {
      throw new AgentCardRegistryError(
        'busy',
        'retired runtime tombstone capacity is exhausted; retry after the grace period',
      );
    }
    const generation = this.nextGeneration + 1;
    this.nextGeneration = generation;
    this.records.set(identity.runtimeId, {
      record,
      owner: identity,
      expiresAtMs,
      ttlMs,
      generation,
    });
    return record;
  }
  private retireRecord(record: StoredRuntimeAdvertisement, now: number): boolean {
    const current = this.records.get(record.record.runtimeId);
    if (current !== record) {
      return false;
    }
    this.pruneRetired(now);
    const retired: RetiredRuntimeIdentity = {
      owner: record.owner,
      generation: record.generation,
      retiredAtMs: now,
    };
    const previous = this.retiredIds.get(record.record.runtimeId);
    if (previous !== undefined && previous.generation >= record.generation) {
      return true;
    }
    // Live tombstones are never evicted for capacity.  Keeping the expired
    // record in place is safer than deleting it without generation protection.
    if (this.retiredIds.size >= MAX_RETIRED_RUNTIME_IDENTITIES) {
      return false;
    }
    this.retiredIds.set(record.record.runtimeId, retired);
    return true;
  }

  private pruneRetired(now: number): void {
    for (const [runtimeId, retired] of this.retiredIds) {
      if (now >= retired.retiredAtMs + RETIRED_RUNTIME_GRACE_MS) {
        this.retiredIds.delete(runtimeId);
      }
    }
  }

  private unregisterExact(owner: SessionRuntimeIdentity, generation: number): boolean {
    const current = this.records.get(owner.runtimeId);
    if (
      current === undefined ||
      current.generation !== generation ||
      !runtimeIdentitiesEqual(current.owner, owner)
    ) {
      return false;
    }
    const retiredAtMs = this.clock();
    // A user-supplied clock may reenter the registry.  Re-read the exact
    // reference and generation before reserving its tombstone or deleting it.
    const currentAfterClock = this.records.get(owner.runtimeId);
    if (
      currentAfterClock === undefined ||
      currentAfterClock.generation !== generation ||
      !runtimeIdentitiesEqual(currentAfterClock.owner, owner)
    ) {
      return false;
    }
    this.pruneRetired(retiredAtMs);
    const previous = this.retiredIds.get(owner.runtimeId);
    if (previous === undefined && this.retiredIds.size >= MAX_RETIRED_RUNTIME_IDENTITIES) {
      return false;
    }
    if (previous !== undefined && previous.generation > generation) {
      return false;
    }
    this.retiredIds.set(owner.runtimeId, {
      owner: currentAfterClock.owner,
      generation: currentAfterClock.generation,
      retiredAtMs,
    });
    const currentBeforeDelete = this.records.get(owner.runtimeId);
    if (
      currentBeforeDelete === undefined ||
      currentBeforeDelete.generation !== generation ||
      !runtimeIdentitiesEqual(currentBeforeDelete.owner, owner)
    ) {
      return false;
    }
    this.records.delete(owner.runtimeId);
    this.pruneRetired(retiredAtMs);
    return true;
  }
  private ensureStoppedLeaseTombstone(owner: SessionRuntimeIdentity, generation: number): void {
    const current = this.records.get(owner.runtimeId);
    const existingTombstone = this.retiredIds.get(owner.runtimeId);
    if (current === undefined) {
      if (existingTombstone !== undefined && existingTombstone.generation >= generation) {
        return;
      }
      throw new AgentCardRegistryError(
        'not_found',
        'stopped runtime advertisement was not tombstoned',
      );
    }
    if (current.generation !== generation || !runtimeIdentitiesEqual(current.owner, owner)) {
      throw new AgentCardRegistryAuthorizationError(
        'runtime advertisement owner generation changed before tombstone cleanup',
      );
    }
    const retiredAtMs = this.clock();
    const currentAfterClock = this.records.get(owner.runtimeId);
    if (
      currentAfterClock === undefined ||
      currentAfterClock.generation !== generation ||
      !runtimeIdentitiesEqual(currentAfterClock.owner, owner)
    ) {
      throw new AgentCardRegistryAuthorizationError(
        'runtime advertisement owner generation changed before tombstone cleanup',
      );
    }
    if (!this.retireRecord(currentAfterClock, retiredAtMs)) {
      throw new AgentCardRegistryError(
        'busy',
        'stopped runtime advertisement tombstone could not be retained',
      );
    }
    const currentBeforeDelete = this.records.get(owner.runtimeId);
    if (
      currentBeforeDelete !== undefined &&
      currentBeforeDelete.generation === generation &&
      runtimeIdentitiesEqual(currentBeforeDelete.owner, owner)
    ) {
      this.records.delete(owner.runtimeId);
      return;
    }
    const tombstone = this.retiredIds.get(owner.runtimeId);
    if (tombstone === undefined || tombstone.generation < generation) {
      throw new AgentCardRegistryAuthorizationError(
        'runtime advertisement owner generation changed before tombstone cleanup',
      );
    }
  }

  private renewExact(
    owner: SessionRuntimeIdentity,
    generation: number,
    publication: PublicationParts,
    ttlMs: number,
    expiresAtMs: number,
    renewalIntervalMs?: number,
  ): RuntimeAdvertisement {
    const current = this.records.get(owner.runtimeId);
    const now = this.clock();
    if (current === undefined) {
      throw new AgentCardRegistryError('not_found', 'runtime advertisement is not registered');
    }
    const suppliedExpiry =
      publication.leaseExpiresAt === undefined
        ? undefined
        : parseExpiry(publication.leaseExpiresAt, 'leaseExpiresAt');
    const effectiveExpiresAtMs = Math.min(expiresAtMs, suppliedExpiry ?? Number.POSITIVE_INFINITY);
    const effectiveRenewalIntervalMs = resolveDuration(
      renewalIntervalMs,
      current.record.lease.renewalIntervalMs,
      'leaseRenewalIntervalMs',
    );
    validateLeaseTiming(ttlMs, effectiveRenewalIntervalMs);
    if (current.generation !== generation || !runtimeIdentitiesEqual(current.owner, owner)) {
      throw new AgentCardRegistryAuthorizationError(
        'runtime advertisement owner generation is stale',
      );
    }
    if (!isLive(current, now)) {
      this.retireRecord(current, now);
      throw new AgentCardRegistryError('expired', 'runtime advertisement lease has expired');
    }
    if (!Number.isFinite(effectiveExpiresAtMs) || effectiveExpiresAtMs <= now) {
      throw new AgentCardRegistryError('expired', 'Agent Card lease has expired');
    }
    const parts = this.validatePublication(publication);
    const identity = canonicalIdentity(
      parts.card.sessionId,
      parts.card.runtimeId,
      'Agent Card identity',
    );
    if (!runtimeIdentitiesEqual(identity, owner)) {
      throw new AgentCardRegistryAuthorizationError();
    }
    const endpointCopy = cloneEndpoint(parts.endpoint, owner.runtimeId);
    const baseCard = cloneCard(parts.card, owner);
    const leaseExpiry = isoTimestamp(effectiveExpiresAtMs);
    const card = cardWithDiscoveryFields(baseCard, this.roomId, endpointCopy, leaseExpiry);
    const lease = leaseSnapshot(
      owner,
      endpointCopy,
      current.record.lease.issuedAt ?? now,
      now,
      effectiveExpiresAtMs,
      ttlMs,
      effectiveRenewalIntervalMs,
    );
    const record = makeRuntimeAdvertisement(owner, this.roomId, card, endpointCopy, lease);
    const nextGeneration = ++this.nextGeneration;
    const next: StoredRuntimeAdvertisement = {
      record,
      owner,
      expiresAtMs: effectiveExpiresAtMs,
      ttlMs,
      generation: nextGeneration,
    };
    if (this.records.get(owner.runtimeId) !== current) {
      throw new AgentCardRegistryAuthorizationError(
        'runtime advertisement owner generation is stale',
      );
    }
    this.records.set(owner.runtimeId, next);
    return record;
  }

  private validatePublication(publication: PublicationParts): PublicationParts {
    const roomId =
      publication.roomId === undefined ? this.roomId : roomValue(publication.roomId, 'roomId');
    if (!roomsEqual(roomId, this.roomId)) {
      throw new AgentCardRegistryError(
        'cross_room',
        'Agent Card room does not match the local room',
      );
    }
    const card = cloneCard(publication.card, this.identity);
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
  const frozen = Object.freeze(record);
  assertSerializedEnvelopeSize(frozen, 'runtime advertisement');
  return frozen;
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
  try {
    return validateEnvelope(value).ok;
  } catch {
    return false;
  }
}
