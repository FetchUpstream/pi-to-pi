import type {
  AgentSession,
  AgentSessionRuntime,
  ExtensionAPI,
  InlineExtension,
  SessionEntry,
  SessionManager,
  SessionStartEvent,
  SessionShutdownEvent,
} from '@earendil-works/pi-coding-agent';

interface TaskSessionReader {
  getSessionId(): string;
  getBranch(): SessionEntry[];
}

export const P2P_TASK_CUSTOM_TYPE = 'p2p.task';
export const P2P_TASK_METADATA_VERSION = 1;

export const TASK_STATES = ['accepted', 'completed', 'failed', 'expired', 'superseded'] as const;

export type TaskState = (typeof TASK_STATES)[number];

/**
 * The sessionId field is the immutable origin identity. ownerSessionId records
 * which session wrote the latest record, so supersession can preserve origin
 * ownership while still leaving an auditable destination record.
 */
export interface TaskMetadata {
  version: typeof P2P_TASK_METADATA_VERSION;
  requestId: string;
  sessionId: string;
  ownerSessionId: string;
  runtimeId: string;
  peerId: string | null;
  state: TaskState;
  updatedAt: string;
  expiresAt: string | null;
  reason: string | null;
}

export interface TaskMetadataRecord extends TaskMetadata {
  entryId: string;
}

export interface AppendTaskMetadataOptions {
  requestId: string;
  /** Adapter-assigned opaque identity of the runtime writing this record. */
  runtimeId: string;
  state: TaskState;
  peerId?: string | null;
  updatedAt?: string;
  expiresAt?: string | null;
  reason?: string | null;
  /** Evaluation time for expiry and terminal transition checks. Not persisted. */
  now?: Date;
}

export interface SupersedeInheritedTaskMetadataOptions {
  runtimeId: string;
  reason: string;
  updatedAt?: string;
  /** Evaluation time for expiry checks. Not persisted. */
  now?: Date;
}

export interface TaskStateLifecycleOptions {
  /** Adapter-assigned opaque identity for the runtime writing lifecycle records. */
  runtimeId: string;
  now?: () => Date;
}

/**
 * Exact runtime/session binding captured after the lifecycle hook starts.
 * Session IDs remain useful for persisted ownership, but object identity prevents
 * a stale AgentSession or reused in-memory SessionManager from mutating the new scope.
 * `runtimeId` is not supplied by Pi; callers assign it to the active runtime and
 * pass the writer identity on each metadata append/transition.
 */
export interface TaskStateLifecycleBinding {
  readonly runtime: AgentSessionRuntime;
  readonly session: AgentSession;
  readonly sessionManager: SessionManager;
  readonly sessionId: string;
}
export interface TaskLifecycleSessionStart {
  sessionId: string;
  reason: SessionStartEvent['reason'];
  recovered: TaskMetadataRecord[];
  superseded: TaskMetadataRecord[];
}

export interface TaskLifecycleSessionShutdown {
  sessionId: string;
  reason: SessionShutdownEvent['reason'];
  targetSessionFile?: string;
}

const TERMINAL_TASK_STATES: ReadonlySet<TaskState> = new Set([
  'completed',
  'failed',
  'expired',
  'superseded',
]);

const TASK_METADATA_FIELDS = [
  'version',
  'requestId',
  'sessionId',
  'ownerSessionId',
  'runtimeId',
  'peerId',
  'state',
  'updatedAt',
  'expiresAt',
  'reason',
] as const;

const APPEND_OPTION_FIELDS = [
  'requestId',
  'runtimeId',
  'state',
  'peerId',
  'updatedAt',
  'expiresAt',
  'reason',
  'now',
] as const;
const SUPERSEDE_OPTION_FIELDS = ['runtimeId', 'reason', 'updatedAt', 'now'] as const;
const BODY_FIELD_NAMES = new Set([
  'body',
  'content',
  'message',
  'request',
  'requestBody',
  'response',
  'responseBody',
]);
const ISO_TIMESTAMP =
  /^(\d{4})-(\d{2})-(\d{2})T\d{2}:\d{2}:\d{2}(?:\.\d{3,})?(?:Z|[+-]\d{2}:\d{2})$/u;

