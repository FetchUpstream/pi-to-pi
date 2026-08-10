/**
 * Protocol-independent contracts for the local IPC transport.
 *
 * This module intentionally knows only about bounded byte payloads and transport
 * lifecycle. Pi protocol envelopes, routing, discovery, and runtime ownership
 * remain above this boundary.
 */

export const MAX_TIMER_DELAY_MS = 2_147_483_647;
export const DEFAULT_MAX_PAYLOAD_BYTES = 1024 * 1024;
export const DEFAULT_CONNECT_TIMEOUT_MS = 1_000;
export const DEFAULT_WRITE_TIMEOUT_MS = 1_000;
export const DEFAULT_READ_TIMEOUT_MS = 1_000;
export const DEFAULT_SHUTDOWN_TIMEOUT_MS = 1_000;
export const DEFAULT_FORCE_SHUTDOWN_TIMEOUT_MS = 250;
export const DEFAULT_STALE_PROBE_TIMEOUT_MS = 250;
export const DEFAULT_OVERALL_TIMEOUT_MS = 1_000;

export type TransportPayload = Uint8Array;

export type TransportHandler = (
  payload: TransportPayload,
) => TransportPayload | PromiseLike<TransportPayload>;

export interface TransportDeadline {
  readonly phase: string;
  readonly at: number;
}

export type TransportDeadlineInput = TransportDeadline | number;

export interface TransportRequestOptions {
  readonly connectTimeoutMs?: number;
  readonly writeTimeoutMs?: number;
  readonly readTimeoutMs?: number;
  readonly overallTimeoutMs?: number;
  readonly connectDeadline?: TransportDeadlineInput;
  readonly writeDeadline?: TransportDeadlineInput;
  readonly readDeadline?: TransportDeadlineInput;
  readonly overallDeadline?: TransportDeadlineInput;
  readonly signal?: AbortSignal;
}

export interface LocalIpcTransportOptions {
  readonly maxPayloadBytes?: number;
  readonly posixEndpointMaxBytes?: number;
  readonly connectTimeoutMs?: number;
  readonly writeTimeoutMs?: number;
  readonly readTimeoutMs?: number;
  readonly shutdownTimeoutMs?: number;
  readonly forceShutdownTimeoutMs?: number;
  readonly staleProbeTimeoutMs?: number;
  readonly overallTimeoutMs?: number;
}

export interface BoundTransportServer {
  readonly endpoint: string;
  close(): Promise<void>;
}

export interface LocalIpcTransport {
  bind(endpoint: string, handler: TransportHandler): Promise<BoundTransportServer>;
  request(
    endpoint: string,
    payload: TransportPayload,
    options?: TransportRequestOptions,
  ): Promise<TransportPayload>;
  close(): Promise<void>;
}

export type TransportErrorCode =
  | 'invalid-options'
  | 'invalid-endpoint'
  | 'connect-error'
  | 'connect-closed'
  | 'write-error'
  | 'write-closed'
  | 'read-error'
  | 'premature-close'
  | 'peer-closed'
  | 'handler-error'
  | 'endpoint-in-use'
  | 'endpoint-not-owned'
  | 'shutdown-error';

export class TransportError extends Error {
  public readonly code: TransportErrorCode;
  public readonly phase: string | undefined;

  public constructor(
    code: TransportErrorCode,
    message: string,
    options: { readonly cause?: unknown; readonly phase?: string } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'TransportError';
    this.code = code;
    this.phase = options.phase;
  }
}

export class TransportAbortError extends Error {
  public readonly code = 'ABORT_ERR';

  public constructor(message = 'The operation was aborted', cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'AbortError';
  }
}

export class TransportDeadlineExceededError extends Error {
  public readonly code = 'ERR_PHASE_DEADLINE_EXCEEDED';
  public readonly phase: string;
  public readonly deadline: number;

  public constructor(phase: string, deadline: number) {
    super(`Phase "${phase}" exceeded its deadline at ${deadline}`);
    this.name = 'PhaseDeadlineExceededError';
    this.phase = phase;
    this.deadline = deadline;
  }
}

/** Compatibility names for callers that use the shorter lifecycle vocabulary. */
export {
  TransportAbortError as AbortError,
  TransportDeadlineExceededError as PhaseDeadlineExceededError,
};
export { TransportError as LocalIpcError };
