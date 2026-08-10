import { createHash } from 'node:crypto';

import { asNormalizedName, asRuntimeId, type NormalizedName, type RuntimeId } from '../identity.js';

/** The fallback used when neither a P2P override nor a native session name exists. */
export const DEFAULT_NETWORK_BASE = 'agent' as const;
/** Lowercase Crockford alphabet (ambiguous I, L, O, and U are omitted). */
export const CROCKFORD_BASE32_ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz' as const;
/** Number of Crockford characters appended to every runtime name. */
export const RUNTIME_NAME_SUFFIX_LENGTH = 4;

const SUFFIX_PATTERN = /^[0-9a-hjkmnp-tv-z]{4}$/u;

declare const suffixBrand: unique symbol;
declare const publishedNameBrand: unique symbol;

/** A four-character lowercase Crockford-base32 runtime suffix. */
export type RuntimeNameSuffix = string & { readonly [suffixBrand]: 'RuntimeNameSuffix' };

/** A canonical published name consisting of a normalized base and runtime suffix. */
export type PublishedNetworkName = string & {
  readonly [publishedNameBrand]: 'PublishedNetworkName';
};

/** Pure name state for one runtime; display and published values are distinct. */
export interface PublishedPeerName {
  readonly runtimeId: RuntimeId;
  readonly base: NormalizedName;
  readonly suffix: RuntimeNameSuffix;
  readonly networkName: PublishedNetworkName;
}

/** Normalize a human-facing name, using the documented `agent` fallback. */
export function normalizePeerName(value?: string): NormalizedName {
  return value === undefined ? asNormalizedName(DEFAULT_NETWORK_BASE) : asNormalizedName(value);
}

/** Normalize a native Pi name, falling back when the native value is unusable. */
export function normalizeSessionPeerName(value?: string): NormalizedName {
  if (value === undefined) {
    return asNormalizedName(DEFAULT_NETWORK_BASE);
  }

  try {
    return asNormalizedName(value);
  } catch {
    return asNormalizedName(DEFAULT_NETWORK_BASE);
  }
}

/** Normalize a lookup key, accepting a full published name above the base limit. */
export function normalizePeerLookupName(value: string): string {
  if (typeof value !== 'string') {
    throw new TypeError('peer lookup name must be a string');
  }

  let normalized: string;
  try {
    normalized = value.normalize('NFKC').toLowerCase();
  } catch {
    throw new TypeError('peer lookup name is not valid Unicode text');
  }

  const separator = normalized.lastIndexOf('-');
  if (separator > 0 && isRuntimeNameSuffix(normalized.slice(separator + 1))) {
    try {
      const base = asNormalizedName(normalized.slice(0, separator));
      if (base === normalized.slice(0, separator)) {
        return `${base}-${normalized.slice(separator + 1)}`;
      }
    } catch {
      // Fall through to ordinary base-name normalization for malformed input.
    }
  }

  return asNormalizedName(normalized);
}

/** Return whether a value has the exact lowercase Crockford suffix syntax. */
export function isRuntimeNameSuffix(value: unknown): value is RuntimeNameSuffix {
  return typeof value === 'string' && SUFFIX_PATTERN.test(value);
}

/**
 * Derive four Crockford-base32 characters from the first twenty bits of the
 * SHA-256 digest of the full runtime UUID.
 */
export function runtimeNameSuffix(runtimeId: RuntimeId | string): RuntimeNameSuffix {
  const canonicalRuntimeId = asRuntimeId(runtimeId);
  const digest = createHash('sha256').update(canonicalRuntimeId, 'utf8').digest();
  const firstTwentyBits = digest.readUIntBE(0, 3) >>> 4;
  let suffix = '';

  for (let index = RUNTIME_NAME_SUFFIX_LENGTH - 1; index >= 0; index -= 1) {
    const alphabetIndex = (firstTwentyBits >>> (index * 5)) & 0x1f;
    suffix += CROCKFORD_BASE32_ALPHABET[alphabetIndex];
  }

  return suffix as RuntimeNameSuffix;
}

