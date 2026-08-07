import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { basename, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  BoundedOutput,
  type BoundedOutputOptions,
  type CapturedOutput,
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
  readonly code = 'ERR_MANAGED_PROCESS_CLOSED';
  readonly identity: ProcessIdentity;
  readonly diagnostics: ProcessDiagnostics;

  constructor(options: {
    readonly identity: ProcessIdentity;
    readonly diagnostics: ProcessDiagnostics;
    readonly description: string;
  }) {
    super(
      `${options.description} before the expected lifecycle observation.\n${formatProcessDiagnostics(
        options.diagnostics,
      )}`,
    );
    this.name = 'ManagedProcessClosedError';
    this.identity = options.identity;
    this.diagnostics = options.diagnostics;
  }
}

export class ManagedProcessSpawnError extends Error {
  readonly code = 'ERR_MANAGED_PROCESS_SPAWN';
  readonly identity: ProcessIdentity;
  readonly diagnostics: ProcessDiagnostics;
  readonly spawnError: unknown;

  constructor(options: {
    readonly identity: ProcessIdentity;
    readonly diagnostics: ProcessDiagnostics;
    readonly spawnError: unknown;
  }) {
    super(
      `Unable to start ${formatIdentity(options.identity)}.\n${formatProcessDiagnostics(
        options.diagnostics,
      )}`,
      { cause: options.spawnError },
    );
    this.name = 'ManagedProcessSpawnError';
    this.identity = options.identity;
    this.diagnostics = options.diagnostics;
    this.spawnError = options.spawnError;
  }
}

interface EventWaiter<TEvent> {
  readonly predicate: (event: TEvent) => boolean;
  readonly resolve: (event: TEvent) => void;
  readonly reject: (error: unknown) => void;
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
  private readonly defaultKillTimeoutMs: number;
  private readonly maxEvents: number;
  private readonly eventParser: JsonLinesParser<TEvent>;
  private readonly eventHistory: TEvent[] = [];
  private readonly eventWaiters = new Set<EventWaiter<TEvent>>();
  private readonly exitPromise: Promise<ManagedProcessExit>;
  private readonly closePromise: Promise<ManagedProcessExit>;
  private resolveExit!: (result: ManagedProcessExit) => void;
  private resolveClose!: (result: ManagedProcessExit) => void;
  private exitResult: ManagedProcessExit | undefined;
  private closeResult: ManagedProcessExit | undefined;
  private processError: unknown;
  private parserError: JsonLinesParseError | undefined;
  private lifecycleState: ManagedProcessState = 'starting';
  private workspaceUnregister: (() => void) | undefined;
  private killPromise: Promise<ManagedProcessExit> | undefined;
  private cleanupPromise: Promise<ManagedProcessExit> | undefined;

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
    this.defaultKillTimeoutMs = validateDuration(
      options.killTimeoutMs ?? DEFAULT_MANAGED_PROCESS_KILL_TIMEOUT_MS,
      'managed process kill timeout',
    );
    this.maxEvents = validateNonNegativeInteger(
      options.maxEvents ?? DEFAULT_MAX_MANAGED_PROCESS_EVENTS,
      'maximum managed process events',
    );
    this.outputBuffer = new BoundedOutput(options.output);