interface AppendAuthorization {
  allowInheritedSupersede?: boolean;
}

interface LatestTaskCache {
  sessionId: string;
  leafId: string | null;
  latest: Map<string, TaskMetadataRecord>;
}

const latestTaskCache = new WeakMap<SessionManager, LatestTaskCache>();

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value: Record<string, unknown>, fields: readonly string[]): boolean {
  const expected = new Set(fields);
  const actual = Object.keys(value);
  return actual.length === fields.length && actual.every((key) => expected.has(key));
}

function isTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') {
    return false;
  }
  const match = ISO_TIMESTAMP.exec(value);
  if (!match) {
    return false;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return (
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= daysInMonth &&
    Number.isFinite(Date.parse(value))
  );
}

function assertDate(value: Date, field: string): void {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new Error(`p2p.task ${field} must be a valid Date`);
  }
}

function assertNonEmptyString(value: string, field: string): void {
  if (value.trim().length === 0) {
    throw new Error(`p2p.task ${field} must not be empty`);
  }
}

function assertExactOptions(
  value: unknown,
  fields: readonly string[],
  label: string,
): asserts value is Record<string, unknown> {
  if (!isPlainObject(value)) {
    throw new Error(`p2p.task ${label} must be a plain object`);
  }
  const unknownField = Object.keys(value).find((key) => !fields.includes(key));
  if (unknownField && BODY_FIELD_NAMES.has(unknownField)) {
    throw new Error(`p2p.task metadata must not contain message bodies (${unknownField})`);
  }
  if (unknownField === 'sessionId' || unknownField === 'ownerSessionId') {
    throw new Error('p2p.task session ownership overrides are not allowed');
  }
  if (unknownField) {
    throw new Error(`p2p.task ${label} contains unknown field ${unknownField}`);
  }
}

function assertMetadataShape(value: unknown): asserts value is TaskMetadata {
  if (!isPlainObject(value) || !hasExactKeys(value, TASK_METADATA_FIELDS)) {
    throw new Error('p2p.task metadata must be an exact plain-object schema');
  }
  if (
    value.version !== P2P_TASK_METADATA_VERSION ||
    typeof value.requestId !== 'string' ||
    value.requestId.trim().length === 0 ||
    typeof value.sessionId !== 'string' ||
    value.sessionId.trim().length === 0 ||
    typeof value.ownerSessionId !== 'string' ||
    value.ownerSessionId.trim().length === 0 ||
    typeof value.runtimeId !== 'string' ||
    value.runtimeId.trim().length === 0 ||
    (value.peerId !== null &&
      (typeof value.peerId !== 'string' || value.peerId.trim().length === 0)) ||
    !isTaskState(value.state) ||
    !isTimestamp(value.updatedAt) ||
    (value.expiresAt !== null && !isTimestamp(value.expiresAt)) ||
    (value.reason !== null && typeof value.reason !== 'string') ||
    (value.state === 'superseded' &&
      (typeof value.reason !== 'string' || value.reason.trim().length === 0)) ||
    (value.state !== 'superseded' && value.reason !== null)
  ) {
    throw new Error('p2p.task metadata failed schema validation');
  }
}

function isTaskMetadata(value: unknown): value is TaskMetadata {
  if (!isPlainObject(value) || !hasExactKeys(value, TASK_METADATA_FIELDS)) {
    return false;
  }
  try {
    assertMetadataShape(value);
    return true;
  } catch {
    return false;
  }
}

function isTaskState(value: unknown): value is TaskState {
  return typeof value === 'string' && (TASK_STATES as readonly string[]).includes(value);
}

