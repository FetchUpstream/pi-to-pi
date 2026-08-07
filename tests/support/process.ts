import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { basename, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  BoundedOutput,
  type BoundedOutputOptions,
  type CapturedOutput,
  DEFAULT_MAX_JSON_LINE_BYTES,
  formatProcessDiagnostics,
  type ProcessDiagnostics,
  type ProcessIdentity,
  JsonLinesParseError,
  JsonLinesParser,
} from './output.js';
import type { TestWorkspace } from './workspace.js';

/** Absolute path to the portable lifecycle fixture shipped with the test suite. */
export const LIFECYCLE_FIXTURE_PATH = fileURLToPath(
  new URL('../fixtures/lifecycle.mjs', import.meta.url),
);

/** Alias retained for callers that use the shorter fixture name. */
export const DEFAULT_LIFECYCLE_FIXTURE_PATH = LIFECYCLE_FIXTURE_PATH;

export const DEFAULT_MANAGED_PROCESS_TIMEOUT_MS = 5_000;
export const DEFAULT_MANAGED_PROCESS_KILL_TIMEOUT_MS = 2_000;
export const DEFAULT_MANAGED_PROCESS_COMMAND_TIMEOUT_MS = 5_000;
export const DEFAULT_MAX_MANAGED_PROCESS_COMMAND_BYTES = DEFAULT_MAX_JSON_LINE_BYTES;
export const DEFAULT_MAX_MANAGED_PROCESS_EVENTS = 1_024;
export type ManagedProcessEvent = Record<string, unknown>;

export type ManagedProcessState = 'starting' | 'running' | 'exited' | 'closed' | 'failed';

export interface ManagedProcessExit {
  /** Node's exit code, or `null` when the child was terminated by a signal. */
  readonly code: number | null;
  /** Alias for `code` matching the diagnostics helper terminology. */
  readonly exitCode: number | null;
  /** Signal reported by Node, or `null` for a normal exit. */
  readonly signal: NodeJS.Signals | null;
  /** Spawn failure, if Node reported one for this child. */
  readonly spawnError?: unknown;
  /** Alias for `spawnError` for callers using the child-process vocabulary. */
  readonly error?: unknown;
  readonly identity: ProcessIdentity;
  readonly state: ManagedProcessState;
  readonly output: CapturedOutput;
  readonly stdout: string;
  readonly stderr: string;
}

export interface ManagedProcessWaitOptions {
  /** Maximum time to wait before the child is terminated and the wait rejects. */
  readonly timeoutMs?: number;
  /** Description included in timeout and lifecycle failure diagnostics. */
  readonly description?: string;
}

export interface KillAbruptlyOptions {
  /** Maximum time allowed for the termination command and child close observation. */
  readonly timeoutMs?: number;
}
export type ManagedProcessWorkspace = Pick<TestWorkspace, 'registerBeforeCleanup'> &
  Partial<Pick<TestWorkspace, 'env'>>;

export interface ManagedProcessOptions {
  /** Absolute `.mjs` fixture path. Defaults to the portable lifecycle fixture. */
  readonly fixturePath?: string;
  /** Arguments passed after the fixture path. */
  readonly args?: readonly string[];
  /** Working directory for the fixture process. */
  readonly cwd?: string;
  /** Environment additions. The parent environment is retained and never mutated. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Human-readable process label used in diagnostics. */
  readonly label?: string;
  /** Per-stream bounded output limits. */
  readonly output?: BoundedOutputOptions;
  /** Maximum retained lifecycle events. Events remain bounded even if a fixture is noisy. */
  readonly maxEvents?: number;
  /** Default wait deadline for readiness, event, exit, and close observations. */
  readonly timeoutMs?: number;
  /** Deadline for one command write to complete. */
  readonly commandTimeoutMs?: number;
  /** Maximum UTF-8 bytes in one JSON command, excluding its newline. */
  readonly maxCommandBytes?: number;
  /** Default deadline for abrupt termination. */
  readonly killTimeoutMs?: number;
  /** Registers teardown before workspace removal when supplied. */
  readonly workspace?: ManagedProcessWorkspace;
}

export interface ManagedProcessGroupOptions {
  /** Registers group teardown before workspace removal when supplied. */
  readonly workspace?: ManagedProcessWorkspace;
}

export class ManagedProcessTimeoutError extends Error {
  readonly code = 'ERR_MANAGED_PROCESS_TIMEOUT';
  readonly timeoutMs: number;
  readonly description: string;
  readonly identity: ProcessIdentity;
  readonly diagnostics: ProcessDiagnostics;

  constructor(options: {
    readonly timeoutMs: number;
    readonly description: string;
    readonly diagnostics: ProcessDiagnostics;
  }) {
    const timeoutContext = `Timed out ${options.description} after ${options.timeoutMs}ms`;
    super(
      `${timeoutContext}.\nTimeout context: ${options.description}\n${formatProcessDiagnostics(options.diagnostics)}`,
    );
    this.name = 'ManagedProcessTimeoutError';
    this.timeoutMs = options.timeoutMs;
    this.description = options.description;
    this.identity = options.diagnostics.identity ?? 'unknown process';
    this.diagnostics = options.diagnostics;
  }
}