    const env = { ...process.env, ...options.workspace?.env, ...options.env };
    this.child = spawn(process.execPath, [this.fixturePath, ...this.args], {
      cwd: options.cwd,
      env,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.eventParser = new JsonLinesParser<TEvent>({
      getOutput: () => this.output,
      identity: this.identity,
    });

    this.exitPromise = new Promise<ManagedProcessExit>((resolve) => {
      this.resolveExit = resolve;
    });
    this.closePromise = new Promise<ManagedProcessExit>((resolve) => {
      this.resolveClose = resolve;
    });

    this.attachListeners();
    if (options.workspace) {
      this.workspaceUnregister = options.workspace.registerBeforeCleanup(async () => {
        await this.cleanup();
      });
    }
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
        settled = true;
        this.eventWaiters.delete(waiter);
        void this.terminateAfterTimeout().then(
          () => reject(this.createTimeoutError(normalized)),
          (terminationError: unknown) => {
            reject(
              new AggregateError(
                [this.createTimeoutError(normalized), terminationError],
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

  /** Sends one JSON command line to the fixture stdin. */
  async sendCommand(command: unknown): Promise<void> {
    if (this.closeResult || this.child.stdin.destroyed || this.child.stdin.writableEnded) {
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
      line = `${encoded}\n`;
    } catch (error) {
      throw new TypeError(
        `Unable to encode managed process command: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const cleanup = (): void => {
        this.child.stdin.removeListener('error', onError);
        this.child.stdin.removeListener('close', onClose);
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
      const onError = (error: unknown): void => {
        finish(
          new Error(
            `Unable to send a command to ${formatIdentity(this.identity)}.\n${this.formatDiagnostics()}`,
            { cause: error },
          ),
        );
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
      this.child.stdin.once('error', onError);
      this.child.stdin.once('close', onClose);
      try {
        this.child.stdin.write(line, 'utf8', () => finish());
      } catch (error) {
        finish(error);
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
    this.killPromise = this.runKill(timeoutMs);
    return this.killPromise;
  }

  /** Teardown alias used by workspace cleanup hooks. */
  cleanup(): Promise<ManagedProcessExit> {
    if (this.cleanupPromise) {
      return this.cleanupPromise;
    }
    this.cleanupPromise = this.killAbruptly().finally(() => {
      this.workspaceUnregister?.();
      this.workspaceUnregister = undefined;
    });
    return this.cleanupPromise;
  }

  /** Idempotent lifecycle teardown alias. */
  teardown(): Promise<ManagedProcessExit> {
    return this.cleanup();
  }

  private attachListeners(): void {
    this.child.stdout.on('data', (chunk: Buffer | string) => {
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
    });
    this.child.stderr.on('data', (chunk: Buffer | string) => {
      this.outputBuffer.appendStderr(chunk);
    });
    this.child.stdin.on('error', () => {});
    this.child.once('error', (error: unknown) => {
      this.processError ??= error;
      if (this.lifecycleState === 'starting' || this.lifecycleState === 'running') {
        this.lifecycleState = 'failed';
      }
      this.rejectEventWaiters(this.createSpawnError());
    });
    this.child.once('exit', (code: number | null, signal: NodeJS.Signals | null) => {
      this.lifecycleState = 'exited';
      this.exitResult = this.makeExitResult(code, signal);
      this.resolveExit(this.exitResult);
    });
    this.child.once('close', (code: number | null, signal: NodeJS.Signals | null) => {
      try {
        for (const event of this.eventParser.end()) {
          this.recordEvent(event);
        }
      } catch (error) {
        if (error instanceof JsonLinesParseError) {
          this.parserError = error;
        }
      }
      this.lifecycleState = 'closed';
      if (!this.exitResult) {
        this.exitResult = this.makeExitResult(code, signal);
        this.resolveExit(this.exitResult);
      }
      this.closeResult = this.makeExitResult(code, signal);
      this.resolveClose(this.closeResult);
      if (this.parserError) {
        this.rejectEventWaiters(this.parserError);
      } else {
        this.rejectEventWaiters(this.createClosedError('The fixture closed'));
      }
    });

    // `spawn()` emits `spawn` before any user-visible fixture output. Keep this listener
    // separate from `exit` so startup failures retain a useful failed state.
    this.child.once('spawn', () => {
      if (this.lifecycleState === 'starting') {
        this.lifecycleState = 'running';
      }
    });
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
        settled = true;
        void this.terminateAfterTimeout().then(
          () => reject(this.createTimeoutError(options)),
          (terminationError: unknown) => {
            reject(
              new AggregateError(
                [this.createTimeoutError(options), terminationError],
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

    const pid = this.child.pid;
    if (pid !== undefined && this.child.exitCode === null && this.child.signalCode === null) {
      if (process.platform === 'win32') {
        try {
          await terminateWindowsProcessTree(pid, timeoutMs);
        } catch {
          // A process can exit between observation and taskkill. Fall back to the direct
          // child handle so teardown still has one deterministic path to closure.
          try {
            this.child.kill();
          } catch {
            // The close observation below remains authoritative when the process raced exit.
          }
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

    return this.waitForCloseWithin(timeoutMs);
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

  private createTimeoutError(options: NormalizedWaitOptions): ManagedProcessTimeoutError {
    return new ManagedProcessTimeoutError({
      description: options.description,
      diagnostics: this.getDiagnostics(),
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
  private teardownPromise: Promise<void> | undefined;
  private workspaceUnregister: (() => void) | undefined;

  constructor(options: ManagedProcessGroupOptions = {}) {
    if (options.workspace) {
      this.workspaceUnregister = options.workspace.registerBeforeCleanup(() => this.teardown());
    }
  }

  get processes(): readonly ManagedProcess[] {
    return [...this.managedProcesses];
  }

  add<TEvent>(process: ManagedProcess<TEvent>): ManagedProcess<TEvent> {
    this.managedProcesses.add(process as ManagedProcess);
    return process;
  }

  spawn<TEvent = ManagedProcessEvent>(options: ManagedProcessOptions = {}): ManagedProcess<TEvent> {
    const process = createManagedProcess<TEvent>({ ...options, workspace: undefined });
    return this.add(process);
  }

  async teardown(): Promise<void> {
    if (this.teardownPromise) {
      return this.teardownPromise;
    }
    this.teardownPromise = this.runTeardown();
    return this.teardownPromise;
  }

  cleanup(): Promise<void> {
    return this.teardown();
  }

  private async runTeardown(): Promise<void> {
    const results = await Promise.allSettled(
      [...this.managedProcesses].map((process) => process.killAbruptly()),
    );
    this.managedProcesses.clear();
    this.workspaceUnregister?.();
    this.workspaceUnregister = undefined;

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

function validateNonNegativeInteger(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative integer; received ${value}`);
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
  return code === 'ESRCH' || code === 'EINVAL' || code === 'EPERM';
}

function terminateWindowsProcessTree(pid: number, timeoutMs: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const taskkill = spawn('taskkill', ['/F', '/T', '/PID', String(pid)], {
      shell: false,
      stdio: ['ignore', 'ignore', 'ignore'],
      windowsHide: true,
    });
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      try {
        taskkill.kill();
      } catch {
        // The command may already have exited while the timer callback ran.
      }
      reject(new Error(`taskkill did not finish within ${timeoutMs}ms for pid ${pid}`));
    }, timeoutMs);
    const cleanup = (): void => {
      clearTimeout(timer);
      taskkill.removeListener('error', onError);
      taskkill.removeListener('close', onClose);
    };
    const onError = (error: unknown): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(error);
    };
    const onClose = (code: number | null): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      if (code === 0 || code === 128) {
        resolve();
      } else {
        reject(new Error(`taskkill exited with code ${code ?? 'null'} for pid ${pid}`));
      }
    };
    taskkill.once('error', onError);
    taskkill.once('close', onClose);
  });
}
