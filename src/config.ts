import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmodSync, lstatSync, mkdirSync } from 'node:fs';
import { homedir, tmpdir, userInfo } from 'node:os';
import nodePath from 'node:path';

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

import { asNormalizedName, type NormalizedName } from './identity.js';
import { normalizeProjectLabel, type NormalizedProjectLabel } from './room.js';

/** Names registered through Pi's extension flag API. */
export const P2P_NAME_FLAG = 'p2p-name' as const;
export const P2P_PROJECT_FLAG = 'p2p-project' as const;

/** Canonical explicit name override after shared normalization. */
export type P2PNameOverride = NormalizedName;
export type P2PNameSource = 'p2p-name' | 'session-name' | 'fallback';

/** Values read from Pi's namespaced extension flags. */
export interface P2PFlagValues {
  readonly p2pName?: boolean | string;
  readonly p2pProject?: boolean | string;
}

/** Inputs accepted by the pure configuration resolver. */
export interface ResolveP2PConfigOptions {
  readonly flags?: P2PFlagValues;
  readonly p2pName?: unknown;
  readonly p2pProject?: unknown;
  readonly sessionName?: string;
}

/** Effective process-level P2P configuration for one runtime. */
export interface P2PConfig {
  /** Effective canonical display-name base after shared normalization. */
  readonly name: NormalizedName;
  /** Whether the effective name came from an explicit override or fallback. */
  readonly nameSource: P2PNameSource;
  /** Explicit `--p2p-name`, when configured. */
  readonly nameOverride?: P2PNameOverride;
  /** Explicit `--p2p-project`, when configured. */
  readonly projectOverride?: NormalizedProjectLabel;
}

/** Configuration error raised for an invalid explicit P2P option. */
export class P2PConfigurationError extends Error {
  readonly option: typeof P2P_NAME_FLAG | typeof P2P_PROJECT_FLAG;

  constructor(option: typeof P2P_NAME_FLAG | typeof P2P_PROJECT_FLAG, message: string) {
    super(`Invalid --${option}: ${message}`);
    this.name = 'P2PConfigurationError';
    this.option = option;
  }
}

/** Register both namespaced extension flags without allocating runtime resources. */
export function registerP2PFlags(pi: Pick<ExtensionAPI, 'registerFlag'>): void {
  pi.registerFlag(P2P_NAME_FLAG, {
    type: 'string',
    description: 'Override the Pi-to-Pi network display name.',
  });
  pi.registerFlag(P2P_PROJECT_FLAG, {
    type: 'string',
    description: 'Join the explicitly named Pi-to-Pi project room.',
  });
}

/** Read the effective values assigned by Pi after CLI parsing. */
export function readP2PFlags(pi: Pick<ExtensionAPI, 'getFlag'>): P2PFlagValues {
  return {
    p2pName: pi.getFlag(P2P_NAME_FLAG),
    p2pProject: pi.getFlag(P2P_PROJECT_FLAG),
  };
}

/**
 * Resolve explicit P2P options before automatic defaults.
 *
 * Explicit names and projects share the room module's canonical NFKC/lowercase
 * label normalizer and are branded only after normalization. Native session names
 * use the same path, but an unusable native value falls back to `agent` rather
 * than becoming an invalid published name.
 */
export function resolveP2PConfig(options: ResolveP2PConfigOptions = {}): P2PConfig {
  const nameInput = firstDefined(options.p2pName, options.flags?.p2pName);
  const projectInput = firstDefined(options.p2pProject, options.flags?.p2pProject);

  const nameOverride = validateLabel(nameInput, P2P_NAME_FLAG) as P2PNameOverride | undefined;
  const projectOverride = validateLabel(projectInput, P2P_PROJECT_FLAG) as
    NormalizedProjectLabel | undefined;
  const sessionName =
    options.sessionName && options.sessionName.length > 0 ? options.sessionName : undefined;

  let name: NormalizedName;
  let nameSource: P2PNameSource;
  if (nameOverride !== undefined) {
    name = nameOverride;
    nameSource = 'p2p-name';
  } else if (sessionName !== undefined) {
    try {
      name = asNormalizedName(sessionName);
      nameSource = 'session-name';
    } catch {
      name = asNormalizedName('agent');
      nameSource = 'fallback';
    }
  } else {
    name = asNormalizedName('agent');
    nameSource = 'fallback';
  }

  return Object.freeze({
    name,
    nameSource,
    ...(nameOverride === undefined ? {} : { nameOverride }),
    ...(projectOverride === undefined ? {} : { projectOverride }),
  });
}