function entriesForFolding(
  source: TaskSessionReader | readonly SessionEntry[],
): readonly SessionEntry[] {
  return Array.isArray(source) ? source : (source as TaskSessionReader).getBranch();
}

function taskRecordFromEntry(entry: SessionEntry): TaskMetadataRecord | undefined {
  if (entry.type !== 'custom' || entry.customType !== P2P_TASK_CUSTOM_TYPE) {
    return undefined;
  }
  if (!isTaskMetadata(entry.data)) {
    return undefined;
  }
  return { ...entry.data, entryId: entry.id };
}

/** Cache by leaf so repeated helper appends update one Map instead of refolding the branch. */
function cacheForAppend(sessionManager: SessionManager): Map<string, TaskMetadataRecord> {
  const sessionId = sessionManager.getSessionId();
  const leafId = sessionManager.getLeafId();
  const cached = latestTaskCache.get(sessionManager);
  if (cached && cached.sessionId === sessionId && cached.leafId === leafId) {
    return cached.latest;
  }
  const latest = foldLatestTaskMetadata(sessionManager);
  latestTaskCache.set(sessionManager, { sessionId, leafId, latest });
  return latest;
}

function cacheAppendedRecord(
  sessionManager: SessionManager,
  previousLatest: Map<string, TaskMetadataRecord>,
  record: TaskMetadataRecord,
): void {
  previousLatest.set(record.requestId, record);
  latestTaskCache.set(sessionManager, {
    sessionId: sessionManager.getSessionId(),
    leafId: record.entryId,
    latest: previousLatest,
  });
}

function assertTimestampOption(value: unknown, field: string): void {
  if (value !== undefined && !isTimestamp(value)) {
    throw new Error(`p2p.task ${field} must be an ISO timestamp`);
  }
}

function assertExpiryOption(value: unknown): void {
  if (value !== undefined && value !== null && !isTimestamp(value)) {
    throw new Error('p2p.task expiresAt must be an ISO timestamp or null');
  }
}

function assertTransitionTime(updatedAt: string, previous: TaskMetadata): void {
  if (Date.parse(updatedAt) < Date.parse(previous.updatedAt)) {
    throw new Error('p2p.task updatedAt must not move backwards');
  }
}

function transitionError(requestId: string, message: string): Error {
  return new Error(`p2p.task ${requestId} ${message}`);
}

export function isTerminalTaskState(state: TaskState): boolean {
  return TERMINAL_TASK_STATES.has(state);
}

export function isTaskExpired(record: TaskMetadata, now: Date): boolean {
  assertDate(now, 'now');
  return record.expiresAt !== null && Date.parse(record.expiresAt) <= now.getTime();
}

/**
 * Fold the active append-only branch by request ID. Later records replace
 * earlier records for the same request; this is one linear pass over the
 * selected branch and never inspects message bodies.
 */
export function foldLatestTaskMetadata(
  source: TaskSessionReader | readonly SessionEntry[],
): Map<string, TaskMetadataRecord> {
  const latest = new Map<string, TaskMetadataRecord>();
  for (const entry of entriesForFolding(source)) {
    const record = taskRecordFromEntry(entry);
    if (record) {
      latest.set(record.requestId, record);
    }
  }
  return latest;
}

