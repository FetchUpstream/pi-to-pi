import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

import { asProjectName, type ProjectName } from './identity.js';

/** Names registered through Pi's extension flag API. */
export const P2P_NAME_FLAG = 'p2p-name' as const;
export const P2P_PROJECT_FLAG = 'p2p-project' as const;

/** Raw explicit name override, retained for the naming normalization seam. */
declare const p2pNameOverrideBrand: unique symbol;
export type P2PNameOverride = string & { readonly [p2pNameOverrideBrand]: 'P2PNameOverride' };

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
  readonly nameOverride?: unknown;
  readonly projectOverride?: unknown;
  readonly sessionName?: string;
}

/** Effective process-level P2P configuration for one runtime. */
export interface P2PConfig {
  /** Effective display-name input; naming normalization runs in the naming seam. */
  readonly name: string;
  /** Whether the effective name came from an explicit override or fallback. */
  readonly nameSource: P2PNameSource;
  /** Explicit `--p2p-name`, when configured. */
  readonly nameOverride?: P2PNameOverride;
  /** Explicit `--p2p-project`, when configured. */
  readonly projectOverride?: ProjectName;
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
 * This function deliberately preserves raw label text. NFKC/lowercase and
 * punctuation normalization belong to the naming/room derivation waves; this
 * boundary only validates values that Pi's string flag API can provide and
 * records explicit-value precedence.
 */
export function resolveP2PConfig(options: ResolveP2PConfigOptions = {}): P2PConfig {
  const nameInput = firstDefined(options.p2pName, options.nameOverride, options.flags?.p2pName);
  const projectInput = firstDefined(
    options.p2pProject,
    options.projectOverride,
    options.flags?.p2pProject,
  );

  const nameOverride = validateLabel(nameInput, P2P_NAME_FLAG) as P2PNameOverride | undefined;
  const projectOverride = validateLabel(projectInput, P2P_PROJECT_FLAG);
  const sessionName =
    options.sessionName && options.sessionName.length > 0 ? options.sessionName : undefined;

  let nameSource: P2PNameSource;
  if (nameOverride !== undefined) {
    nameSource = 'p2p-name';
  } else if (sessionName !== undefined) {
    nameSource = 'session-name';
  } else {
    nameSource = 'fallback';
  }

  return Object.freeze({
    name: nameOverride ?? sessionName ?? 'agent',
    nameSource,
    ...(nameOverride === undefined ? {} : { nameOverride }),
    ...(projectOverride === undefined ? {} : { projectOverride: asProjectName(projectOverride) }),
  });
}

/** Short alias for consumers that use the generic configuration terminology. */
export const resolveConfig = resolveP2PConfig;

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
): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string') {
    throw new P2PConfigurationError(option, 'a string value is required');
  }
  if (value.length === 0) {
    throw new P2PConfigurationError(option, 'the value must not be empty');
  }
  if (hasControlCharacter(value)) {
    throw new P2PConfigurationError(option, 'control characters are not allowed');
  }
  if (!/[\p{L}\p{N}]/u.test(value)) {
    throw new P2PConfigurationError(option, 'the value must contain a letter or number');
  }
  return value;
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f)) {
      return true;
    }
  }
  return false;
}