function firstDefined(...values: unknown[]): unknown {
  for (const value of values) {
    if (value !== undefined) {
      return value;
    }
  }
  return undefined;
}

function validateLabel(
  value: unknown,
  option: typeof P2P_NAME_FLAG | typeof P2P_PROJECT_FLAG,
): NormalizedName | NormalizedProjectLabel | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string') {
    throw new P2PConfigurationError(option, 'a string value is required');
  }
  if (value.length === 0) {
    throw new P2PConfigurationError(option, 'the value must not be empty');
  }

  try {
    return option === P2P_NAME_FLAG ? asNormalizedName(value) : normalizeProjectLabel(value);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'the value is invalid';
    throw new P2PConfigurationError(option, message);
  }
}

/** Environment variable used to explicitly select the private registry root. */
export const RUNTIME_DIR_ENV = 'PI_TO_PI_RUNTIME_DIR';

/** Environment variable used by POSIX systems for a per-user runtime directory. */
export const XDG_RUNTIME_DIR_ENV = 'XDG_RUNTIME_DIR';

/** Environment variable used by Windows for a per-user application-data directory. */
export const LOCAL_APP_DATA_ENV = 'LOCALAPPDATA';

/** The mode required for registry directories on POSIX systems. */
export const PRIVATE_DIRECTORY_MODE = 0o700;

export type RuntimeRootSource = 'override' | 'xdg' | 'local-app-data' | 'temporary';

/** A resolved root and the source that supplied it. */
export interface RuntimeRootSelection {
  readonly path: string;
  readonly source: RuntimeRootSource;
  readonly warning?: string;
}

/**
 * The inputs are injectable so root selection can be checked without changing
 * the process environment. `uid` is only needed when simulating POSIX on a
 * platform that does not expose `process.getuid()`.
 */
export interface RuntimeRootOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  readonly temporaryDirectory?: string;
  readonly homeDirectory?: string;
  readonly uid?: number;
  readonly warn?: (message: string) => void;
  /** Used by cross-platform tests; production Windows uses `icacls`. */
  readonly protectWindowsPath?: (target: string) => void;
}

export class RuntimeRootError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'RuntimeRootError';
  }
}

const warnedFallbacks = new Set<string>();

function pathApiFor(platform: NodeJS.Platform): typeof nodePath.posix {
  return platform === 'win32' ? nodePath.win32 : nodePath.posix;
}

function currentUid(options: RuntimeRootOptions): number | undefined {
  if (options.uid !== undefined) {
    return options.uid;
  }
  return typeof process.getuid === 'function' ? process.getuid() : undefined;
}

function isAbsolute(value: string, platform: NodeJS.Platform): boolean {
  return pathApiFor(platform).isAbsolute(value);
}