/** Return whether a value is a canonical published base-plus-suffix name. */
export function isPublishedNetworkName(value: unknown): value is PublishedNetworkName {
  if (typeof value !== 'string') {
    return false;
  }

  const separator = value.lastIndexOf('-');
  if (separator <= 0 || !isRuntimeNameSuffix(value.slice(separator + 1))) {
    return false;
  }

  const base = value.slice(0, separator);
  try {
    return asNormalizedName(base) === base;
  } catch {
    return false;
  }
}

/** Validate and brand a full published network name. */
export function asPublishedNetworkName(value: string): PublishedNetworkName {
  if (!isPublishedNetworkName(value)) {
    throw new TypeError(`Invalid published network name: ${JSON.stringify(value)}`);
  }
  return value;
}

/** Extract the normalized base from a canonical published network name. */
export function publishedNetworkBase(value: PublishedNetworkName | string): NormalizedName {
  const published = asPublishedNetworkName(String(value));
  return asNormalizedName(published.slice(0, published.lastIndexOf('-')));
}

/** Build the canonical `<base>-<runtime-suffix>` network name. */
export function buildNetworkName(
  base: NormalizedName | string,
  runtimeId: RuntimeId | string,
): PublishedNetworkName {
  const normalizedBase = asNormalizedName(String(base));
  const suffix = runtimeNameSuffix(runtimeId);
  return `${normalizedBase}-${suffix}` as PublishedNetworkName;
}

/** Construct the complete pure name state for one runtime. */
export function createPublishedPeerName(
  base: NormalizedName | string | undefined,
  runtimeId: RuntimeId | string,
): PublishedPeerName {
  const normalizedBase = normalizePeerName(base);
  const canonicalRuntimeId = asRuntimeId(runtimeId);
  const suffix = runtimeNameSuffix(canonicalRuntimeId);

  return Object.freeze({
    runtimeId: canonicalRuntimeId,
    base: normalizedBase,
    suffix,
    networkName: buildNetworkName(normalizedBase, canonicalRuntimeId),
  });
}

/** Create the initial name state, using the native-name fallback rules. */
export function createInitialPeerName(
  runtimeId: RuntimeId | string,
  sessionName?: string,
): PublishedPeerName {
  return createPublishedPeerName(normalizeSessionPeerName(sessionName), runtimeId);
}

export interface SynchronizePeerNameOptions {
  /** Explicit `--p2p-name`; when present, native session names are ignored. */
  readonly p2pName?: NormalizedName | string;
}

/**
 * Pure synchronization seam for `session_info_changed`.
 *
 * The runtime ID and derived suffix remain unchanged. An explicit P2P override
 * is validated but leaves the current publication untouched; otherwise the
 * native name is normalized and published with the same runtime suffix.
 */
export function synchronizePeerName(
  current: PublishedPeerName,
  sessionName: string | undefined,
  options: SynchronizePeerNameOptions = {},
): PublishedPeerName {
  if (options.p2pName !== undefined) {
    asNormalizedName(String(options.p2pName));
    return current;
  }

  const base = normalizeSessionPeerName(sessionName);
  return Object.freeze({
    runtimeId: current.runtimeId,
    base,
    suffix: current.suffix,
    networkName: buildNetworkName(base, current.runtimeId),
  });
}

/** Return the base and suffix components of a canonical published name. */
export function splitPublishedNetworkName(value: PublishedNetworkName | string): {
  readonly base: NormalizedName;
  readonly suffix: RuntimeNameSuffix;
} {
  const published = asPublishedNetworkName(String(value));
  const separator = published.lastIndexOf('-');
  return Object.freeze({
    base: asNormalizedName(published.slice(0, separator)),
    suffix: published.slice(separator + 1) as RuntimeNameSuffix,
  });
}