function appendTaskMetadataInternal(
  sessionManager: SessionManager,
  options: AppendTaskMetadataOptions,
  authorization: AppendAuthorization = {},
): TaskMetadataRecord {
  assertExactOptions(options, APPEND_OPTION_FIELDS, 'append options');
  const { requestId, runtimeId, state } = options;
  if (typeof requestId !== 'string') {
    throw new Error('p2p.task requestId must be a string');
  }
  if (typeof runtimeId !== 'string') {
    throw new Error('p2p.task runtimeId must be a string');
  }
  if (!isTaskState(state)) {
    throw new Error('p2p.task state is unknown');
  }
  assertNonEmptyString(requestId, 'requestId');
  assertNonEmptyString(runtimeId, 'runtimeId');
  if (
    options.peerId !== undefined &&
    options.peerId !== null &&
    typeof options.peerId !== 'string'
  ) {
    throw new Error('p2p.task peerId must be a string or null');
  }
  if (options.peerId !== undefined && typeof options.peerId === 'string') {
    assertNonEmptyString(options.peerId, 'peerId');
  }
  assertTimestampOption(options.updatedAt, 'updatedAt');
  assertExpiryOption(options.expiresAt);
  if (options.now !== undefined) {
    assertDate(options.now, 'now');
  }

  const currentSessionId = sessionManager.getSessionId();
  assertNonEmptyString(currentSessionId, 'sessionId');
  const now = options.now ?? new Date();
  const updatedAt = options.updatedAt ?? now.toISOString();
  const latest = cacheForAppend(sessionManager);
  const previous = latest.get(requestId);

  if (!previous) {
    if (state !== 'accepted') {
      throw transitionError(requestId, `cannot transition unknown task to ${state}`);
    }
    if (options.reason !== undefined && options.reason !== null) {
      throw new Error('p2p.task reason is only valid for superseded records');
    }
    const metadata: TaskMetadata = {
      version: P2P_TASK_METADATA_VERSION,
      requestId,
      sessionId: currentSessionId,
      ownerSessionId: currentSessionId,
      runtimeId,
      peerId: options.peerId ?? null,
      state,
      updatedAt,
      expiresAt: options.expiresAt ?? null,
      reason: null,
    };
    assertMetadataShape(metadata);
    const entryId = sessionManager.appendCustomEntry(P2P_TASK_CUSTOM_TYPE, metadata);
    const record = { ...metadata, entryId };
    cacheAppendedRecord(sessionManager, latest, record);
    return record;
  }

  if (previous.sessionId === currentSessionId && previous.ownerSessionId !== currentSessionId) {
    throw transitionError(requestId, 'has inconsistent session ownership');
  }
  if (isTerminalTaskState(previous.state)) {
    throw transitionError(requestId, `is already terminal (${previous.state})`);
  }
  if (previous.state !== 'accepted') {
    throw transitionError(requestId, `has unsupported prior state ${previous.state}`);
  }
  assertTransitionTime(updatedAt, previous);
  if (options.peerId !== undefined && options.peerId !== previous.peerId) {
    throw new Error('p2p.task peer identity is immutable across transitions');
  }
  if (options.expiresAt !== undefined && options.expiresAt !== previous.expiresAt) {
    throw new Error('p2p.task expiry is immutable across transitions');
  }
  if (state !== 'superseded' && options.reason !== undefined && options.reason !== null) {
    throw new Error('p2p.task reason is only valid for superseded records');
  }

  const expired = isTaskExpired(previous, now);
  if (state === 'accepted') {
    throw transitionError(requestId, 'cannot be accepted more than once');
  }
  if (state === 'completed' || state === 'failed') {
    if (previous.sessionId !== currentSessionId || previous.ownerSessionId !== currentSessionId) {
      throw transitionError(requestId, 'is not owned by the current session');
    }
    if (expired) {
      throw transitionError(requestId, `has expired and cannot transition to ${state}`);
    }
  } else if (state === 'expired') {
    if (previous.sessionId !== currentSessionId || previous.ownerSessionId !== currentSessionId) {
      throw transitionError(requestId, 'is not owned by the current session');
    }
    if (!expired) {
      throw transitionError(requestId, 'cannot transition to expired before expiresAt');
    }
  } else if (state === 'superseded') {
    if (!authorization.allowInheritedSupersede) {
      throw transitionError(requestId, 'must be superseded by the session replacement lifecycle');
    }
    if (previous.sessionId === currentSessionId || previous.ownerSessionId === currentSessionId) {
      throw transitionError(requestId, 'is not inherited by the current session');
    }
    if (expired) {
      throw transitionError(requestId, 'has expired and cannot be superseded');
    }
    if (typeof options.reason !== 'string' || options.reason.trim().length === 0) {
      throw new Error('p2p.task superseded records require a reason');
    }
  }

  const metadata: TaskMetadata = {
    version: P2P_TASK_METADATA_VERSION,
    requestId,
    sessionId: previous.sessionId,
    ownerSessionId: currentSessionId,
    runtimeId,
    peerId: previous.peerId,
    state,
    updatedAt,
    expiresAt: previous.expiresAt,
    reason: state === 'superseded' ? options.reason! : null,
  };
  assertMetadataShape(metadata);
  const entryId = sessionManager.appendCustomEntry(P2P_TASK_CUSTOM_TYPE, metadata);
  const record = { ...metadata, entryId };
  cacheAppendedRecord(sessionManager, latest, record);
  return record;
}

