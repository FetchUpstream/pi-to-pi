import type {
  AgentSessionEvent,
  ExtensionAPI,
  ExtensionContext,
  InlineExtension,
  MessageStartEvent,
  SessionShutdownEvent,
  SessionStartEvent,
} from '@earendil-works/pi-coding-agent';
import type { SessionEntry, SessionManager } from '@earendil-works/pi-coding-agent';

export type PiProbeObservationType =
  | 'extension_factory'
  | 'session_start'
  | 'session_info_changed'
  | 'session_shutdown'
  | 'agent_start'
  | 'agent_end'
  | 'agent_settled'
  | 'custom_message_start'
  | 'custom_message_end'
  | 'queue_update'
  | 'entry_appended'
  | 'extension_error';

export interface PiProbeObservation {
  sequence: number;
  type: PiProbeObservationType;
  sessionId?: string;
  sessionFile?: string;
  sessionName?: string;
  reason?: SessionStartEvent['reason'] | SessionShutdownEvent['reason'];
  previousSessionFile?: string;
  targetSessionFile?: string;
  idle?: boolean;
  hasPendingMessages?: boolean;
  customType?: string;
  details?: unknown;
  message?: MessageStartEvent['message'];
  entries?: SessionEntry[];
  steering?: readonly string[];
  followUp?: readonly string[];
  error?: unknown;
}

export interface PiProbe {
  readonly observations: readonly PiProbeObservation[];
  readonly factoryLoads: number;
  readonly events: readonly PiProbeObservation[];
  readonly extension: InlineExtension;
  recordSessionEvent(event: AgentSessionEvent, sessionManager: SessionManager): void;
  recordError(error: unknown): void;
  clear(): void;
  byType(type: PiProbeObservationType): PiProbeObservation[];
  latest(type: PiProbeObservationType): PiProbeObservation | undefined;
}

function copy<T>(value: T): T {
  try {
    return structuredClone(value);
  } catch {
    return value;
  }
}

function sessionSnapshot(
  ctx: ExtensionContext,
): Pick<PiProbeObservation, 'sessionId' | 'sessionFile' | 'sessionName'> {
  return {
    sessionId: ctx.sessionManager.getSessionId(),
    sessionFile: ctx.sessionManager.getSessionFile(),
    sessionName: ctx.sessionManager.getSessionName(),
  };
}

function entriesSnapshot(ctx: ExtensionContext): SessionEntry[] {
  return copy(ctx.sessionManager.getEntries());
}

function isCustomMessage(
  message: MessageStartEvent['message'],
): message is MessageStartEvent['message'] & {
  role: 'custom';
  customType: string;
  details?: unknown;
} {
  return message.role === 'custom';
}

class Probe implements PiProbe {
  private readonly recorded: PiProbeObservation[] = [];
  private sequence = 0;
  private _factoryLoads = 0;

  readonly extension: InlineExtension = {
    name: 'pi-p2p-test-probe',
    hidden: true,
    factory: (pi) => this.install(pi),
  };

  get observations(): readonly PiProbeObservation[] {
    return this.recorded;
  }

  get events(): readonly PiProbeObservation[] {
    return this.recorded;
  }

  get factoryLoads(): number {
    return this._factoryLoads;
  }