export class ManagedProcessClosedError extends Error {
  readonly code: string = 'ERR_MANAGED_PROCESS_CLOSED';
  readonly identity: ProcessIdentity;
  readonly diagnostics: ProcessDiagnostics;

  constructor(options: {
    readonly identity: ProcessIdentity;
    readonly diagnostics: ProcessDiagnostics;
    readonly description: string;
    readonly message?: string;
  }) {
    super(
      options.message ??
        `${options.description} before the expected lifecycle observation.\n${formatProcessDiagnostics(
          options.diagnostics,
        )}`,
      { cause: options.diagnostics.spawnError },
    );
    this.name = 'ManagedProcessClosedError';
    this.identity = options.identity;
    this.diagnostics = options.diagnostics;
  }
}

export class ManagedProcessSpawnError extends ManagedProcessClosedError {
  readonly code = 'ERR_MANAGED_PROCESS_SPAWN';
  readonly spawnError: unknown;

  constructor(options: {
    readonly identity: ProcessIdentity;
    readonly diagnostics: ProcessDiagnostics;
    readonly spawnError: unknown;
  }) {
    super({
      description: 'The fixture failed to spawn',
      diagnostics: options.diagnostics,
      identity: options.identity,
      message: `Unable to start ${formatIdentity(options.identity)}.\n${formatProcessDiagnostics(
        options.diagnostics,
      )}`,
    });
    this.name = 'ManagedProcessSpawnError';
    this.spawnError = options.spawnError;
  }
}

export class ManagedProcessCommandTimeoutError extends Error {
  readonly code = 'ERR_MANAGED_PROCESS_COMMAND_TIMEOUT';
  readonly timeoutMs: number;
  readonly identity: ProcessIdentity;
  readonly diagnostics: ProcessDiagnostics;

  constructor(options: {
    readonly identity: ProcessIdentity;
    readonly diagnostics: ProcessDiagnostics;
    readonly timeoutMs: number;
  }) {
    super(
      `Timed out sending a command to ${formatIdentity(options.identity)} after ${options.timeoutMs}ms.\n${formatProcessDiagnostics(
        options.diagnostics,
      )}`,
    );
    this.name = 'ManagedProcessCommandTimeoutError';
    this.timeoutMs = options.timeoutMs;
    this.identity = options.identity;
    this.diagnostics = options.diagnostics;
  }
}

export class ManagedProcessCommandError extends Error {
  readonly code = 'ERR_MANAGED_PROCESS_COMMAND';
  readonly identity: ProcessIdentity;
  readonly diagnostics: ProcessDiagnostics;

  constructor(options: {
    readonly identity: ProcessIdentity;
    readonly diagnostics: ProcessDiagnostics;
    readonly cause: unknown;
  }) {
    super(
      `Unable to send a command to ${formatIdentity(options.identity)}.\n${formatProcessDiagnostics(
        options.diagnostics,
      )}`,
      { cause: options.cause },
    );
    this.name = 'ManagedProcessCommandError';
    this.identity = options.identity;
    this.diagnostics = options.diagnostics;
  }
}

interface EventWaiter<TEvent> {
  readonly predicate: (event: TEvent) => boolean;
  readonly resolve: (event: TEvent) => void;
  readonly reject: (error: unknown) => void;
}

interface PendingCommandWrite {
  readonly cancel: (error: unknown) => void;
}

interface NormalizedWaitOptions {
  readonly timeoutMs: number;
  readonly description: string;
}

/**
 * Owns one standalone Node fixture process and all of the resources used to observe it.
 *
 * The class deliberately speaks only a JSON-lines lifecycle protocol. It does not import or
 * depend on any Pi-to-Pi protocol, transport, registry, or daemon implementation.
 */
export class ManagedProcess<TEvent = ManagedProcessEvent> {
  readonly child: ChildProcessWithoutNullStreams;
  readonly fixturePath: string;
  readonly args: readonly string[];
  readonly outputBuffer: BoundedOutput;

  private readonly label: string;
  private readonly defaultTimeoutMs: number;
  private readonly defaultCommandTimeoutMs: number;
  private readonly maxCommandBytes: number;
  private readonly defaultKillTimeoutMs: number;
  private readonly maxEvents: number;
  private readonly eventParser: JsonLinesParser<TEvent>;
  private readonly eventHistory: TEvent[] = [];
  private readonly eventWaiters = new Set<EventWaiter<TEvent>>();
  private readonly pendingCommandWrites = new Set<PendingCommandWrite>();
  private readonly exitPromise: Promise<ManagedProcessExit>;
  private readonly closePromise: Promise<ManagedProcessExit>;
  private resolveExit!: (result: ManagedProcessExit) => void;
  private resolveClose!: (result: ManagedProcessExit) => void;
  private exitResult: ManagedProcessExit | undefined;
  private closeResult: ManagedProcessExit | undefined;
  private processError: unknown;
  private parserError: JsonLinesParseError | undefined;
  private lifecycleState: ManagedProcessState = 'starting';
  private teardownStarted = false;
  private resourcesDetached = false;
  private workspaceUnregister: (() => void) | undefined;
  private killPromise: Promise<ManagedProcessExit> | undefined;
  private cleanupPromise: Promise<ManagedProcessExit> | undefined;
  private readonly stdoutListener = (chunk: Buffer | string): void => {
    this.handleStdout(chunk);
  };
  private readonly stderrListener = (chunk: Buffer | string): void => {
    this.outputBuffer.appendStderr(chunk);
  };
  private readonly stdinErrorListener = (): void => {};
  private readonly childErrorListener = (error: unknown): void => {
    this.handleChildError(error);
  };
  private readonly childExitListener = (
    code: number | null,
    signal: NodeJS.Signals | null,
  ): void => {
    this.handleChildExit(code, signal);
  };
  private readonly childCloseListener = (
    code: number | null,
    signal: NodeJS.Signals | null,
  ): void => {
    this.handleChildClose(code, signal);
  };
  private readonly childSpawnListener = (): void => {
    if (this.lifecycleState === 'starting') {
      this.lifecycleState = 'running';
    }
  };

