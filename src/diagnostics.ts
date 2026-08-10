export const DIAGNOSTIC_MAX_TEXT = 128;
export const DIAGNOSTIC_EVENT_CAPACITY = 32;

export interface DiagnosticEvent {
  readonly timestamp: string;
  readonly component: 'lifecycle' | 'discovery' | 'router' | 'ipc';
  readonly name: string;
  readonly operation?: string;
  readonly code?: string;
  readonly requestId?: string;
  readonly traceId?: string;
  readonly runtimeId?: string;
  readonly peerRuntimeId?: string;
  readonly durationMs?: number;
}

export interface DiagnosticSnapshot {
  readonly timestamp: string;
  readonly packageVersion: string;
  readonly runtimeId: string;
  readonly roomId: string;
  readonly platform: string;
  readonly lifecycle: 'created' | 'started' | 'stopped';
  readonly operation?: string;
  readonly requestId?: string;
  readonly peerRuntimeId?: string;
  readonly taskState?: string;
  readonly queueDepth?: number;
  readonly events: readonly DiagnosticEvent[];
}

export interface DiagnosticEventSink {
  record(event: Omit<DiagnosticEvent, 'timestamp'>): void;
}

function text(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const normalized = value.replaceAll(/[\r\n\t]/g, ' ').trim();
  return normalized.length === 0 ? undefined : normalized.slice(0, DIAGNOSTIC_MAX_TEXT);
}

function number(value: number | undefined): number | undefined {
  return value !== undefined && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function event(value: DiagnosticEvent): DiagnosticEvent {
  return Object.freeze({
    timestamp: new Date(value.timestamp).toISOString(),
    component: value.component,
    name: text(value.name) ?? 'unknown',
    ...(text(value.operation) === undefined ? {} : { operation: text(value.operation) }),
    ...(text(value.code) === undefined ? {} : { code: text(value.code) }),
    ...(text(value.requestId) === undefined ? {} : { requestId: text(value.requestId) }),
    ...(text(value.traceId) === undefined ? {} : { traceId: text(value.traceId) }),
    ...(text(value.runtimeId) === undefined ? {} : { runtimeId: text(value.runtimeId) }),
    ...(text(value.peerRuntimeId) === undefined
      ? {}
      : { peerRuntimeId: text(value.peerRuntimeId) }),
    ...(number(value.durationMs) === undefined ? {} : { durationMs: number(value.durationMs) }),
  });
}

/** Fixed-size, allowlist-only runtime-local event history. */
export class DiagnosticEventRing implements DiagnosticEventSink {
  private readonly values: DiagnosticEvent[] = [];

  public constructor(private readonly capacity = DIAGNOSTIC_EVENT_CAPACITY) {
    if (!Number.isSafeInteger(capacity) || capacity <= 0)
      throw new RangeError('capacity must be positive');
  }

  public record(input: Omit<DiagnosticEvent, 'timestamp'>): void {
    try {
      this.values.push(event({ ...input, timestamp: new Date().toISOString() }));
      if (this.values.length > this.capacity) this.values.shift();
    } catch {
      // Diagnostics are deliberately best effort.
    }
  }

  public clear(): void {
    this.values.splice(0);
  }

  public list(): readonly DiagnosticEvent[] {
    return Object.freeze([...this.values]);
  }
}

export function formatDiagnosticSnapshot(
  input: Omit<DiagnosticSnapshot, 'events'> & { events: readonly DiagnosticEvent[] },
): DiagnosticSnapshot {
  return Object.freeze({
    timestamp: new Date(input.timestamp).toISOString(),
    packageVersion: text(input.packageVersion) ?? 'unknown',
    runtimeId: text(input.runtimeId) ?? 'unknown',
    roomId: text(input.roomId) ?? 'unknown',
    platform: text(input.platform) ?? 'unknown',
    lifecycle: input.lifecycle,
    ...(text(input.operation) === undefined ? {} : { operation: text(input.operation) }),
    ...(text(input.requestId) === undefined ? {} : { requestId: text(input.requestId) }),
    ...(text(input.peerRuntimeId) === undefined
      ? {}
      : { peerRuntimeId: text(input.peerRuntimeId) }),
    ...(text(input.taskState) === undefined ? {} : { taskState: text(input.taskState) }),
    ...(number(input.queueDepth) === undefined ? {} : { queueDepth: number(input.queueDepth) }),
    events: Object.freeze(input.events.map(event)),
  });
}