  install(pi: ExtensionAPI): void {
    this._factoryLoads += 1;
    this.record({ type: 'extension_factory' });

    pi.on('session_start', (event, ctx) => {
      this.record({
        type: 'session_start',
        ...sessionSnapshot(ctx),
        sessionName: pi.getSessionName(),
        reason: event.reason,
        previousSessionFile: event.previousSessionFile,
        idle: ctx.isIdle(),
        hasPendingMessages: ctx.hasPendingMessages(),
        entries: entriesSnapshot(ctx),
      });
    });

    pi.on('session_info_changed', (event, ctx) => {
      this.record({
        type: 'session_info_changed',
        ...sessionSnapshot(ctx),
        sessionName: event.name,
        idle: ctx.isIdle(),
        hasPendingMessages: ctx.hasPendingMessages(),
        entries: entriesSnapshot(ctx),
      });
    });

    pi.on('session_shutdown', (event, ctx) => {
      this.record({
        type: 'session_shutdown',
        ...sessionSnapshot(ctx),
        reason: event.reason,
        targetSessionFile: event.targetSessionFile,
        idle: ctx.isIdle(),
        hasPendingMessages: ctx.hasPendingMessages(),
        entries: entriesSnapshot(ctx),
      });
    });

    pi.on('agent_start', (_event, ctx) => {
      this.record({
        type: 'agent_start',
        ...sessionSnapshot(ctx),
        idle: ctx.isIdle(),
        hasPendingMessages: ctx.hasPendingMessages(),
        entries: entriesSnapshot(ctx),
      });
    });

    pi.on('agent_end', (_event, ctx) => {
      this.record({
        type: 'agent_end',
        ...sessionSnapshot(ctx),
        idle: ctx.isIdle(),
        hasPendingMessages: ctx.hasPendingMessages(),
        entries: entriesSnapshot(ctx),
      });
    });

    pi.on('agent_settled', (_event, ctx) => {
      this.record({
        type: 'agent_settled',
        ...sessionSnapshot(ctx),
        idle: ctx.isIdle(),
        hasPendingMessages: ctx.hasPendingMessages(),
        entries: entriesSnapshot(ctx),
      });
    });

    pi.on('message_start', (event, ctx) => {
      if (!isCustomMessage(event.message)) {
        return;
      }
      this.record({
        type: 'custom_message_start',
        ...sessionSnapshot(ctx),
        customType: event.message.customType,
        details: copy(event.message.details),
        message: copy(event.message),
        idle: ctx.isIdle(),
        hasPendingMessages: ctx.hasPendingMessages(),
        entries: entriesSnapshot(ctx),
      });
    });

    pi.on('message_end', (event, ctx) => {
      if (!isCustomMessage(event.message)) {
        return;
      }
      this.record({
        type: 'custom_message_end',
        ...sessionSnapshot(ctx),
        customType: event.message.customType,
        details: copy(event.message.details),
        message: copy(event.message),
        idle: ctx.isIdle(),
        hasPendingMessages: ctx.hasPendingMessages(),
        entries: entriesSnapshot(ctx),
      });
    });
  }

  recordSessionEvent(event: AgentSessionEvent, sessionManager: SessionManager): void {
    if (event.type === 'queue_update') {
      this.record({
        type: 'queue_update',
        ...this.sessionSnapshot(sessionManager),
        steering: copy(event.steering),
        followUp: copy(event.followUp),
        entries: copy(sessionManager.getEntries()),
      });
      return;
    }

    if (event.type === 'entry_appended') {
      this.record({
        type: 'entry_appended',
        ...this.sessionSnapshot(sessionManager),
        entries: copy(sessionManager.getEntries()),
      });
    }
  }

  recordError(error: unknown): void {
    this.record({ type: 'extension_error', error: copy(error) });
  }

  clear(): void {
    this.recorded.length = 0;
    this.sequence = 0;
  }

  byType(type: PiProbeObservationType): PiProbeObservation[] {
    return this.recorded.filter((observation) => observation.type === type);
  }

  latest(type: PiProbeObservationType): PiProbeObservation | undefined {
    const observations = this.byType(type);
    return observations.at(-1);
  }

  private sessionSnapshot(
    sessionManager: SessionManager,
  ): Pick<PiProbeObservation, 'sessionId' | 'sessionFile' | 'sessionName'> {
    return {
      sessionId: sessionManager.getSessionId(),
      sessionFile: sessionManager.getSessionFile(),
      sessionName: sessionManager.getSessionName(),
    };
  }

  private record(observation: Omit<PiProbeObservation, 'sequence'>): void {
    this.recorded.push({ sequence: this.sequence++, ...observation });
  }
}

export function createPiProbe(): PiProbe {
  return new Probe();
}

export function createInlineProbeExtension(probe: PiProbe): InlineExtension {
  return probe.extension;
}

export async function bindPiProbe(
  session: {
    bindExtensions(bindings: {
      mode?: 'tui' | 'rpc' | 'json' | 'print';
      onError?: (error: {
        extensionPath: string;
        event: string;
        error: string;
        stack?: string;
      }) => void;
    }): Promise<void>;
  },
  probe: PiProbe,
): Promise<void> {
  await session.bindExtensions({
    mode: 'print',
    onError: (error) => probe.recordError(error),
  });
}

export const createProbeExtension = createInlineProbeExtension;
export const rebindProbeSession = bindPiProbe;