  constructor(options: ManagedProcessOptions = {}) {
    const fixturePath = options.fixturePath ?? LIFECYCLE_FIXTURE_PATH;
    if (!isAbsolute(fixturePath)) {
      throw new TypeError(`managed fixture path must be absolute; received ${fixturePath}`);
    }

    this.fixturePath = fixturePath;
    this.args = [...(options.args ?? [])];
    this.label = options.label ?? basename(fixturePath);
    this.defaultTimeoutMs = validateDuration(
      options.timeoutMs ?? DEFAULT_MANAGED_PROCESS_TIMEOUT_MS,
      'managed process timeout',
    );
    this.defaultCommandTimeoutMs = validateDuration(
      options.commandTimeoutMs ?? options.timeoutMs ?? DEFAULT_MANAGED_PROCESS_COMMAND_TIMEOUT_MS,
      'managed process command timeout',
    );
    this.maxCommandBytes = validatePositiveInteger(
      options.maxCommandBytes ?? DEFAULT_MAX_MANAGED_PROCESS_COMMAND_BYTES,
      'maximum managed process command bytes',
    );
    this.defaultKillTimeoutMs = validateDuration(
      options.killTimeoutMs ?? DEFAULT_MANAGED_PROCESS_KILL_TIMEOUT_MS,
      'managed process kill timeout',
    );
    this.maxEvents = validateNonNegativeInteger(
      options.maxEvents ?? DEFAULT_MAX_MANAGED_PROCESS_EVENTS,
      'maximum managed process events',
    );
    this.outputBuffer = new BoundedOutput(options.output);
    const parserIdentity: { label: string; pid?: number } = { label: this.label };
    this.eventParser = new JsonLinesParser<TEvent>({
      getOutput: () => this.output,
      identity: parserIdentity,
    });
    this.exitPromise = new Promise<ManagedProcessExit>((resolve) => {
      this.resolveExit = resolve;
    });
    this.closePromise = new Promise<ManagedProcessExit>((resolve) => {
      this.resolveClose = resolve;
    });
    const env = { ...process.env, ...options.workspace?.env, ...options.env };

    // Reserve workspace ownership before spawning. Because construction is synchronous,
    // cleanup can now observe either this hook or no child at all, never a live unowned child.
    if (options.workspace) {
      this.workspaceUnregister = options.workspace.registerBeforeCleanup(() =>
        this.cleanup().then(() => undefined),
      );
    }

    try {
      this.child = spawn(process.execPath, [this.fixturePath, ...this.args], {
        cwd: options.cwd,
        env,
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      this.workspaceUnregister?.();
      this.workspaceUnregister = undefined;
      throw error;
    }
    parserIdentity.pid = this.child.pid;
    this.attachListeners();
  }

  /** The child process id, when Node assigned one. */
  get pid(): number | undefined {
    return this.child.pid;
  }

  /** Stable process identity used by diagnostics and lifecycle errors. */
  get identity(): ProcessIdentity {
    return { label: this.label, pid: this.child.pid };
  }

  get state(): ManagedProcessState {
    return this.lifecycleState;
  }

  get exitCode(): number | null {
    return this.exitResult?.code ?? this.child.exitCode;
  }

  get signal(): NodeJS.Signals | null {
    return this.exitResult?.signal ?? this.child.signalCode;
  }

  get spawnError(): unknown {
    return this.processError;
  }

  get error(): unknown {
    return this.processError;
  }

  get stdin(): ChildProcessWithoutNullStreams['stdin'] {
    return this.child.stdin;
  }

  get stdout(): ChildProcessWithoutNullStreams['stdout'] {
    return this.child.stdout;
  }

  get stderr(): ChildProcessWithoutNullStreams['stderr'] {
    return this.child.stderr;
  }

  get output(): CapturedOutput {
    return this.outputBuffer.snapshot();
  }

  get capturedOutput(): CapturedOutput {
    return this.output;
  }

  get events(): readonly TEvent[] {
    return [...this.eventHistory];
  }

  get diagnostics(): ProcessDiagnostics {
    return this.getDiagnostics();
  }

  /** Returns an up-to-date bounded diagnostic snapshot. */
  getDiagnostics(): ProcessDiagnostics {
    return {
      identity: this.identity,
      state: this.lifecycleState,
      exitCode: this.exitCode,
      signal: this.signal,
      spawnError: this.processError,
      output: this.output,
    };
  }

  getProcessDiagnostics(): ProcessDiagnostics {
    return this.getDiagnostics();
  }

  formatDiagnostics(context?: string): string {
    const prefix = context ? `Context: ${context}\n` : '';
    return `${prefix}${formatProcessDiagnostics(this.getDiagnostics())}`;
  }

  /** Waits for the fixture's `ready` lifecycle event. */
  waitForReady(options: ManagedProcessWaitOptions | number = {}): Promise<TEvent> {
    return this.waitForEvent(
      (event) => {
        if (event === null || typeof event !== 'object' || Array.isArray(event)) {
          return false;
        }
        const value = event as ManagedProcessEvent;
        return value.event === 'ready' || value.type === 'ready';
      },
      normalizeWaitOptions(options, 'the fixture ready event', this.defaultTimeoutMs),
    );
  }

  /** Waits for an arbitrary parsed JSON-lines event without fixed sleeps or polling. */
  waitForEvent(
    predicate: (event: TEvent) => boolean,
    options: ManagedProcessWaitOptions | number = {},
  ): Promise<TEvent> {
    if (typeof predicate !== 'function') {
      return Promise.reject(new TypeError('managed process event predicate must be a function'));
    }
    const normalized = normalizeWaitOptions(
      options,
      'the expected fixture event',
      this.defaultTimeoutMs,
    );

    let existing: TEvent | undefined;
    try {
      existing = this.eventHistory.find(predicate);
    } catch (error) {
      return Promise.reject(error);
    }
    if (existing !== undefined) {
      return Promise.resolve(existing);
    }
    if (this.parserError) {
      return Promise.reject(this.parserError);
    }
    if (this.processError) {
      return Promise.reject(this.createSpawnError());
    }
    if (this.closeResult) {
      return Promise.reject(this.createClosedError(normalized.description));
    }

    return new Promise<TEvent>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) {
          return;
        }
        const timeoutDiagnostics = this.getDiagnostics();
        const timeoutError = this.createTimeoutError(normalized, timeoutDiagnostics);
        settled = true;
        this.eventWaiters.delete(waiter);
        void this.terminateAfterTimeout().then(
          () => reject(timeoutError),
          (terminationError: unknown) => {
            reject(
              new AggregateError(
                [timeoutError, terminationError],
                `Timed out ${normalized.description} and failed to terminate ${formatIdentity(
                  this.identity,
                )}`,
              ),
            );
          },
        );
      }, normalized.timeoutMs);
      const waiter: EventWaiter<TEvent> = {
        predicate,
        reject: (error) => {
          if (settled) {
            return;
          }
          settled = true;
          clearTimeout(timer);
          this.eventWaiters.delete(waiter);
          reject(error);
        },
        resolve: (event) => {
          if (settled) {
            return;
          }
          settled = true;
          clearTimeout(timer);
          this.eventWaiters.delete(waiter);
          resolve(event);
        },
      };
      this.eventWaiters.add(waiter);
    });
  }

  /** Sends one bounded JSON command line to the fixture stdin. */
  async sendCommand(command: unknown): Promise<void> {
    if (
      this.teardownStarted ||
      this.closeResult ||
      this.child.stdin.destroyed ||
      this.child.stdin.writableEnded
    ) {
      throw new ManagedProcessClosedError({
        description: 'Cannot send a command',
        diagnostics: this.getDiagnostics(),
        identity: this.identity,
      });
    }

    let line: string;
    try {
      const encoded = JSON.stringify(command);
      if (encoded === undefined) {
        throw new TypeError('command must be JSON serializable');
      }
      const encodedBytes = Buffer.byteLength(encoded, 'utf8');
      if (encodedBytes > this.maxCommandBytes) {
        throw new RangeError(
          `managed process command exceeds ${this.maxCommandBytes} UTF-8 bytes; received ${encodedBytes}`,
        );
      }
      line = `${encoded}\n`;
    } catch (error) {
      if (
        error instanceof RangeError &&
        error.message.includes('managed process command exceeds')
      ) {
        throw error;
      }
      throw new TypeError(
        `Unable to encode managed process command: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const cleanup = (): void => {
        if (timer !== undefined) {
          clearTimeout(timer);
        }
        this.child.stdin.removeListener('error', onError);
        this.child.stdin.removeListener('close', onClose);
        this.pendingCommandWrites.delete(pending);
      };
      const finish = (error?: unknown): void => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        if (error === undefined) {
          resolve();
        } else {
          reject(error);
        }
      };
      const pending: PendingCommandWrite = { cancel: (error) => finish(error) };
      const onError = (error: unknown): void => {
        finish(this.createCommandError(error));
      };
      const onClose = (): void => {
        finish(
          new ManagedProcessClosedError({
            description: 'The fixture stdin closed while sending a command',
            diagnostics: this.getDiagnostics(),
            identity: this.identity,
          }),
        );
      };
      this.pendingCommandWrites.add(pending);
      this.child.stdin.once('error', onError);
      this.child.stdin.once('close', onClose);
      const timer = setTimeout(() => {
        finish(
          new ManagedProcessCommandTimeoutError({
            diagnostics: this.getDiagnostics(),
            identity: this.identity,
            timeoutMs: this.defaultCommandTimeoutMs,
          }),
        );
      }, this.defaultCommandTimeoutMs);
      if (this.teardownStarted) {
        finish(
          new ManagedProcessClosedError({
            description: 'Command delivery was interrupted during teardown',
            diagnostics: this.getDiagnostics(),
            identity: this.identity,
          }),
        );
        return;
      }
      try {
        this.child.stdin.write(line, 'utf8', (error) =>
          finish(error == null ? undefined : this.createCommandError(error)),
        );
      } catch (error) {
        finish(this.createCommandError(error));
      }
    });
  }

  /** Alias for `sendCommand`, useful when tests use a terse fixture API. */
  send(command: unknown): Promise<void> {
    return this.sendCommand(command);
  }

  /** Closes fixture stdin without sending a lifecycle command. */
  endInput(): void {
    if (!this.child.stdin.destroyed && !this.child.stdin.writableEnded) {
      this.child.stdin.end();
    }
  }

  /** Waits for Node's `exit` observation and preserves the reported outcome. */
  waitForExit(options: ManagedProcessWaitOptions | number = {}): Promise<ManagedProcessExit> {
    return this.waitForLifecycle(
      this.exitPromise,
      normalizeWaitOptions(options, 'the fixture exit', this.defaultTimeoutMs),
    );
  }

  /** Waits until Node reports `close` after exit and all stdio streams have closed. */
  waitForClose(options: ManagedProcessWaitOptions | number = {}): Promise<ManagedProcessExit> {
    return this.waitForLifecycle(
      this.closePromise,
      normalizeWaitOptions(options, 'the fixture close', this.defaultTimeoutMs),
    );
  }

  /**
   * Terminates this child and its descendants where the platform supports process trees.
   * Repeated and concurrent calls share one promise and never mask the original exit result.
   */
  killAbruptly(options: KillAbruptlyOptions = {}): Promise<ManagedProcessExit> {
    this.teardownStarted = true;
    this.cancelPendingCommandWrites();
    if (this.closeResult) {
      return Promise.resolve(this.closeResult);
    }
    if (this.killPromise) {
      return this.killPromise;
    }

    const timeoutMs = validateDuration(
      options.timeoutMs ?? this.defaultKillTimeoutMs,
      'managed process kill timeout',
    );
    const killPromise = this.runKill(timeoutMs).catch((error: unknown) => {
      // A bounded termination failure must not poison future teardown retries.
      this.killPromise = undefined;
      throw error;
    });
    this.killPromise = killPromise;
    return killPromise;
  }

  /** Teardown alias used by workspace cleanup hooks. */
  cleanup(): Promise<ManagedProcessExit> {
    if (this.cleanupPromise) {
      return this.cleanupPromise;
    }
    const cleanupPromise = this.killAbruptly().catch((error: unknown) => {
      // Keep the workspace-owned cleanup hook registered while the child is live,
      // but allow a later workspace cleanup attempt to retry termination.
      this.cleanupPromise = undefined;
      throw error;
    });
    this.cleanupPromise = cleanupPromise;
    return cleanupPromise;
  }

  /** Idempotent lifecycle teardown alias. */
  teardown(): Promise<ManagedProcessExit> {
    return this.cleanup();
  }

  private attachListeners(): void {
    this.child.stdout.on('data', this.stdoutListener);
    this.child.stderr.on('data', this.stderrListener);
    this.child.stdin.on('error', this.stdinErrorListener);
    this.child.once('error', this.childErrorListener);
    this.child.once('exit', this.childExitListener);
    this.child.once('close', this.childCloseListener);
    // `spawn()` emits before fixture output; keep it separate so startup failures
    // retain their failed state until close observation.
    this.child.once('spawn', this.childSpawnListener);
  }

  private handleStdout(chunk: Buffer | string): void {
    this.outputBuffer.appendStdout(chunk);
    try {
      for (const event of this.eventParser.push(chunk)) {
        this.recordEvent(event);
      }
    } catch (error) {
      if (error instanceof JsonLinesParseError) {
        this.parserError = error;
      }
      this.rejectEventWaiters(error);
    }
  }

  private handleChildError(error: unknown): void {
    this.processError ??= error;
    if (this.lifecycleState === 'starting' || this.lifecycleState === 'running') {
      this.lifecycleState = 'failed';
    }
    this.rejectEventWaiters(this.createSpawnError());
  }

  private handleChildExit(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.exitResult) {
      return;
    }
    if (this.lifecycleState !== 'failed') {
      this.lifecycleState = 'exited';
    }
    this.exitResult = this.makeExitResult(code, signal);
    this.resolveExit(this.exitResult);
  }

  private handleChildClose(code: number | null, signal: NodeJS.Signals | null): void {
    try {
      for (const event of this.eventParser.end()) {
        this.recordEvent(event);
      }
    } catch (error) {
      if (error instanceof JsonLinesParseError) {
        this.parserError = error;
        if (this.lifecycleState !== 'failed' && this.lifecycleState !== 'exited') {
          this.lifecycleState = 'failed';
        }
      }
    }

    if (this.lifecycleState !== 'failed') {
      this.lifecycleState = 'closed';
    }
    const finalCode = this.exitResult?.code ?? code;
    const finalSignal = this.exitResult?.signal ?? signal;
    if (!this.exitResult) {
      this.exitResult = this.makeExitResult(finalCode, finalSignal);
      this.resolveExit(this.exitResult);
    } else {
      const finalResult = this.makeExitResult(finalCode, finalSignal);
      const exitState = this.exitResult.state;
      Object.assign(this.exitResult, finalResult, { state: exitState });
    }
    this.closeResult = this.makeExitResult(finalCode, finalSignal);
    this.resolveClose(this.closeResult);
    // Workspace ownership ends only after Node has observed process and stdio closure.
    // A failed termination attempt must not make a still-live child unowned.
    this.workspaceUnregister?.();
    this.workspaceUnregister = undefined;
    this.cancelPendingCommandWrites();
    if (this.parserError) {
      this.rejectEventWaiters(this.parserError);
    } else {
      this.rejectEventWaiters(this.createClosedError('The fixture closed'));
    }
    this.detachChildResources();
  }

  private detachChildResources(): void {
    if (this.resourcesDetached) {
      return;
    }
    this.resourcesDetached = true;
    this.child.stdout.removeListener('data', this.stdoutListener);
    this.child.stderr.removeListener('data', this.stderrListener);
    this.child.stdin.removeListener('error', this.stdinErrorListener);
    this.child.removeListener('error', this.childErrorListener);
    this.child.removeListener('exit', this.childExitListener);
    this.child.removeListener('close', this.childCloseListener);
    this.child.removeListener('spawn', this.childSpawnListener);
  }

  private cancelPendingCommandWrites(): void {
    if (this.pendingCommandWrites.size === 0) {
      return;
    }
    const error = this.createClosedError('Command delivery was interrupted during teardown');
    for (const pending of [...this.pendingCommandWrites]) {
      pending.cancel(error);
    }
  }

  private recordEvent(event: TEvent): void {
    if (this.maxEvents > 0) {
      this.eventHistory.push(event);
      if (this.eventHistory.length > this.maxEvents) {
        this.eventHistory.shift();
      }
    }

    for (const waiter of [...this.eventWaiters]) {
      try {
        if (waiter.predicate(event)) {
          waiter.resolve(event);
        }
      } catch (error) {
        waiter.reject(error);
      }
    }
  }

  private rejectEventWaiters(error: unknown): void {
    for (const waiter of [...this.eventWaiters]) {
      waiter.reject(error);
    }
  }

  private waitForLifecycle(
    promise: Promise<ManagedProcessExit>,
    options: NormalizedWaitOptions,
  ): Promise<ManagedProcessExit> {
    return new Promise<ManagedProcessExit>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) {
          return;
        }
        const timeoutDiagnostics = this.getDiagnostics();
        const timeoutError = this.createTimeoutError(options, timeoutDiagnostics);
        settled = true;
        void this.terminateAfterTimeout().then(
          () => reject(timeoutError),
          (terminationError: unknown) => {
            reject(
              new AggregateError(
                [timeoutError, terminationError],
                `Timed out ${options.description} and failed to terminate ${formatIdentity(
                  this.identity,
                )}`,
              ),
            );
          },
        );
      }, options.timeoutMs);
      promise.then(
        (result) => {
          if (settled) {
            return;
          }
          settled = true;
          clearTimeout(timer);
          resolve(result);
        },
        (error: unknown) => {
          if (settled) {
            return;
          }
          settled = true;
          clearTimeout(timer);
          reject(error);
        },
      );
    });
  }

  private async terminateAfterTimeout(): Promise<void> {
    await this.killAbruptly({ timeoutMs: this.defaultKillTimeoutMs });
  }

  private async runKill(timeoutMs: number): Promise<ManagedProcessExit> {
    if (this.closeResult) {
      return this.closeResult;
    }

    const deadline = Date.now() + timeoutMs;
    const pid = this.child.pid;
    if (pid !== undefined && this.child.exitCode === null && this.child.signalCode === null) {
      if (process.platform === 'win32') {
        try {
          await terminateWindowsProcessTree(pid, remainingTime(deadline));
        } catch (error) {
          if (isAlreadyClosedTerminationError(error)) {
            try {
              return await this.waitForCloseWithin(remainingTime(deadline));
            } catch (closeError) {
              throw new AggregateError(
                [error, closeError],
                `The managed process ${formatIdentity(this.identity)} was already closed but close observation failed`,
              );
            }
          }
          // A genuine taskkill failure remains observable. A direct child kill is only a
          // best-effort fallback to prevent a live child leak and never replaces the error.
          const fallbackError = this.tryDirectKill();
          try {
            await this.waitForCloseWithin(remainingTime(deadline));
          } catch (closeError) {
            const errors = [error];
            if (fallbackError !== undefined) {
              errors.push(fallbackError);
            }
            errors.push(closeError);
            throw new AggregateError(
              errors,
              `Unable to terminate ${formatIdentity(this.identity)} after taskkill failed`,
            );
          }
          if (fallbackError !== undefined) {
            throw new AggregateError(
              [error, fallbackError],
              `Unable to terminate ${formatIdentity(this.identity)} after taskkill failed`,
            );
          }
          throw error;
        }
      } else {
        try {
          this.child.kill('SIGKILL');
        } catch (error) {
          if (!isAlreadyExitedError(error)) {
            throw error;
          }
        }
      }
    }

    return this.waitForCloseWithin(remainingTime(deadline));
  }

  private tryDirectKill(): unknown {
    try {
      this.child.kill();
      return undefined;
    } catch (error) {
      return error;
    }
  }

  private waitForCloseWithin(timeoutMs: number): Promise<ManagedProcessExit> {
    if (this.closeResult) {
      return Promise.resolve(this.closeResult);
    }
    return new Promise<ManagedProcessExit>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) {
          return;
        }
        settled = true;
        reject(
          new Error(
            `Managed process ${formatIdentity(this.identity)} did not close after abrupt termination.\n${this.formatDiagnostics()}`,
          ),
        );
      }, timeoutMs);
      this.closePromise.then(
        (result) => {
          if (settled) {
            return;
          }
          settled = true;
          clearTimeout(timer);
          resolve(result);
        },
        (error: unknown) => {
          if (settled) {
            return;
          }
          settled = true;
          clearTimeout(timer);
          reject(error);
        },
      );
    });
  }

  private makeExitResult(code: number | null, signal: NodeJS.Signals | null): ManagedProcessExit {
    const output = this.output;
    return {
      code,
      error: this.processError,
      exitCode: code,
      identity: this.identity,
      output,
      signal,
      spawnError: this.processError,
      state: this.lifecycleState,
      stderr: output.stderr,
      stdout: output.stdout,
    };
  }

  private createTimeoutError(
    options: NormalizedWaitOptions,
    diagnostics: ProcessDiagnostics = this.getDiagnostics(),
  ): ManagedProcessTimeoutError {
    return new ManagedProcessTimeoutError({
      description: options.description,
      diagnostics,
      timeoutMs: options.timeoutMs,
    });
  }

  private createClosedError(description: string): ManagedProcessClosedError {
    return new ManagedProcessClosedError({
      description,
      diagnostics: this.getDiagnostics(),
      identity: this.identity,
    });
  }

  private createSpawnError(): ManagedProcessSpawnError {
    return new ManagedProcessSpawnError({
      diagnostics: this.getDiagnostics(),
      identity: this.identity,
      spawnError: this.processError,
    });
  }

  private createCommandError(cause: unknown): ManagedProcessCommandError {
    return new ManagedProcessCommandError({
      cause,
      diagnostics: this.getDiagnostics(),
      identity: this.identity,
    });
  }
}

/** Creates and immediately spawns a managed lifecycle fixture process. */
export function createManagedProcess<TEvent = ManagedProcessEvent>(
  options: ManagedProcessOptions = {},
): ManagedProcess<TEvent> {
  return new ManagedProcess<TEvent>(options);
}
/** Alias emphasizing that the returned process is a child of the test runner. */
export const createManagedChildProcess = createManagedProcess;
export const spawnManagedProcess = createManagedProcess;
export { ManagedProcess as ManagedChildProcess };
/**
 * Tracks multiple managed children and registers one teardown hook that attempts every child,
 * even when one termination fails. Workspace removal therefore never races a live child.
 */
export class ManagedProcessGroup {
  private readonly managedProcesses = new Set<ManagedProcess>();
  private readonly workspaceEnvironment: Readonly<Record<string, string>> | undefined;
  private teardownPromise: Promise<void> | undefined;
  private teardownStarted = false;
  private workspaceUnregister: (() => void) | undefined;

  constructor(options: ManagedProcessGroupOptions = {}) {
    this.workspaceEnvironment = options.workspace?.env;
    if (options.workspace) {
      this.workspaceUnregister = options.workspace.registerBeforeCleanup(() => this.teardown());
    }
  }

  get processes(): readonly ManagedProcess[] {
    return [...this.managedProcesses];
  }

  add<TEvent>(process: ManagedProcess<TEvent>): ManagedProcess<TEvent> {
    if (this.teardownStarted) {
      void process.cleanup().catch(() => undefined);
      throw new Error(
        `Cannot add ${formatIdentity(process.identity)} after managed process group teardown started`,
      );
    }
    this.managedProcesses.add(process as ManagedProcess);
    return process;
  }

  spawn<TEvent = ManagedProcessEvent>(options: ManagedProcessOptions = {}): ManagedProcess<TEvent> {
    if (this.teardownStarted) {
      throw new Error('Cannot spawn a managed process after group teardown started');
    }
    // The group owns cleanup; forward its workspace environment without registering each child.
    const process = createManagedProcess<TEvent>({
      ...options,
      env: { ...this.workspaceEnvironment, ...options.workspace?.env, ...options.env },
      workspace: undefined,
    });
    try {
      return this.add(process);
    } catch (error) {
      void process.cleanup().catch(() => undefined);
      throw error;
    }
  }

  async teardown(): Promise<void> {
    if (this.teardownPromise) {
      return this.teardownPromise;
    }
    this.teardownStarted = true;
    this.teardownPromise = this.runTeardown().catch((error: unknown) => {
      // A later teardown may succeed after the OS reports the child's eventual closure.
      this.teardownPromise = undefined;
      throw error;
    });
    return this.teardownPromise;
  }

  cleanup(): Promise<void> {
    return this.teardown();
  }

  private async runTeardown(): Promise<void> {
    const processes = [...this.managedProcesses];
    const results = await Promise.allSettled(processes.map((process) => process.killAbruptly()));
    for (const [index, result] of results.entries()) {
      const process = processes[index];
      if (process && (result.status === 'fulfilled' || process.state === 'closed')) {
        this.managedProcesses.delete(process);
      }
    }
    if (this.managedProcesses.size === 0) {
      this.workspaceUnregister?.();
      this.workspaceUnregister = undefined;
    }

    const errors = results
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      .map((result) => result.reason);
    if (errors.length === 1) {
      throw errors[0];
    }
    if (errors.length > 1) {
      throw new AggregateError(errors, 'Unable to terminate every managed child process');
    }
  }
}

export function createManagedProcessGroup(
  options: ManagedProcessGroupOptions = {},
): ManagedProcessGroup {
  return new ManagedProcessGroup(options);
}

function normalizeWaitOptions(
  options: ManagedProcessWaitOptions | number,
  defaultDescription: string,
  defaultTimeoutMs = DEFAULT_MANAGED_PROCESS_TIMEOUT_MS,
): NormalizedWaitOptions {
  if (typeof options === 'number') {
    return {
      description: defaultDescription,
      timeoutMs: validateDuration(options, 'managed process wait timeout'),
    };
  }
  return {
    description: options.description ?? defaultDescription,
    timeoutMs: validateDuration(
      options.timeoutMs ?? defaultTimeoutMs,
      'managed process wait timeout',
    ),
  };
}

function validateDuration(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${label} must be a finite non-negative number; received ${value}`);
  }
  return value;
}

