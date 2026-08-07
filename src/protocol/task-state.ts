import type { Content, RequestId, UtcTimestamp } from './messages.js';
import type { ProtocolError } from './errors.js';

export const TASK_STATES = [
  'created',
  'accepted',
  'queued',
  'working',
  'cancelling',
  'completed',
  'failed',
  'rejected',
  'cancelled',
  'expired',
] as const;

export type TaskState = (typeof TASK_STATES)[number];
export type TaskLifecycleState = TaskState;

export const TERMINAL_OUTCOMES = [
  'completed',
  'failed',
  'rejected',
  'cancelled',
  'expired',
] as const;

export type TerminalOutcome = (typeof TERMINAL_OUTCOMES)[number];
export type TaskOutcome = TerminalOutcome;

export type NonTerminalTaskState = Exclude<
  TaskState,
  'completed' | 'failed' | 'rejected' | 'cancelled' | 'expired'
>;
export type TerminalTaskState = Exclude<TaskState, NonTerminalTaskState>;

/** The cancellation request marker is separate from the public task state. */
export type CancellationState = 'not_requested' | 'requested';
export type CancellationStatus = CancellationState;

export interface CancellationSnapshot {
  readonly state: CancellationState;
  readonly requestedAt?: UtcTimestamp;
}

/**
 * The only legal state transitions in v1.  `created` is sender-local; a
 * receiver starts an admitted task at `accepted` and may then queue it.
 */
export const TASK_STATE_TRANSITIONS: Readonly<{
  [State in TaskState]: readonly TaskState[];
}> = {
  created: ['accepted', 'rejected', 'expired'],
  accepted: ['queued', 'working', 'rejected', 'cancelling', 'cancelled', 'expired'],
  queued: ['working', 'rejected', 'cancelling', 'cancelled', 'expired'],
  working: ['completed', 'failed', 'rejected', 'cancelling', 'expired'],
  cancelling: ['cancelled', 'completed', 'failed', 'expired'],
  completed: [],
  failed: [],
  rejected: [],
  cancelled: [],
  expired: [],
};

export const LEGAL_TASK_TRANSITIONS = TASK_STATE_TRANSITIONS;

export function canTransitionTaskState(from: TaskState, to: TaskState): boolean {
  return TASK_STATE_TRANSITIONS[from].includes(to);
}

export function isTerminalTaskState(state: TaskState): state is TerminalTaskState {
  return TERMINAL_OUTCOMES.some((outcome) => outcome === state);
}

export const isTerminalState = isTerminalTaskState;

export function isTerminalOutcome(outcome: string): outcome is TerminalOutcome {
  return TERMINAL_OUTCOMES.some((candidate) => candidate === outcome);
}

export interface TaskSnapshot {
  readonly requestId: RequestId;
  readonly state: TaskState;
  readonly createdAt: UtcTimestamp;
  readonly updatedAt: UtcTimestamp;
  readonly expiresAt: UtcTimestamp;
  /** True once a cancellation request has been accepted for this task. */
  readonly cancellationRequested: boolean;
  readonly cancellation?: CancellationSnapshot;
  readonly terminalOutcome?: TerminalOutcome;
  readonly content?: Content;
  readonly error?: ProtocolError;
}

export type TaskStateSnapshot = TaskSnapshot;

export interface TerminalTaskSnapshot extends TaskSnapshot {
  readonly state: TerminalTaskState;
  readonly terminalOutcome: TerminalOutcome;
}