/**
 * Append one compact state record. The session manager supplies the origin and
 * owner identities; callers cannot override either identity or copy bodies.
 */
export function appendTaskMetadata(
  sessionManager: SessionManager,
  options: AppendTaskMetadataOptions,
): TaskMetadataRecord {
  return appendTaskMetadataInternal(sessionManager, options);
}

export type TaskTransitionOptions = Omit<AppendTaskMetadataOptions, 'requestId' | 'state'>;

export function completeTaskMetadata(
  sessionManager: SessionManager,
  requestId: string,
  options: TaskTransitionOptions,
): TaskMetadataRecord {
  return appendTaskMetadata(sessionManager, { ...options, requestId, state: 'completed' });
}

export function failTaskMetadata(
  sessionManager: SessionManager,
  requestId: string,
  options: TaskTransitionOptions,
): TaskMetadataRecord {
  return appendTaskMetadata(sessionManager, { ...options, requestId, state: 'failed' });
}

export function expireTaskMetadata(
  sessionManager: SessionManager,
  requestId: string,
  options: TaskTransitionOptions,
): TaskMetadataRecord {
  return appendTaskMetadata(sessionManager, { ...options, requestId, state: 'expired' });
}

/**
 * Recover only live task state owned by the selected session. Reload may reuse
 * a session identity, while /new, /resume, fork, and clone do not migrate an
 * outgoing in-memory task map into another session.
 */
export function recoverTaskMetadata(
  sessionManager: TaskSessionReader,
  now: Date = new Date(),
): TaskMetadataRecord[] {
  assertDate(now, 'now');
  const sessionId = sessionManager.getSessionId();
  return [...foldLatestTaskMetadata(sessionManager).values()].filter(
    (record) =>
      record.sessionId === sessionId &&
      record.ownerSessionId === sessionId &&
      !isTerminalTaskState(record.state) &&
      !isTaskExpired(record, now),
  );
}

/**
 * Mark copied, live non-terminal records from another session as inherited
 * history. The origin session identity remains unchanged in every superseding
 * record. Expired records are deliberately left unrecovered rather than
 * converted by a destination session.
 */
export function supersedeInheritedTaskMetadata(
  sessionManager: SessionManager,
  options: SupersedeInheritedTaskMetadataOptions,
): TaskMetadataRecord[] {
  assertExactOptions(options, SUPERSEDE_OPTION_FIELDS, 'supersede options');
  if (typeof options.runtimeId !== 'string') {
    throw new Error('p2p.task runtimeId must be a string');
  }
  if (typeof options.reason !== 'string') {
    throw new Error('p2p.task superseded reason must be a string');
  }
  assertNonEmptyString(options.runtimeId, 'runtimeId');
  assertNonEmptyString(options.reason, 'superseded reason');
  assertTimestampOption(options.updatedAt, 'updatedAt');
  if (options.now !== undefined) {
    assertDate(options.now, 'now');
  }
  const now = options.now ?? new Date();
  const currentSessionId = sessionManager.getSessionId();
  const inherited = [...cacheForAppend(sessionManager).values()].filter(
    (record) =>
      record.sessionId !== currentSessionId &&
      record.ownerSessionId !== currentSessionId &&
      !isTerminalTaskState(record.state) &&
      !isTaskExpired(record, now),
  );

  return inherited.map((record) =>
    appendTaskMetadataInternal(
      sessionManager,
      {
        requestId: record.requestId,
        runtimeId: options.runtimeId,
        state: 'superseded',
        updatedAt: options.updatedAt,
        expiresAt: record.expiresAt,
        reason: options.reason,
        now,
      },
      { allowInheritedSupersede: true },
    ),
  );
}