function remainingTime(deadline: number): number {
  return Math.max(0, deadline - Date.now());
}

function validateNonNegativeInteger(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative integer; received ${value}`);
  }
  return value;
}
function validatePositiveInteger(value: number, label: string): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new RangeError(`${label} must be a positive integer; received ${value}`);
  }
  return value;
}

function formatIdentity(identity: ProcessIdentity): string {
  if (typeof identity === 'string') {
    return identity;
  }
  if (typeof identity === 'number') {
    return `pid ${identity}`;
  }
  const label = identity.label ?? identity.name ?? identity.id ?? 'managed process';
  return identity.pid === undefined ? label : `${label} (pid ${identity.pid})`;
}

function isAlreadyExitedError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const code = (error as NodeJS.ErrnoException).code;
  return code === 'ESRCH' || code === 'EINVAL';
}

class WindowsProcessTreeTerminationError extends Error {
  readonly code = 'ERR_MANAGED_PROCESS_TREE_TERMINATION';
  readonly alreadyClosed: boolean;
  readonly pid: number;

  constructor(options: {
    readonly pid: number;
    readonly message: string;
    readonly alreadyClosed?: boolean;
    readonly cause?: unknown;
  }) {
    super(options.message, { cause: options.cause });
    this.name = 'WindowsProcessTreeTerminationError';
    this.pid = options.pid;
    this.alreadyClosed = options.alreadyClosed ?? false;
  }
}

function isAlreadyClosedTerminationError(error: unknown): boolean {
  return error instanceof WindowsProcessTreeTerminationError && error.alreadyClosed;
}

export function terminateWindowsProcessTree(
  pid: number,
  timeoutMs: number,
  spawnCommand: typeof spawn = spawn,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const taskkill = spawnCommand('taskkill', ['/F', '/T', '/PID', String(pid)], {
      shell: false,
      stdio: ['ignore', 'ignore', 'ignore'],
      windowsHide: true,
    });
    let settled = false;

    const cleanup = (): void => {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      taskkill.removeListener('error', onError);
      taskkill.removeListener('close', onClose);
    };
    const stopCommand = (): void => {
      try {
        taskkill.kill();
      } catch {
        // The timeout error remains authoritative when the command already exited.
      }
      taskkill.unref();
    };
    const settle = (error?: unknown, stop = false): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      if (stop) {
        stopCommand();
      }
      if (error === undefined) {
        resolve();
      } else {
        reject(error);
      }
    };
    const onError = (error: unknown): void => {
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      settle(
        new WindowsProcessTreeTerminationError({
          alreadyClosed: code === 'ESRCH' || code === 'EINVAL',
          cause: error,
          message: `Unable to run taskkill for pid ${pid}: ${
            error instanceof Error ? error.message : String(error)
          }`,
          pid,
        }),
      );
    };
    const onClose = (code: number | null): void => {
      if (code === 0) {
        settle();
        return;
      }
      settle(
        new WindowsProcessTreeTerminationError({
          alreadyClosed: code === 128,
          message: `taskkill exited with code ${code ?? 'null'} for pid ${pid}`,
          pid,
        }),
      );
    };
    taskkill.once('error', onError);
    taskkill.once('close', onClose);
    const timer = setTimeout(() => {
      settle(
        new WindowsProcessTreeTerminationError({
          message: `taskkill did not finish within ${timeoutMs}ms for pid ${pid}`,
          pid,
        }),
        true,
      );
    }, timeoutMs);
  });
}
