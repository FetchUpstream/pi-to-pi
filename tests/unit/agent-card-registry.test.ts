import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import nodePath from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  AGENT_CARD_PROTOCOL_VERSION,
  type AgentCard,
  createFallbackDisplayName,
  normalizeContextUsage,
  normalizeModel,
  normalizeOptionalText,
  resolveDisplayName,
} from '../../src/protocol/agent-card.js';
import {
  parseAgentCardJson,
  type AgentCardValidationCode,
  type AgentCardValidationResult,
  isAgentCard,
  isSafeRuntimeInstanceId,
  validateAgentCard,
  validateLiveAgentCard,
} from '../../src/protocol/validation.js';
import {
  buildAgentCardPath,
  buildAgentDirectoryPath,
  buildRegistryPaths,
  buildRoomDirectoryPath,
  PrivateFilesystemError,
} from '../../src/discovery/filesystem.js';
import { PRIVATE_DIRECTORY_MODE, resolveRuntimeRoot, RuntimeRootError } from '../../src/config.js';
import {
  assertRoomIdentity,
  isCanonicalRoomId,
  isRoomIdentity,
  isSafeStorageKey,
  validateRoomIdentity,
} from '../../src/room.js';

const RUNTIME_ID = 'runtime-1';
const ROOM_ID = 'room-1';
const STORAGE_KEY = 'room-key-1';
const RUNTIME_STARTED_AT = '2026-01-01T00:00:00.000Z';
const LEASE_EXPIRES_AT = '2026-01-01T00:01:30.000Z';

function makeCard(overrides: Partial<AgentCard> = {}): AgentCard {
  return {
    protocolVersion: AGENT_CARD_PROTOCOL_VERSION,
    sessionId: 'session-1',
    runtimeInstanceId: RUNTIME_ID,
    displayName: 'Pi runtime',
    roomId: ROOM_ID,
    purpose: null,
    workingDirectoryLabel: null,
    roleTags: [],
    model: null,
    capabilities: {
      structuredReplies: true,
      cancellation: true,
      statusUpdates: false,
      maxMessageSize: 1024,
      supportedContentTypes: ['text/plain'],
    },
    state: 'idle',
    contextUsage: null,
    inboundQueueDepth: 0,
    endpoint: {
      kind: 'unix',
      address: '/tmp/pi-to-pi.sock',
      runtimeInstanceId: RUNTIME_ID,
    },
    runtimeStartedAt: RUNTIME_STARTED_AT,
    leaseExpiresAt: LEASE_EXPIRES_AT,
    ...overrides,
  };
}

function expectIssue(
  result: AgentCardValidationResult,
  path: string,
  code: AgentCardValidationCode,
): void {
  expect(result.valid).toBe(false);
  expect(result.errors.some((error) => error.path === path && error.code === code)).toBe(true);
}

const temporaryRoots: string[] = [];

function makeTemporaryRoot(): string {
  const root = mkdtempSync(nodePath.join(tmpdir(), 'pi-to-pi-unit-'));
  chmodSync(root, PRIVATE_DIRECTORY_MODE);
  temporaryRoots.push(root);
  return root;
}

let windowsPathCounter = 0;