/**
 * Lifecycle binding used by the deterministic runtime fixture. It resets the
 * active in-memory scope on shutdown, folds the selected branch at every
 * session_start, and supersedes fork/clone history before any destination turn.
 */
export class TaskStateLifecycle {
  readonly extension: InlineExtension = {
    name: 'pi-p2p-task-state-lifecycle',
    hidden: true,
    factory: (pi) => this.install(pi),
  };

  private activeSessionId: string | undefined;
  private activeSessionManager: SessionManager | undefined;
  private activeBinding: TaskStateLifecycleBinding | undefined;
  private sessionActive = false;
  private activeTasks = new Map<string, TaskMetadataRecord>();
  private readonly _starts: TaskLifecycleSessionStart[] = [];
  private readonly _shutdowns: TaskLifecycleSessionShutdown[] = [];
  private readonly now: () => Date;

  constructor(private readonly options: TaskStateLifecycleOptions) {
    if (!isNonEmptyString(options.runtimeId)) {
      throw new Error('p2p.task lifecycle runtimeId must not be empty');
    }
    this.now = options.now ?? (() => new Date());
  }

  get runtimeId(): string {
    return this.options.runtimeId;
  }

  get sessionId(): string | undefined {
    return this.activeSessionId;
  }

  get binding(): TaskStateLifecycleBinding | undefined {
    return this.activeBinding;
  }

  get recovered(): readonly TaskMetadataRecord[] {
    return [...this.activeTasks.values()];
  }

  get starts(): readonly TaskLifecycleSessionStart[] {
    return this._starts;
  }

  get shutdowns(): readonly TaskLifecycleSessionShutdown[] {
    return this._shutdowns;
  }

  /** Bind operations to the exact runtime and AgentSession currently hosted by Pi. */
  bindRuntimeSession(
    runtime: AgentSessionRuntime,
    session: AgentSession,
  ): TaskStateLifecycleBinding {
    const sessionId = session.sessionId;
    if (
      !this.sessionActive ||
      this.activeSessionManager !== session.sessionManager ||
      this.activeSessionId !== sessionId ||
      runtime.session !== session
    ) {
      throw new Error('p2p.task lifecycle runtime/session binding is no longer active');
    }
    const binding = Object.freeze({
      runtime,
      session,
      sessionManager: session.sessionManager,
      sessionId,
    });
    this.activeBinding = binding;
    return binding;
  }

  append(
    binding: TaskStateLifecycleBinding,
    options: Omit<AppendTaskMetadataOptions, 'now'>,
  ): TaskMetadataRecord {
    this.assertActive(binding);
    const record = appendTaskMetadata(binding.sessionManager, { ...options, now: this.now() });
    if (isTerminalTaskState(record.state)) {
      this.activeTasks.delete(record.requestId);
    } else {
      this.activeTasks.set(record.requestId, record);
    }
    return record;
  }

  complete(
    binding: TaskStateLifecycleBinding,
    requestId: string,
    options: TaskTransitionOptions,
  ): TaskMetadataRecord {
    return this.append(binding, { ...options, requestId, state: 'completed' });
  }

  fail(
    binding: TaskStateLifecycleBinding,
    requestId: string,
    options: TaskTransitionOptions,
  ): TaskMetadataRecord {
    return this.append(binding, { ...options, requestId, state: 'failed' });
  }

