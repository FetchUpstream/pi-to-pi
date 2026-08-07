import type { SessionEntry, SessionManager } from '@earendil-works/pi-coding-agent';

interface TaskSessionReader {
  getSessionId(): string;
  getBranch(): SessionEntry[];
}

export const P2P_TASK_CUSTOM_TYPE = 'p2p.task';
export const P2P_TASK_METADATA_VERSION = 1;

export const TASK_STATES = ['accepted', 'completed', 'failed', 'expired', 'superseded'] as const;

export type TaskState = (typeof TASK_STATES)[number];

export interface TaskMetadata {
  version: typeof P2P_TASK_METADATA_VERSION;
  requestId: string;
  /** Session scope that owns this append-only state record. */
  sessionId: string;
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
  runtimeId: string;
  state: TaskState;
  sessionId?: string;
  peerId?: string | null;
  updatedAt?: string;
  expiresAt?: string | null;
  reason?: string | null;
}

export interface SupersedeInheritedTaskMetadataOptions {
  runtimeId: string;
  reason: string;
  peerId?: string | null;
  updatedAt?: string;
}

const TERMINAL_TASK_STATES: ReadonlySet<TaskState> = new Set([
  'completed',
  'failed',
  'expired',
  'superseded',
]);

const BODY_FIELD_NAMES = new Set([
  'body',
  'content',
  'message',
  'request',
  'requestBody',
  'response',
  'responseBody',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isTimestamp(value: unknown): value is string {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value));
}

function assertNonEmptyString(value: string, field: string): void {
  if (value.trim().length === 0) {
    throw new Error(`p2p.task ${field} must not be empty`);
  }
}

function assertNoTaskBody(value: unknown): void {
  if (!isRecord(value)) {
    return;
  }
  const bodyField = Object.keys(value).find((key) => BODY_FIELD_NAMES.has(key));
  if (bodyField) {
    throw new Error(`p2p.task metadata must not contain message bodies (${bodyField})`);
  }
}

function isTaskState(value: unknown): value is TaskState {
  return typeof value === 'string' && (TASK_STATES as readonly string[]).includes(value);
}

function isTaskMetadata(value: unknown): value is TaskMetadata {
  if (!isRecord(value)) {
    return false;
  }
  if (Object.keys(value).some((key) => BODY_FIELD_NAMES.has(key))) {
    return false;
  }
  return (
    value.version === P2P_TASK_METADATA_VERSION &&
    typeof value.requestId === 'string' &&
    value.requestId.trim().length > 0 &&
    typeof value.sessionId === 'string' &&
    value.sessionId.trim().length > 0 &&
    typeof value.runtimeId === 'string' &&
    value.runtimeId.trim().length > 0 &&
    (value.peerId === null || typeof value.peerId === 'string') &&
    isTaskState(value.state) &&
    isTimestamp(value.updatedAt) &&
    (value.expiresAt === null || isTimestamp(value.expiresAt)) &&
    (value.reason === null || typeof value.reason === 'string') &&
    (value.state !== 'superseded' ||
      (typeof value.reason === 'string' && value.reason.trim().length > 0))
  );
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

export function isTerminalTaskState(state: TaskState): boolean {
  return TERMINAL_TASK_STATES.has(state);
}

export function isTaskExpired(record: TaskMetadata, now: Date): boolean {
  return record.expiresAt !== null && Date.parse(record.expiresAt) <= now.getTime();
}

/**
 * Append one compact state record. The only persisted payload is p2p.task
 * metadata; request and response bodies belong to custom-message entries.
 */
export function appendTaskMetadata(
  sessionManager: SessionManager,
  options: AppendTaskMetadataOptions,
): TaskMetadataRecord {
  assertNoTaskBody(options);
  assertNonEmptyString(options.requestId, 'requestId');
  assertNonEmptyString(options.runtimeId, 'runtimeId');

  const sessionId = options.sessionId ?? sessionManager.getSessionId();
  const peerId = options.peerId ?? null;
  const updatedAt = options.updatedAt ?? new Date().toISOString();
  const expiresAt = options.expiresAt ?? null;
  const reason = options.reason ?? null;

  assertNonEmptyString(sessionId, 'sessionId');
  if (!isTimestamp(updatedAt)) {
    throw new Error('p2p.task updatedAt must be an ISO timestamp');
  }
  if (expiresAt !== null && !isTimestamp(expiresAt)) {
    throw new Error('p2p.task expiresAt must be an ISO timestamp or null');
  }
  if (options.state === 'superseded' && (!reason || reason.trim().length === 0)) {
    throw new Error('p2p.task superseded records require a reason');
  }
  if (options.state !== 'superseded' && reason !== null) {
    throw new Error('p2p.task reason is only valid for superseded records');
  }

  const previous = foldLatestTaskMetadata(sessionManager).get(options.requestId);
  if (previous && isTerminalTaskState(previous.state) && previous.state !== options.state) {
    throw new Error(
      `p2p.task ${options.requestId} is already terminal (${previous.state}) and cannot transition to ${options.state}`,
    );
  }

  const metadata: TaskMetadata = {
    version: P2P_TASK_METADATA_VERSION,
    requestId: options.requestId,
    sessionId,
    runtimeId: options.runtimeId,
    peerId,
    state: options.state,
    updatedAt,
    expiresAt,
    reason,
  };
  const entryId = sessionManager.appendCustomEntry(P2P_TASK_CUSTOM_TYPE, metadata);
  return { ...metadata, entryId };
}

/**
 * Fold the active append-only branch by request ID. Later records replace
 * earlier records for the same request; no transcript position is consulted.
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

/**
 * Recover only live task state owned by the selected session. Reload may reuse
 * the session identity, while /new, /resume, fork, and clone must not migrate
 * an outgoing in-memory task map into another session.
 */
export function recoverTaskMetadata(
  sessionManager: TaskSessionReader,
  now: Date = new Date(),
): TaskMetadataRecord[] {
  const sessionId = sessionManager.getSessionId();
  return [...foldLatestTaskMetadata(sessionManager).values()].filter(
    (record) =>
      record.sessionId === sessionId &&
      !isTerminalTaskState(record.state) &&
      !isTaskExpired(record, now),
  );
}

/**
 * Mark copied, non-terminal records from another session as inherited history. The
 * superseding record is written in the destination session and blocks later
 * completion attempts through appendTaskMetadata's terminal-state guard.
 */
export function supersedeInheritedTaskMetadata(
  sessionManager: SessionManager,
  options: SupersedeInheritedTaskMetadataOptions,
): TaskMetadataRecord[] {
  assertNonEmptyString(options.runtimeId, 'runtimeId');
  assertNonEmptyString(options.reason, 'superseded reason');
  const currentSessionId = sessionManager.getSessionId();
  const inherited = [...foldLatestTaskMetadata(sessionManager).values()].filter(
    (record) => record.sessionId !== currentSessionId && !isTerminalTaskState(record.state),
  );

  return inherited.map((record) =>
    appendTaskMetadata(sessionManager, {
      requestId: record.requestId,
      runtimeId: options.runtimeId,
      sessionId: currentSessionId,
      peerId: options.peerId ?? record.peerId,
      state: 'superseded',
      updatedAt: options.updatedAt,
      expiresAt: record.expiresAt,
      reason: options.reason,
    }),
  );
}

export const appendP2PTaskMetadata = appendTaskMetadata;
export const foldLatestP2PTaskMetadata = foldLatestTaskMetadata;
export const recoverP2PTaskMetadata = recoverTaskMetadata;
export const supersedeInheritedP2PTaskMetadata = supersedeInheritedTaskMetadata;
