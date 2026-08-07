export {
  createTestWorkspace,
  DEFAULT_WORKSPACE_CLEANUP_RETRIES,
  DEFAULT_WORKSPACE_CLEANUP_RETRY_DELAY_MS,
  removeTestWorkspace,
  testWorkspaceExists,
  withTestWorkspace,
} from './workspace.js';
export type {
  RemoveTestWorkspaceOptions,
  TestWorkspace,
  TestWorkspaceOptions,
  TestWorkspacePaths,
  WorkspaceCleanupHook,
} from './workspace.js';

export {
  DEFAULT_WAIT_POLL_INTERVAL_MS,
  DEFAULT_WAIT_TIMEOUT_MS,
  waitFor,
  waitForPredicate,
  WaitAbortedError,
  WaitTimeoutError,
} from './wait.js';
export type { AsyncWaitPredicate, WaitForPredicateOptions, WaitPredicateResult } from './wait.js';

export {
  BoundedOutput,
  createBoundedOutput,
  DEFAULT_MAX_JSON_CHUNK_BYTES,
  DEFAULT_MAX_JSON_LINE_BYTES,
  DEFAULT_MAX_OUTPUT_BYTES,
  formatProcessDiagnostics,
  formatProcessIdentity,
  JsonLinesParseError,
  JsonLinesParser,
  parseJsonLines,
} from './output.js';
export type {
  BoundedOutputOptions,
  CapturedOutput,
  JsonLinesParseErrorOptions,
  JsonLinesParserOptions,
  OutputStream,
  ProcessDiagnostics,
  ProcessIdentity,
} from './output.js';

export {
  createManagedChildProcess,
  createManagedProcess,
  createManagedProcessGroup,
  DEFAULT_LIFECYCLE_FIXTURE_PATH,
  DEFAULT_MANAGED_PROCESS_KILL_TIMEOUT_MS,
  DEFAULT_MANAGED_PROCESS_COMMAND_TIMEOUT_MS,
  DEFAULT_MANAGED_PROCESS_TIMEOUT_MS,
  DEFAULT_MAX_MANAGED_PROCESS_COMMAND_BYTES,
  DEFAULT_MAX_MANAGED_PROCESS_EVENTS,
  LIFECYCLE_FIXTURE_PATH,
  ManagedChildProcess,
  ManagedProcess,
  ManagedProcessClosedError,
  ManagedProcessCommandError,
  ManagedProcessCommandTimeoutError,
  ManagedProcessGroup,
  ManagedProcessSpawnError,
  ManagedProcessTimeoutError,
  spawnManagedProcess,
} from './process.js';
export type {
  KillAbruptlyOptions,
  ManagedProcessEvent,
  ManagedProcessExit,
  ManagedProcessGroupOptions,
  ManagedProcessOptions,
  ManagedProcessState,
  ManagedProcessWaitOptions,
  ManagedProcessWorkspace,
} from './process.js';