  private install(pi: ExtensionAPI): void {
    pi.on('session_start', (event, ctx) => {
      this.handleSessionStart(event, ctx.sessionManager as SessionManager);
    });
    pi.on('session_shutdown', (event, ctx) => {
      this.handleSessionShutdown(event, ctx.sessionManager as SessionManager);
    });
    pi.on('session_tree', (_event, ctx) => {
      this.handleSessionTree(ctx.sessionManager as SessionManager);
    });
  }

  private handleSessionStart(event: SessionStartEvent, sessionManager: SessionManager): void {
    const sessionId = sessionManager.getSessionId();
    const previousBinding = this.activeBinding;
    const canReuseBinding =
      previousBinding !== undefined &&
      previousBinding.sessionManager === sessionManager &&
      previousBinding.sessionId === sessionId &&
      previousBinding.runtime.session === previousBinding.session &&
      previousBinding.session.sessionManager === sessionManager;
    const now = this.now();
    const inherited =
      sessionManager.getHeader()?.parentSession !== undefined || event.reason === 'fork';
    const superseded = inherited
      ? supersedeInheritedTaskMetadata(sessionManager, {
          runtimeId: this.options.runtimeId,
          reason: `session ${event.reason} replacement`,
          now,
        })
      : [];
    const recovered = recoverTaskMetadata(sessionManager, now);
    this.activeSessionManager = sessionManager;
    this.activeSessionId = sessionId;
    this.sessionActive = true;
    this.activeBinding = canReuseBinding ? previousBinding : undefined;
    this.activeTasks = new Map(recovered.map((record) => [record.requestId, record]));
    this._starts.push({ sessionId, reason: event.reason, recovered, superseded });
  }

  /** Re-scope recovered state when Pi navigates within the current session tree. */
  private handleSessionTree(sessionManager: SessionManager): void {
    if (this.activeSessionManager !== sessionManager || !this.sessionActive) {
      return;
    }
    const recovered = recoverTaskMetadata(sessionManager, this.now());
    this.activeTasks = new Map(recovered.map((record) => [record.requestId, record]));
  }

  private handleSessionShutdown(event: SessionShutdownEvent, sessionManager: SessionManager): void {
    const currentSession = this.activeSessionManager === sessionManager;
    const sessionId =
      currentSession && this.activeSessionId ? this.activeSessionId : sessionManager.getSessionId();
    this._shutdowns.push({
      sessionId,
      reason: event.reason,
      targetSessionFile: event.targetSessionFile,
    });
    // SessionManager can be reused by in-memory fork/branch operations and may
    // already expose the destination ID when the outgoing session shuts down.
    if (currentSession) {
      this.sessionActive = false;
      this.activeSessionId = undefined;
      this.activeSessionManager = undefined;
      this.activeTasks = new Map();
      if (event.reason !== 'reload') {
        this.activeBinding = undefined;
      }
    }
  }

  private assertActive(binding: TaskStateLifecycleBinding): void {
    if (
      !this.sessionActive ||
      this.activeBinding !== binding ||
      this.activeSessionManager !== binding.sessionManager ||
      this.activeSessionId !== binding.sessionId ||
      this.activeSessionManager.getSessionId() !== this.activeSessionId ||
      binding.sessionManager !== binding.session.sessionManager ||
      binding.sessionId !== binding.session.sessionId ||
      binding.runtime.session !== binding.session
    ) {
      throw new Error('p2p.task lifecycle runtime/session binding is no longer active');
    }
  }
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

export const appendP2PTaskMetadata = appendTaskMetadata;
export const foldLatestP2PTaskMetadata = foldLatestTaskMetadata;
export const recoverP2PTaskMetadata = recoverTaskMetadata;
export const supersedeInheritedP2PTaskMetadata = supersedeInheritedTaskMetadata;
export const createTaskStateLifecycle = (options: TaskStateLifecycleOptions): TaskStateLifecycle =>
  new TaskStateLifecycle(options);