function normalizeAbsolute(value: string, platform: NodeJS.Platform): string | undefined {
  if (value.length === 0 || !isAbsolute(value, platform)) {
    return undefined;
  }
  return pathApiFor(platform).normalize(value);
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

function isDirectoryModePrivate(mode: number): boolean {
  return (mode & 0o777) === PRIVATE_DIRECTORY_MODE;
}

function windowsAccount(env: NodeJS.ProcessEnv): string {
  const username = env.USERNAME ?? (process.platform === 'win32' ? userInfo().username : undefined);
  if (!username) {
    throw new RuntimeRootError('Cannot determine the current Windows account for ACL protection');
  }
  const domain = env.USERDOMAIN;
  return domain ? `${domain}\\${username}` : username;
}

/**
 * Apply a current-user-only ACL to a Windows directory. POSIX mode bits do not
 * provide a Windows privacy boundary, so callers must use this helper (or an
 * injected equivalent) whenever they create a Windows registry path.
 */
export function protectWindowsPathSync(
  target: string,
  kind: 'directory' | 'file' = 'directory',
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (process.platform !== 'win32') {
    return;
  }

  const rights = kind === 'directory' ? '(OI)(CI)F' : 'F';
  const account = windowsAccount(env);
  try {
    execFileSync(
      'icacls',
      [
        target,
        '/inheritance:r',
        '/grant:r',
        `${account}:${rights}`,
        '/remove:g',
        'Everyone',
        'BUILTIN\\Users',
        'Authenticated Users',
      ],
      { stdio: 'ignore', windowsHide: true },
    );
  } catch (error) {
    throw new RuntimeRootError(
      `Cannot establish a private Windows ACL for ${target}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function validatePrivateExistingDirectory(
  directory: string,
  platform: NodeJS.Platform,
  uid: number | undefined,
): boolean {
  let stats;
  try {
    stats = lstatSync(directory);
  } catch (error) {
    if (isMissing(error)) {
      return false;
    }
    return false;
  }

  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    return false;
  }

  if (platform !== 'win32') {
    if (uid === undefined || stats.uid !== uid || !isDirectoryModePrivate(stats.mode)) {
      return false;
    }
  }
  return true;
}

function ensurePrivateDirectorySync(directory: string, options: RuntimeRootOptions): void {
  const platform = options.platform ?? process.platform;
  const uid = currentUid(options);
  let created = false;

  try {
    const stats = lstatSync(directory);
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      throw new RuntimeRootError(`Runtime root is not a real directory: ${directory}`);
    }
    if (
      platform !== 'win32' &&
      (uid === undefined || stats.uid !== uid || !isDirectoryModePrivate(stats.mode))
    ) {
      throw new RuntimeRootError(`Runtime root is not private to the current user: ${directory}`);
    }
  } catch (error) {
    if (!isMissing(error)) {
      throw error;
    }
    mkdirSync(directory, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
    created = true;
  }

  let stats = lstatSync(directory);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new RuntimeRootError(`Runtime root is not a real directory: ${directory}`);
  }

  if (platform !== 'win32') {
    if (uid === undefined || stats.uid !== uid) {
      throw new RuntimeRootError(`Cannot verify runtime-root ownership: ${directory}`);
    }
    if (created) {
      // An unusual umask can affect owner bits; tighten a directory we just created.
      try {
        chmodSync(directory, PRIVATE_DIRECTORY_MODE);
      } catch (error) {
        throw new RuntimeRootError(
          `Cannot set private runtime-root permissions for ${directory}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      stats = lstatSync(directory);
    }
    if (!isDirectoryModePrivate(stats.mode)) {
      throw new RuntimeRootError(`Runtime root is not private to the current user: ${directory}`);
    }
  } else if (process.platform === 'win32') {
    const protect = options.protectWindowsPath;
    if (protect) {
      protect(directory);
    } else {
      protectWindowsPathSync(directory, 'directory', options.env ?? process.env);
    }
  }
}

function stableUserKey(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  homeDirectory: string,
  uid: number | undefined,
): string {
  if (platform !== 'win32' && uid !== undefined) {
    return `uid-${uid}`;
  }

  const account = env.USERNAME ?? env.USER ?? '';
  const material = `${account}\u0000${homeDirectory}`;
  return `user-${createHash('sha256').update(material).digest('hex').slice(0, 24)}`;
}

function reportFallbackWarning(options: RuntimeRootOptions, message: string): void {
  const warn = options.warn ?? console.warn;
  if (warnedFallbacks.has(message)) {
    return;
  }
  warnedFallbacks.add(message);
  warn(message);
}

function tryRoot(
  directory: string,
  source: RuntimeRootSource,
  options: RuntimeRootOptions,
): RuntimeRootSelection | undefined {
  try {
    ensurePrivateDirectorySync(directory, options);
    return { path: directory, source };
  } catch {
    return undefined;
  }
}

/**
 * Resolve and create the first private runtime root in the specified order.
 * The persistent Pi config/session directories are intentionally not consulted.
 */
export function resolveRuntimeRoot(options: RuntimeRootOptions = {}): RuntimeRootSelection {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const pathApi = pathApiFor(platform);
  const uid = currentUid(options);
  const homeDirectory =
    options.homeDirectory ??
    env.USERPROFILE ??
    env.HOME ??
    (platform === 'win32' ? homedir() : homedir());
  const temporaryDirectory = options.temporaryDirectory ?? tmpdir();
  const failures: string[] = [];

  const override = env[RUNTIME_DIR_ENV];
  if (override !== undefined) {
    const absoluteOverride = normalizeAbsolute(override, platform);
    if (absoluteOverride) {
      const selected = tryRoot(absoluteOverride, 'override', options);
      if (selected) {
        return selected;
      }
      failures.push(`${RUNTIME_DIR_ENV} is not a private directory`);
    } else {
      failures.push(`${RUNTIME_DIR_ENV} must be absolute`);
    }
  }

  if (platform !== 'win32') {
    const xdg = env[XDG_RUNTIME_DIR_ENV];
    const absoluteXdg = xdg === undefined ? undefined : normalizeAbsolute(xdg, platform);
    if (absoluteXdg && validatePrivateExistingDirectory(absoluteXdg, platform, uid)) {
      const selected = tryRoot(pathApi.join(absoluteXdg, 'pi-to-pi'), 'xdg', options);
      if (selected) {
        return selected;
      }
      failures.push(`${XDG_RUNTIME_DIR_ENV}/pi-to-pi cannot be made private`);
    } else {
      failures.push(`${XDG_RUNTIME_DIR_ENV} is unavailable or not private`);
    }
  } else {
    const localAppData = env[LOCAL_APP_DATA_ENV];
    const absoluteLocalAppData =
      localAppData === undefined ? undefined : normalizeAbsolute(localAppData, platform);
    if (absoluteLocalAppData) {
      const selected = tryRoot(
        pathApi.join(absoluteLocalAppData, 'pi-to-pi', 'runtime'),
        'local-app-data',
        options,
      );
      if (selected) {
        return selected;
      }
      failures.push(`${LOCAL_APP_DATA_ENV} runtime directory is not private`);
    } else {
      failures.push(`${LOCAL_APP_DATA_ENV} is unavailable or not absolute`);
    }
  }

  const absoluteTemporary = normalizeAbsolute(temporaryDirectory, platform);
  if (absoluteTemporary) {
    const key = stableUserKey(platform, env, homeDirectory, uid);
    const fallback = pathApi.join(absoluteTemporary, `pi-to-pi-${key}`);
    const selected = tryRoot(fallback, 'temporary', options);
    if (selected) {
      const warning =
        platform !== 'win32'
          ? `XDG_RUNTIME_DIR is unavailable or not private; using private temporary runtime root ${fallback}`
          : `A per-user LocalAppData runtime root is unavailable; using private temporary runtime root ${fallback}`;
      reportFallbackWarning(options, warning);
      return { ...selected, warning };
    }
    failures.push(`temporary runtime directory is not private: ${fallback}`);
  } else {
    failures.push('temporary directory is not absolute');
  }

  throw new RuntimeRootError(
    `Unable to establish a private Pi-to-Pi runtime root (${failures.join('; ')})`,
  );
}

/** Resolve only the path for callers that do not need source metadata. */
export function resolveRuntimeRootPath(options: RuntimeRootOptions = {}): string {
  return resolveRuntimeRoot(options).path;
}

/** Compatibility alias for registry callers that use a getter-style name. */
export const getRuntimeRoot = resolveRuntimeRoot;