function makeWindowsPath(label: string): string {
  const profile = process.env.USERPROFILE ?? 'C:\\Users\\test-user';
  const path = nodePath.win32.join(
    profile,
    'AppData',
    'Local',
    `pi-to-pi-unit-${process.pid}-${windowsPathCounter++}-${label}`,
  );
  temporaryRoots.push(path);
  return path;
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('Agent Card schema and strict validation', () => {
  it('accepts a complete card with exact identity and room constraints', () => {
    const card = makeCard({
      purpose: 'review',
      workingDirectoryLabel: 'workspace',
      roleTags: ['reviewer'],
      model: { provider: 'openai', id: 'gpt-test' },
      contextUsage: { tokens: 42, percent: 7 },
    });

    const result = validateAgentCard(card, {
      expectedRoomId: ROOM_ID,
      expectedRuntimeInstanceId: RUNTIME_ID,
      expectedRecordFileName: `${RUNTIME_ID}.json`,
    });

    expect(result.valid).toBe(true);
    expect(result.card).toEqual(card);
    expect(isAgentCard(card, { expectedRoomId: ROOM_ID })).toBe(true);
    expect(parseAgentCardJson(JSON.stringify(card)).valid).toBe(true);
  });

  it('rejects unknown, forbidden, and oversized card data', () => {
    const unknownField = validateAgentCard({ ...makeCard(), unexpected: true });
    expectIssue(unknownField, '$.unexpected', 'invalid-value');
    const nestedUnknownField = validateAgentCard({
      ...makeCard(),
      capabilities: { ...makeCard().capabilities, unknownCapability: true },
    });
    expectIssue(nestedUnknownField, 'capabilities.unknownCapability', 'invalid-value');

    const forbiddenField = validateAgentCard({ ...makeCard(), prompt: 'do not store this' });
    expectIssue(forbiddenField, 'prompt', 'forbidden-field');

    const oversized = validateAgentCard(makeCard(), { maxCardSizeBytes: 1 });
    expectIssue(oversized, '$', 'card-too-large');
  });

  it('rejects non-object roots, unknown nested fields, and missing structural fields', () => {
    const cardWithoutRoleTags = { ...makeCard() } as Record<string, unknown>;
    delete cardWithoutRoleTags.roleTags;
    const cardWithoutCapabilities = { ...makeCard() } as Record<string, unknown>;
    delete cardWithoutCapabilities.capabilities;
    const cardWithoutEndpoint = { ...makeCard() } as Record<string, unknown>;
    delete cardWithoutEndpoint.endpoint;

    const cases: ReadonlyArray<{
      input: unknown;
      path: string;
      code: AgentCardValidationCode;
    }> = [
      { input: 'not-a-card', path: '$', code: 'invalid-type' },
      { input: [], path: '$', code: 'invalid-type' },
      {
        input: {
          ...makeCard(),
          model: { provider: 'openai', id: 'gpt-test', unexpected: true },
        },
        path: 'model.unexpected',
        code: 'invalid-value',
      },
      {
        input: {
          ...makeCard(),
          contextUsage: { tokens: 1, percent: 1, unexpected: true },
        },
        path: 'contextUsage.unexpected',
        code: 'invalid-value',
      },
      {
        input: { ...makeCard(), endpoint: { ...makeCard().endpoint, unexpected: true } },
        path: 'endpoint.unexpected',
        code: 'invalid-value',
      },
      { input: cardWithoutRoleTags, path: 'roleTags', code: 'missing-field' },
      { input: cardWithoutCapabilities, path: 'capabilities', code: 'missing-field' },
      { input: cardWithoutEndpoint, path: 'endpoint', code: 'missing-field' },
    ];

    for (const testCase of cases) {
      expectIssue(validateAgentCard(testCase.input), testCase.path, testCase.code);
    }
  });

  it('rejects unsupported versions, enum values, queue bounds, and malformed timestamps', () => {
    expectIssue(
      validateAgentCard({ ...makeCard(), protocolVersion: 2 }),
      'protocolVersion',
      'unsupported-version',
    );
    expectIssue(validateAgentCard({ ...makeCard(), state: 'offline' }), 'state', 'invalid-enum');
    expectIssue(
      validateAgentCard({ ...makeCard(), inboundQueueDepth: 10_001 }),
      'inboundQueueDepth',
      'invalid-value',
    );
    expectIssue(
      validateAgentCard({ ...makeCard(), runtimeStartedAt: 'not-a-timestamp' }),
      'runtimeStartedAt',
      'invalid-timestamp',
    );
    expectIssue(
      validateAgentCard({ ...makeCard(), leaseExpiresAt: RUNTIME_STARTED_AT }),
      'leaseExpiresAt',
      'invalid-timestamp',
    );
    expect(validateLiveAgentCard(makeCard(), { now: Date.parse(RUNTIME_STARTED_AT) }).valid).toBe(
      true,
    );
    expectIssue(
      validateLiveAgentCard(makeCard(), { now: Date.parse(LEASE_EXPIRES_AT) }),
      'leaseExpiresAt',
      'expired',
    );
    expect(parseAgentCardJson('{not-json').valid).toBe(false);
  });

  it('rejects invalid nested model, context, capability, and endpoint shapes', () => {
    expectIssue(
      validateAgentCard({ ...makeCard(), model: { provider: '', id: 'model' } }),
      'model.provider',
      'invalid-value',
    );
    expectIssue(
      validateAgentCard({ ...makeCard(), contextUsage: { tokens: 1 } }),
      'percent',
      'missing-field',
    );
    expectIssue(
      validateAgentCard({
        ...makeCard(),
        capabilities: {
          ...makeCard().capabilities,
          supportedContentTypes: ['text/plain', 'text/plain'],
        },
      }),
      'capabilities.supportedContentTypes[1]',
      'invalid-value',
    );
    expectIssue(
      validateAgentCard({
        ...makeCard(),
        endpoint: { ...makeCard().endpoint, kind: 'tcp' },
      }),
      'endpoint.kind',
      'invalid-enum',
    );
  });

  it('requires explicit nullable fields instead of silently accepting omissions', () => {
    const cardWithoutPurpose = { ...makeCard() } as Record<string, unknown>;
    delete cardWithoutPurpose.purpose;
    expectIssue(validateAgentCard(cardWithoutPurpose), 'purpose', 'missing-field');

    const cardWithoutModel = { ...makeCard() } as Record<string, unknown>;
    delete cardWithoutModel.model;
    expectIssue(validateAgentCard(cardWithoutModel), 'model', 'missing-field');

    const cardWithoutContext = { ...makeCard() } as Record<string, unknown>;
    delete cardWithoutContext.contextUsage;
    expectIssue(validateAgentCard(cardWithoutContext), 'contextUsage', 'missing-field');

    const cardWithoutWorkingDirectoryLabel = { ...makeCard() } as Record<string, unknown>;
    delete cardWithoutWorkingDirectoryLabel.workingDirectoryLabel;
    expectIssue(
      validateAgentCard(cardWithoutWorkingDirectoryLabel),
      'workingDirectoryLabel',
      'missing-field',
    );

    expect(validateAgentCard(makeCard()).valid).toBe(true);
    expect(
      validateAgentCard(
        makeCard({
          contextUsage: { tokens: null, percent: null },
          model: null,
          purpose: null,
          workingDirectoryLabel: null,
        }),
      ).valid,
    ).toBe(true);
  });
});

describe('Agent Card nullability and display-name rules', () => {
  it('normalizes unavailable model, context, and optional text explicitly', () => {
    expect(normalizeModel(undefined)).toBeNull();
    expect(normalizeModel(null)).toBeNull();
    expect(normalizeModel({ provider: 'openai', id: 'gpt-test' })).toEqual({
      provider: 'openai',
      id: 'gpt-test',
    });

    expect(normalizeContextUsage(undefined)).toBeNull();
    expect(normalizeContextUsage(null)).toBeNull();
    expect(normalizeContextUsage({})).toEqual({ tokens: null, percent: null });
    expect(normalizeContextUsage({ tokens: 0, percent: 0 })).toEqual({ tokens: 0, percent: 0 });

    expect(normalizeOptionalText(undefined)).toBeNull();
    expect(normalizeOptionalText('   ')).toBeNull();
    expect(normalizeOptionalText(' purpose ')).toBe('purpose');
  });

  it('derives a stable non-secret fallback display name only when the session name is unset', () => {
    const runtimeId = 'runtime-AB12';
    const fallback = createFallbackDisplayName(runtimeId);

    expect(fallback).toBe('pi-to-pi-runtimeAB12');
    expect(resolveDisplayName(null, runtimeId)).toBe(fallback);
    expect(resolveDisplayName(undefined, runtimeId)).toBe(fallback);
    expect(resolveDisplayName('', runtimeId)).toBe(fallback);
    expect(resolveDisplayName('   ', runtimeId)).toBe(fallback);
    expect(resolveDisplayName('  Named session  ', runtimeId)).toBe('Named session');
    expect(fallback).not.toContain(runtimeId);
  });

  it('accepts a generated fallback while rejecting blank display metadata', () => {
    const fallbackCard = makeCard({ displayName: resolveDisplayName(undefined, RUNTIME_ID) });
    expect(validateAgentCard(fallbackCard).valid).toBe(true);
    expectIssue(
      validateAgentCard({ ...makeCard(), displayName: '   ' }),
      'displayName',
      'invalid-value',
    );
  });
});

describe('Agent Card identity and room/path safety', () => {
  it('requires runtime identity, endpoint identity, room identity, and record filename to agree', () => {
    expectIssue(
      validateAgentCard(makeCard(), { expectedRuntimeInstanceId: 'runtime-2' }),
      'runtimeInstanceId',
      'identity-mismatch',
    );
    expectIssue(
      validateAgentCard(makeCard(), { expectedRecordFileName: 'runtime-2.json' }),
      'runtimeInstanceId',
      'identity-mismatch',
    );
    expectIssue(
      validateAgentCard(
        makeCard({ endpoint: { ...makeCard().endpoint, runtimeInstanceId: 'runtime-2' } }),
      ),
      'endpoint.runtimeInstanceId',
      'identity-mismatch',
    );
    expectIssue(
      validateAgentCard(makeCard(), { expectedRoomId: 'room-2' }),
      'roomId',
      'room-mismatch',
    );
  });

  it('accepts canonical room identities and safe storage keys only', () => {
    const identity = { roomId: ROOM_ID, storageKey: STORAGE_KEY };
    const result = validateRoomIdentity(identity);

    expect(result).toEqual({ valid: true, value: identity, errors: [] });
    expect(isCanonicalRoomId(ROOM_ID)).toBe(true);
    expect(isSafeStorageKey(STORAGE_KEY)).toBe(true);
    expect(isRoomIdentity(identity)).toBe(true);
    expect(() => assertRoomIdentity(identity)).not.toThrow();

    for (const roomId of ['../room', 'room/name', ' room', 'room ']) {
      expect(isCanonicalRoomId(roomId)).toBe(false);
      expect(validateRoomIdentity({ roomId, storageKey: STORAGE_KEY }).valid).toBe(false);
    }
    for (const storageKey of ['../escape', 'room/key', 'CON', 'unsafe.', 'unsafe ']) {
      expect(isSafeStorageKey(storageKey)).toBe(false);
      expect(validateRoomIdentity({ roomId: ROOM_ID, storageKey }).valid).toBe(false);
    }
  });

  it('uses the supplied storage key for paths and rejects unsafe path identities', () => {
    const root = nodePath.join(tmpdir(), 'pi-to-pi-path-fixture');
    const paths = buildRegistryPaths(root, { roomId: ROOM_ID, storageKey: STORAGE_KEY });

    expect(paths.roomId).toBe(ROOM_ID);
    expect(paths.storageKey).toBe(STORAGE_KEY);
    expect(paths.roomDirectory).toBe(nodePath.join(root, 'rooms', STORAGE_KEY));
    expect(paths.agentsDirectory).toBe(nodePath.join(root, 'rooms', STORAGE_KEY, 'agents'));
    expect(buildRoomDirectoryPath(root, STORAGE_KEY)).toBe(paths.roomDirectory);
    expect(buildAgentDirectoryPath(root, STORAGE_KEY)).toBe(paths.agentsDirectory);
    expect(buildAgentCardPath(root, STORAGE_KEY, RUNTIME_ID)).toBe(
      nodePath.join(paths.agentsDirectory, `${RUNTIME_ID}.json`),
    );

    expect(() => buildRegistryPaths(root, { roomId: ROOM_ID, storageKey: '../escape' })).toThrow(
      PrivateFilesystemError,
    );
    expect(() => buildAgentCardPath(root, STORAGE_KEY, '../runtime')).toThrow(
      PrivateFilesystemError,
    );
  });

  it('rejects unsafe runtime identities in validation and path construction', () => {
    const root = nodePath.join(tmpdir(), 'pi-to-pi-runtime-identity-fixture');
    const unsafeRuntimeIds = ['CON', 'runtime.', 'runtime ', 'runtime/name', 'runtime\\\\name'];

    for (const runtimeInstanceId of unsafeRuntimeIds) {
      const card = makeCard({
        runtimeInstanceId,
        endpoint: { ...makeCard().endpoint, runtimeInstanceId },
      });

      expect(isSafeRuntimeInstanceId(runtimeInstanceId)).toBe(false);
      expectIssue(validateAgentCard(card), 'runtimeInstanceId', 'invalid-value');
      expect(() => buildAgentCardPath(root, STORAGE_KEY, runtimeInstanceId)).toThrow(
        PrivateFilesystemError,
      );
    }
  });
});

describe('runtime-root selection', () => {
  const describePosix = process.platform === 'win32' ? describe.skip : describe;

  describePosix('on POSIX', () => {
    const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;

    it('prefers an absolute private override over XDG_RUNTIME_DIR', () => {
      if (uid === undefined) {
        return;
      }
      const parent = makeTemporaryRoot();
      const override = nodePath.join(parent, 'override');
      const xdg = makeTemporaryRoot();
      const selection = resolveRuntimeRoot({
        platform: 'linux',
        uid,
        env: { PI_TO_PI_RUNTIME_DIR: override, XDG_RUNTIME_DIR: xdg },
        temporaryDirectory: parent,
        warn: vi.fn(),
      });

      expect(selection).toMatchObject({ path: override, source: 'override' });
      expect(statSync(override).mode & 0o777).toBe(0o700);
    });

    it('selects a private XDG child when no override is usable', () => {
      if (uid === undefined) {
        return;
      }
      const xdg = makeTemporaryRoot();
      const insecureOverride = makeTemporaryRoot();
      chmodSync(insecureOverride, 0o755);
      const temporaryDirectory = makeTemporaryRoot();
      const selection = resolveRuntimeRoot({
        platform: 'linux',
        uid,
        env: { PI_TO_PI_RUNTIME_DIR: insecureOverride, XDG_RUNTIME_DIR: xdg },
        temporaryDirectory,
        warn: vi.fn(),
      });

      expect(selection).toMatchObject({
        path: nodePath.join(xdg, 'pi-to-pi'),
        source: 'xdg',
      });
      expect(statSync(selection.path).mode & 0o777).toBe(0o700);
    });

    it('falls back to a deterministic private per-user temporary root with a warning', () => {
      if (uid === undefined) {
        return;
      }
      const invalidXdg = makeTemporaryRoot();
      chmodSync(invalidXdg, 0o755);
      const temporaryDirectory = makeTemporaryRoot();
      const warn = vi.fn<(message: string) => void>();
      const selection = resolveRuntimeRoot({
        platform: 'linux',
        uid,
        env: { XDG_RUNTIME_DIR: invalidXdg },
        homeDirectory: '/home/test-user',
        temporaryDirectory,
        warn,
      });
      const expectedPath = nodePath.join(temporaryDirectory, `pi-to-pi-uid-${uid}`);

      expect(selection).toMatchObject({ path: expectedPath, source: 'temporary' });
      expect(selection.warning).toContain('private temporary runtime root');
      expect(warn).toHaveBeenCalledWith(selection.warning);
      expect(statSync(expectedPath).mode & 0o777).toBe(0o700);

      const secondSelection = resolveRuntimeRoot({
        platform: 'linux',
        uid,
        env: { XDG_RUNTIME_DIR: invalidXdg },
        homeDirectory: '/home/test-user',
        temporaryDirectory,
        warn,
      });
      expect(secondSelection.path).toBe(expectedPath);
      expect(warn).toHaveBeenCalledTimes(1);
    });

    it('fails closed when an existing temporary fallback directory is not private', () => {
      if (uid === undefined) {
        return;
      }
      const temporaryDirectory = makeTemporaryRoot();
      const fallback = nodePath.join(temporaryDirectory, `pi-to-pi-uid-${uid}`);
      mkdirSync(fallback);
      chmodSync(fallback, 0o755);

      expect(statSync(fallback).mode & 0o777).toBe(0o755);
      expect(() =>
        resolveRuntimeRoot({
          platform: 'linux',
          uid,
          env: {},
          temporaryDirectory,
          warn: vi.fn(),
        }),
      ).toThrow(RuntimeRootError);
    });

    it('fails closed when no absolute private fallback can be established', () => {
      expect(() =>
        resolveRuntimeRoot({
          platform: 'linux',
          env: {},
          temporaryDirectory: 'relative-temp',
          uid,
          warn: vi.fn(),
        }),
      ).toThrow(RuntimeRootError);
    });
  });

  describe('on Windows via injected platform', () => {
    it('selects a usable LocalAppData runtime root with ACL protection', () => {
      const localAppData = makeWindowsPath('local-app-data');
      const temporaryDirectory = makeWindowsPath('temporary');
      const expectedPath = nodePath.win32.join(localAppData, 'pi-to-pi', 'runtime');
      temporaryRoots.push(expectedPath);
      const protectWindowsPath = vi.fn<(target: string) => void>();
      const selection = resolveRuntimeRoot({
        platform: 'win32',
        env: { LOCALAPPDATA: localAppData, USERNAME: 'unit-user' },
        temporaryDirectory,
        homeDirectory: nodePath.win32.join(localAppData, 'home'),
        protectWindowsPath,
        warn: vi.fn(),
      });

      expect(selection).toMatchObject({ path: expectedPath, source: 'local-app-data' });
      expect(selection.path).toBe(expectedPath);
      expect(protectWindowsPath.mock.calls.map(([target]) => target)).toEqual(
        process.platform === 'win32' ? [expectedPath] : [],
      );
    });

    it('falls back to a private temporary root when LocalAppData is unusable', () => {
      const temporaryDirectory = makeWindowsPath('temporary-fallback');
      const protectWindowsPath = vi.fn<(target: string) => void>();
      const warn = vi.fn<(message: string) => void>();
      const selection = resolveRuntimeRoot({
        platform: 'win32',
        env: { LOCALAPPDATA: 'relative-local-app-data', USERNAME: 'unit-user' },
        temporaryDirectory,
        homeDirectory: nodePath.win32.join(temporaryDirectory, 'home'),
        protectWindowsPath,
        warn,
      });
      temporaryRoots.push(selection.path);

      expect(selection.source).toBe('temporary');
      expect(nodePath.win32.dirname(selection.path)).toBe(temporaryDirectory);
      expect(nodePath.win32.basename(selection.path)).toMatch(/^pi-to-pi-user-[0-9a-f]{24}$/u);
      expect(selection.warning).toContain('LocalAppData runtime root is unavailable');
      expect(warn).toHaveBeenCalledWith(selection.warning);
      expect(protectWindowsPath.mock.calls.map(([target]) => target)).toEqual(
        process.platform === 'win32' ? [selection.path] : [],
      );
    });
  });
});
