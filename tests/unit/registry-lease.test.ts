import { chmod, readFile, readdir, stat, symlink, writeFile } from 'node:fs/promises';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
const renameMock = vi.hoisted(() => vi.fn());
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  renameMock.mockImplementation(actual.rename);
  return { ...actual, rename: renameMock };
});

import {
  DEFAULT_LEASE_RENEWAL_INTERVAL_MS,
  DEFAULT_LEASE_TTL_MS,
  SerializedLease,
  filterUnexpiredRecords,
  isLeaseExpired,
  leaseExpiration,
} from '../../src/discovery/lease.js';
import {
  PRIVATE_DIRECTORY_MODE,
  PRIVATE_FILE_MODE,
  RuntimeRegistry,
  createRuntimeRecord,
  getRegistryPaths,
  getRuntimeRecordPath,
  handleEndpointFailure,
  listRuntimeRecords,
  parseRuntimeRecordJson,
  publishRuntimeRecordAtomically,
  readRuntimeRecord,
  removeRuntimeRecord,
  serializeRuntimeRecord,
  validateRuntimeRecord,
} from '../../src/discovery/registry.js';
import { buildNetworkName } from '../../src/discovery/naming.js';
const ROOM_ID = `r1-${'a'.repeat(32)}`;
const OTHER_ROOM_ID = `r1-${'b'.repeat(32)}`;
const RUNTIME_A = '11111111-1111-4111-8111-111111111111';
const RUNTIME_B = '22222222-2222-4222-8222-222222222222';
const RUNTIME_C = '33333333-3333-4333-8333-333333333333';

const temporaryDirectories: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'pi-to-pi-registry-'));
  temporaryDirectories.push(root);
  return root;
}

function record(runtimeId: string, roomId = ROOM_ID, now = 1_000, ttlMs = DEFAULT_LEASE_TTL_MS) {
  return createRuntimeRecord({
    runtimeId,
    sessionId: `session-${runtimeId.slice(0, 4)}`,
    roomId,
    networkName: 'planner',
    endpoint: `/tmp/pi-to-pi-${runtimeId.slice(0, 4)}`,
    now,
    ttlMs,
  });
}

class OrderedPublicationRegistry extends RuntimeRegistry {
  private publicationCount = 0;
  private releaseBlockedRenewal: (() => void) | undefined;
  private resolveRenewalStarted: (() => void) | undefined;
  public readonly renewalStarted = new Promise<void>((resolve) => {
    this.resolveRenewalStarted = resolve;
  });
  public readonly observedNames: string[] = [];

  public releaseBlockedRenewalNow(): void {
    this.releaseBlockedRenewal?.();
    this.releaseBlockedRenewal = undefined;
  }

  protected override async publishCurrentName(): Promise<void> {
    this.publicationCount += 1;
    if (this.publicationCount === 2) {
      this.resolveRenewalStarted?.();
      await new Promise<void>((resolve) => {
        this.releaseBlockedRenewal = resolve;
      });
    }
    this.observedNames.push(this.networkName);
    if (this.publicationCount === 3) {
      throw new Error('rename publication fails');
    }
    await super.publishCurrentName();
  }
}

class FailedPublicationThenRenewalRegistry extends RuntimeRegistry {
  private publicationCount = 0;
  private resolveRenameCommitted: (() => void) | undefined;
  private releaseRenameFailure: (() => void) | undefined;
  private resolveRenewalStarted: (() => void) | undefined;
  private releaseRenewal: (() => void) | undefined;
  public readonly renameCommitted = new Promise<void>((resolve) => {
    this.resolveRenameCommitted = resolve;
  });
  public readonly renewalStarted = new Promise<void>((resolve) => {
    this.resolveRenewalStarted = resolve;
  });
  public readonly observedNames: string[] = [];

  public releaseRenameFailureNow(): void {
    this.releaseRenameFailure?.();
    this.releaseRenameFailure = undefined;
  }

  public releaseRenewalNow(): void {
    this.releaseRenewal?.();
    this.releaseRenewal = undefined;
  }

  protected override async publishCurrentName(): Promise<void> {
    this.publicationCount += 1;
    const publicationNumber = this.publicationCount;
    if (publicationNumber === 3) {
      this.resolveRenewalStarted?.();
      await new Promise<void>((resolve) => {
        this.releaseRenewal = resolve;
      });
    }
    this.observedNames.push(this.networkName);
    await super.publishCurrentName();
    if (publicationNumber === 2) {
      this.resolveRenameCommitted?.();
      await new Promise<void>((resolve) => {
        this.releaseRenameFailure = resolve;
      });
      throw new Error('rename publication fails after commit');
    }
  }
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('runtime record validation and atomic publication', () => {
  it('requires all ownership and routing fields and rejects malformed records', () => {
    const valid = record(RUNTIME_A);
    expect(validateRuntimeRecord(valid)).toMatchObject({ valid: true, record: valid });
    expect(parseRuntimeRecordJson(serializeRuntimeRecord(valid))).toMatchObject({
      valid: true,
      record: valid,
    });

    expect(validateRuntimeRecord({ ...valid, runtimeId: 'runtime-a' }).valid).toBe(false);
    expect(validateRuntimeRecord({ ...valid, networkName: 'Planner' }).valid).toBe(false);
    expect(validateRuntimeRecord({ ...valid, sessionId: 'bad session' }).valid).toBe(false);
    expect(validateRuntimeRecord({ ...valid, sessionId: 'session-' }).valid).toBe(false);
    expect(
      () =>
        new RuntimeRegistry({
          runtimeId: RUNTIME_A,
          sessionId: 'bad session',
          roomId: ROOM_ID,
          networkName: 'planner',
          endpoint: '/tmp/endpoint-a',
        }),
    ).toThrow('invalid');
    expect(validateRuntimeRecord({ ...valid, roomId: '../room' }).valid).toBe(false);
    expect(validateRuntimeRecord({ ...valid, endpoint: 'bad\nendpoint' }).valid).toBe(false);
    expect(validateRuntimeRecord({ ...valid, extra: true }).valid).toBe(false);
    for (const [field, value] of [
      ['runtimeId', 123],
      ['runtimeId', 'abcdefab-cdef-4abc-8def-abcdefabcdef'.toUpperCase()],
      ['sessionId', 123],
      ['roomId', 123],
      ['networkName', 123],
      ['endpoint', 123],
      ['leaseExpiresAt', '2030-01-01T00:00:00.000Z'],
    ] as const) {
      const malformed = { ...valid, [field]: value };
      expect(validateRuntimeRecord(malformed).valid).toBe(false);
      expect(parseRuntimeRecordJson(JSON.stringify(malformed)).valid).toBe(false);
    }
    expect(parseRuntimeRecordJson('{not-json').valid).toBe(false);
  });

  it('persists canonical full published names at the maximum base length', async () => {
    const root = await temporaryRoot();
    const networkName = buildNetworkName('a'.repeat(48), RUNTIME_A);
    const published = { ...record(RUNTIME_A), networkName };

    expect(validateRuntimeRecord(published)).toMatchObject({ valid: true, record: published });
    expect(parseRuntimeRecordJson(serializeRuntimeRecord(published))).toMatchObject({
      valid: true,
      record: published,
    });
    await publishRuntimeRecordAtomically(published, { rootDirectory: root });
    expect(
      await readRuntimeRecord(ROOM_ID, RUNTIME_A, { rootDirectory: root, now: 1_000 }),
    ).toEqual(published);

    const registry = new RuntimeRegistry({
      runtimeId: RUNTIME_A,
      sessionId: published.sessionId,
      roomId: ROOM_ID,
      networkName,
      endpoint: published.endpoint,
      rootDirectory: root,
      now: 1_000,
    });
    await registry.start();
    expect(registry.current()?.networkName).toBe(networkName);
    expect(
      await readRuntimeRecord(ROOM_ID, RUNTIME_A, { rootDirectory: root, now: 1_000 }),
    ).toEqual(registry.current());
    await registry.shutdown();
  });
  it('rejects a published suffix owned by another runtime', async () => {
    const root = await temporaryRoot();
    const owner = record(RUNTIME_A);
    const wrongSuffix = {
      ...owner,
      networkName: buildNetworkName('planner', RUNTIME_B),
    };

    const validation = validateRuntimeRecord(wrongSuffix);
    expect(validation.valid).toBe(false);
    expect(validation.errors).toContainEqual({
      field: 'networkName',
      message: 'must be a canonical network name',
    });
    expect(parseRuntimeRecordJson(JSON.stringify(wrongSuffix)).valid).toBe(false);
    await expect(
      publishRuntimeRecordAtomically(wrongSuffix, { rootDirectory: root }),
    ).rejects.toThrow('networkName');

    expect(
      () =>
        new RuntimeRegistry({
          runtimeId: RUNTIME_A,
          sessionId: owner.sessionId,
          roomId: ROOM_ID,
          networkName: wrongSuffix.networkName,
          endpoint: owner.endpoint,
          rootDirectory: root,
          now: 1_000,
        }),
    ).toThrow('networkName must be a canonical base or published network name');
  });

  it('publishes a complete record atomically under a full runtime UUID key', async () => {
    const root = await temporaryRoot();
    const published = record(RUNTIME_A);
    const path = await publishRuntimeRecordAtomically(published, { rootDirectory: root });
    const paths = getRegistryPaths(ROOM_ID, { rootDirectory: root });
    const expected = getRuntimeRecordPath(ROOM_ID, RUNTIME_A, { rootDirectory: root });

    expect(path).toBe(expected);
    expect(path).toBe(join(paths.recordsDirectory, `${RUNTIME_A}.json`));
    expect(
      await readRuntimeRecord(ROOM_ID, RUNTIME_A, { rootDirectory: root, now: 1_000 }),
    ).toEqual(published);
    expect(
      (await readdir(paths.recordsDirectory)).filter((name) => name.includes('.tmp-')),
    ).toEqual([]);
    expect((await stat(root)).mode & 0o7777).toBe(PRIVATE_DIRECTORY_MODE);
    expect((await stat(path)).mode & 0o7777).toBe(PRIVATE_FILE_MODE);
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(published);
  });

  it('rejects POSIX special mode bits on registry directories and records', async () => {
    if (process.platform === 'win32') {
      return;
    }
    const root = await temporaryRoot();
    await publishRuntimeRecordAtomically(record(RUNTIME_A), { rootDirectory: root });
    const paths = getRegistryPaths(ROOM_ID, { rootDirectory: root });
    const modeWithSetgid = PRIVATE_DIRECTORY_MODE | 0o2000;
    await chmod(paths.recordsDirectory, modeWithSetgid);
    await expect(
      publishRuntimeRecordAtomically(record(RUNTIME_B), { rootDirectory: root }),
    ).rejects.toThrow('not private');
    await chmod(paths.recordsDirectory, PRIVATE_DIRECTORY_MODE);

    const recordPath = getRuntimeRecordPath(ROOM_ID, RUNTIME_A, { rootDirectory: root });
    await chmod(recordPath, PRIVATE_FILE_MODE | 0o4000);
    expect(
      await readRuntimeRecord(ROOM_ID, RUNTIME_A, { rootDirectory: root, now: 1_000 }),
    ).toBeUndefined();
  });

  it('keeps concurrent runtime publications as separate complete records', async () => {
    const root = await temporaryRoot();
    const records = [RUNTIME_A, RUNTIME_B, RUNTIME_C].map((runtimeId) => record(runtimeId));
    await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        publishRuntimeRecordAtomically(records[index % records.length]!, { rootDirectory: root }),
      ),
    );

    const discovered = await listRuntimeRecords(ROOM_ID, { rootDirectory: root, now: 1_000 });
    expect(discovered.map((entry) => entry.runtimeId).sort()).toEqual(
      [RUNTIME_A, RUNTIME_B, RUNTIME_C].sort(),
    );
    expect(discovered.every((entry) => entry.roomId === ROOM_ID && entry.endpoint.length > 0)).toBe(
      true,
    );
  });
});

describe('lease expiry and stale-record handling', () => {
  it('uses the ten-second renewal and thirty-second expiry bounds', () => {
    expect(DEFAULT_LEASE_RENEWAL_INTERVAL_MS).toBe(10_000);
    expect(DEFAULT_LEASE_TTL_MS).toBe(30_000);
    expect(leaseExpiration({ now: 0 })).toBe(30_000);
    expect(isLeaseExpired(30_000, 29_999)).toBe(false);
    expect(isLeaseExpired(30_000, 30_000)).toBe(true);
    expect(filterUnexpiredRecords([{ leaseExpiresAt: 30_000 }, { leaseExpiresAt: 1 }], 2)).toEqual([
      { leaseExpiresAt: 30_000 },
    ]);
  });

  it('ignores expired, malformed, cross-room, symlinked, and incorrectly keyed records', async () => {
    const root = await temporaryRoot();
    await publishRuntimeRecordAtomically(record(RUNTIME_A), { rootDirectory: root });
    await publishRuntimeRecordAtomically(record(RUNTIME_B, ROOM_ID, 1_000, 1), {
      rootDirectory: root,
    });
    await publishRuntimeRecordAtomically(record(RUNTIME_C, OTHER_ROOM_ID), { rootDirectory: root });

    const paths = getRegistryPaths(ROOM_ID, { rootDirectory: root });
    await writeFile(join(paths.recordsDirectory, `${RUNTIME_C}.json`), '{malformed', {
      mode: PRIVATE_FILE_MODE,
    });
    await writeFile(join(paths.recordsDirectory, 'not-a-runtime.json'), '{}', {
      mode: PRIVATE_FILE_MODE,
    });
    await symlink(
      getRuntimeRecordPath(ROOM_ID, RUNTIME_A, { rootDirectory: root }),
      join(paths.recordsDirectory, `${RUNTIME_B}.json.link`),
    );

    const discovered = await listRuntimeRecords(ROOM_ID, { rootDirectory: root, now: 2_000 });
    expect(discovered.map((entry) => entry.runtimeId)).toEqual([RUNTIME_A]);
    expect(
      await readRuntimeRecord(ROOM_ID, RUNTIME_B, { rootDirectory: root, now: 2_000 }),
    ).toBeUndefined();
    expect(
      await listRuntimeRecords(OTHER_ROOM_ID, { rootDirectory: root, now: 2_000 }),
    ).toHaveLength(1);
  });

  it('does not delete an unexpired record after timeout, but removes definitive absence', async () => {
    const root = await temporaryRoot();
    await publishRuntimeRecordAtomically(record(RUNTIME_A), { rootDirectory: root });
    const cleanup = {
      rootDirectory: root,
      now: 1_000,
      expectedSessionId: `session-${RUNTIME_A.slice(0, 4)}`,
      expectedEndpoint: `/tmp/pi-to-pi-${RUNTIME_A.slice(0, 4)}`,
      expectedNetworkName: 'planner',
    } as const;

    expect(
      await handleEndpointFailure(ROOM_ID, RUNTIME_A, { ...cleanup, failure: 'timeout' }),
    ).toBe(false);
    expect(await readRuntimeRecord(ROOM_ID, RUNTIME_A, cleanup)).toBeDefined();
    expect(
      await handleEndpointFailure(ROOM_ID, RUNTIME_A, { ...cleanup, failure: 'unavailable' }),
    ).toBe(false);
    expect(await readRuntimeRecord(ROOM_ID, RUNTIME_A, cleanup)).toBeDefined();
    expect(
      await handleEndpointFailure(ROOM_ID, RUNTIME_A, { ...cleanup, failure: 'refused' }),
    ).toBe(true);
    expect(await readRuntimeRecord(ROOM_ID, RUNTIME_A, cleanup)).toBeUndefined();
  });

  it('skips changed ownership content and makes old-runtime cleanup replacement-safe', async () => {
    const root = await temporaryRoot();
    const oldRecord = record(RUNTIME_A);
    await publishRuntimeRecordAtomically(oldRecord, { rootDirectory: root });
    const changed = { ...oldRecord, endpoint: '/tmp/replaced-endpoint' };
    await publishRuntimeRecordAtomically(changed, { rootDirectory: root });
    expect(
      await removeRuntimeRecord(ROOM_ID, RUNTIME_A, {
        rootDirectory: root,
        expectedSessionId: oldRecord.sessionId,
        expectedEndpoint: oldRecord.endpoint,
        expectedNetworkName: oldRecord.networkName,
      }),
    ).toBe(false);
    expect(
      await readRuntimeRecord(ROOM_ID, RUNTIME_A, { rootDirectory: root, now: 1_000 }),
    ).toEqual(changed);
    await publishRuntimeRecordAtomically(record(RUNTIME_B), { rootDirectory: root });
    expect(
      await removeRuntimeRecord(ROOM_ID, RUNTIME_A, {
        rootDirectory: root,
        expectedSessionId: oldRecord.sessionId,
        expectedEndpoint: changed.endpoint,
        expectedNetworkName: oldRecord.networkName,
      }),
    ).toBe(true);
    expect(
      await readRuntimeRecord(ROOM_ID, RUNTIME_B, { rootDirectory: root, now: 1_000 }),
    ).toBeDefined();
  });

  it('keeps a replacement published during cleanup intact', async () => {
    const root = await temporaryRoot();
    const oldRecord = record(RUNTIME_A);
    const replacement = { ...oldRecord, endpoint: '/tmp/replacement-race' };
    await publishRuntimeRecordAtomically(oldRecord, { rootDirectory: root });

    await Promise.all([
      removeRuntimeRecord(ROOM_ID, RUNTIME_A, {
        rootDirectory: root,
        expectedSessionId: oldRecord.sessionId,
        expectedEndpoint: oldRecord.endpoint,
        expectedNetworkName: oldRecord.networkName,
      }),
      publishRuntimeRecordAtomically(replacement, { rootDirectory: root }),
    ]);

    expect(
      await readRuntimeRecord(ROOM_ID, RUNTIME_A, { rootDirectory: root, now: 1_000 }),
    ).toEqual(replacement);
  });
});

describe('serialized lease and lifecycle cleanup', () => {
  it('serializes renewal callbacks and stops idempotently', async () => {
    const renew = vi.fn<() => Promise<void>>(async () => undefined);
    let tick: (() => void) | undefined;
    let cleared = 0;
    const timer = { unref: vi.fn() } as unknown as ReturnType<typeof setInterval>;
    const scheduler = {
      setInterval: vi.fn((handler: () => void) => {
        tick = handler;
        return timer;
      }),
      clearInterval: vi.fn(() => {
        cleared += 1;
      }),
    };
    const lease = new SerializedLease({
      renew,
      scheduler,
      now: () => 0,
      renewalIntervalMs: 10_000,
      ttlMs: 30_000,
    });

    await lease.start();
    expect(renew).toHaveBeenCalledTimes(1);
    tick?.();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(renew).toHaveBeenCalledTimes(2);
    await lease.stop();
    await lease.stop();
    expect(cleared).toBe(1);
    expect(lease.stopped).toBe(true);
  });

  it('reconciles a post-rename publication failure before shutdown cleanup', async () => {
    const root = await temporaryRoot();
    const registry = new RuntimeRegistry({
      runtimeId: RUNTIME_A,
      sessionId: 'session-a',
      roomId: ROOM_ID,
      networkName: 'planner',
      endpoint: '/tmp/endpoint-a',
      rootDirectory: root,
      now: 1_000,
    });
    const originalRename = renameMock.getMockImplementation()!;
    let recordRenameCount = 0;
    renameMock.mockImplementation(async (source, target, flags) => {
      await originalRename(source, target, flags);
      if (String(target).endsWith(`${RUNTIME_A}.json`)) {
        recordRenameCount += 1;
        if (recordRenameCount === 2) {
          throw new Error('post-rename publication fails');
        }
      }
    });

    try {
      await registry.start();
      const committed = registry.current();
      await expect(registry.updateNetworkName('renamed')).rejects.toThrow(
        'post-rename publication fails',
      );
      expect(registry.networkName).toBe('planner');
      expect(registry.current()).toEqual(committed);
      expect(
        await readRuntimeRecord(ROOM_ID, RUNTIME_A, { rootDirectory: root, now: 1_000 }),
      ).toEqual(committed);
      await expect(registry.shutdown()).resolves.toBe(true);
      expect(
        await readRuntimeRecord(ROOM_ID, RUNTIME_A, { rootDirectory: root, now: 1_000 }),
      ).toBeUndefined();
    } finally {
      renameMock.mockImplementation(originalRename);
    }
  });

  it('cleans up a candidate after publication and restoration both fail', async () => {
    const root = await temporaryRoot();
    const registry = new RuntimeRegistry({
      runtimeId: RUNTIME_A,
      sessionId: 'session-a',
      roomId: ROOM_ID,
      networkName: 'planner',
      endpoint: '/tmp/endpoint-a',
      rootDirectory: root,
      now: 1_000,
    });
    const originalRename = renameMock.getMockImplementation()!;
    let recordRenameCount = 0;
    renameMock.mockImplementation(async (source, target, flags) => {
      if (String(target).endsWith(`${RUNTIME_A}.json`)) {
        recordRenameCount += 1;
        if (recordRenameCount === 3) {
          throw new Error('restoration publication fails');
        }
      }
      await originalRename(source, target, flags);
      if (recordRenameCount === 2) {
        throw new Error('post-rename publication fails');
      }
    });

    try {
      await registry.start();
      await expect(registry.updateNetworkName('renamed')).rejects.toThrow(
        'restoration publication fails',
      );
      expect(registry.networkName).toBe('planner');
      expect(registry.current()).toBeUndefined();
      expect(
        await readRuntimeRecord(ROOM_ID, RUNTIME_A, { rootDirectory: root, now: 1_000 }),
      ).toMatchObject({
        networkName: 'renamed',
        sessionId: 'session-a',
        endpoint: '/tmp/endpoint-a',
      });
      await expect(registry.shutdown()).resolves.toBe(true);
      expect(
        await readRuntimeRecord(ROOM_ID, RUNTIME_A, { rootDirectory: root, now: 1_000 }),
      ).toBeUndefined();
      expect(registry.current()).toBeUndefined();
    } finally {
      renameMock.mockImplementation(originalRename);
    }
  });

  it('rolls back a failed rename before exposing a stale record', async () => {
    const root = await temporaryRoot();
    const registry = new RuntimeRegistry({
      runtimeId: RUNTIME_A,
      sessionId: 'session-a',
      roomId: ROOM_ID,
      networkName: 'planner',
      endpoint: '/tmp/endpoint-a',
      rootDirectory: root,
      now: 1_000,
    });
    const originalRename = renameMock.getMockImplementation()!;
    let recordRenameCount = 0;
    renameMock.mockImplementation(async (source, target, flags) => {
      if (String(target).endsWith(`${RUNTIME_A}.json`)) {
        recordRenameCount += 1;
        if (recordRenameCount === 2) {
          throw new Error('rename publication fails');
        }
      }
      return originalRename(source, target, flags);
    });

    try {
      await registry.start();
      const committed = registry.current();
      await expect(registry.updateNetworkName('renamed')).rejects.toThrow(
        'rename publication fails',
      );
      expect(registry.networkName).toBe('planner');
      expect(registry.current()).toEqual(committed);
      expect(
        await readRuntimeRecord(ROOM_ID, RUNTIME_A, { rootDirectory: root, now: 1_000 }),
      ).toEqual(committed);
      await registry.shutdown();
    } finally {
      renameMock.mockImplementation(originalRename);
    }
  });

  it('renames without a committed record by removing a failed post-rename candidate', async () => {
    const root = await temporaryRoot();
    const registry = new RuntimeRegistry({
      runtimeId: RUNTIME_A,
      sessionId: 'session-a',
      roomId: ROOM_ID,
      networkName: 'planner',
      endpoint: '/tmp/endpoint-a',
      rootDirectory: root,
      now: 1_000,
    });
    const originalRename = renameMock.getMockImplementation()!;
    renameMock.mockImplementation(async (source, target, flags) => {
      await originalRename(source, target, flags);
      if (String(target).endsWith(`${RUNTIME_A}.json`)) {
        throw new Error('initial post-rename publication fails');
      }
    });

    try {
      await expect(registry.updateNetworkName('renamed')).rejects.toThrow(
        'initial post-rename publication fails',
      );
      expect(registry.networkName).toBe('planner');
      expect(registry.current()).toBeUndefined();
      expect(
        await readRuntimeRecord(ROOM_ID, RUNTIME_A, { rootDirectory: root, now: 1_000 }),
      ).toBeUndefined();
      await expect(registry.shutdown()).resolves.toBe(false);
    } finally {
      renameMock.mockImplementation(originalRename);
    }
  });

  it('renews and removes only its exact record on idempotent shutdown', async () => {
    const root = await temporaryRoot();
    let now = 1_000;
    let tick: (() => void) | undefined;
    const timer = {} as ReturnType<typeof setInterval>;
    const scheduler = {
      setInterval: (handler: () => void) => {
        tick = handler;
        return timer;
      },
      clearInterval: vi.fn(),
    };
    const registry = new RuntimeRegistry({
      runtimeId: RUNTIME_A,
      sessionId: 'session-a',
      roomId: ROOM_ID,
      networkName: 'planner',
      endpoint: '/tmp/endpoint-a',
      rootDirectory: root,
      clock: () => now,
      scheduler,
    });
    const replacement = new RuntimeRegistry({
      runtimeId: RUNTIME_B,
      sessionId: 'session-b',
      roomId: ROOM_ID,
      networkName: 'planner',
      endpoint: '/tmp/endpoint-b',
      rootDirectory: root,
      clock: () => now,
      scheduler: {
        setInterval: (handler: () => void) => {
          return { handler } as unknown as ReturnType<typeof setInterval>;
        },
        clearInterval: vi.fn(),
      },
    });

    await registry.start();
    await replacement.start();
    expect(registry.current()?.leaseExpiresAt).toBe(31_000);
    now = 11_000;
    tick?.();
    await vi.waitFor(() => expect(registry.current()?.leaseExpiresAt).toBe(41_000));

    expect(await registry.shutdown()).toBe(true);
    expect(await registry.shutdown()).toBe(true);
    expect(
      await readRuntimeRecord(ROOM_ID, RUNTIME_A, { rootDirectory: root, now }),
    ).toBeUndefined();
    expect(await readRuntimeRecord(ROOM_ID, RUNTIME_B, { rootDirectory: root, now })).toBeDefined();
    await replacement.shutdown();
  });
  it('serializes renewal ahead of a failed staged name publication', async () => {
    const root = await temporaryRoot();
    const registry = new OrderedPublicationRegistry({
      runtimeId: RUNTIME_A,
      sessionId: 'session-a',
      roomId: ROOM_ID,
      networkName: 'planner',
      endpoint: '/tmp/endpoint-a',
      rootDirectory: root,
      now: 1_000,
    });

    await registry.start();
    const renewal = registry.renew();
    await registry.renewalStarted;
    const rename = registry.updateNetworkName('renamed');
    registry.releaseBlockedRenewalNow();

    await expect(renewal).resolves.toBeUndefined();
    await expect(rename).rejects.toThrow('rename publication fails');
    expect(registry.observedNames).toEqual(['planner', 'planner', 'renamed']);
    expect(registry.networkName).toBe('planner');
    expect(registry.current()?.networkName).toBe('planner');
    expect(
      await readRuntimeRecord(ROOM_ID, RUNTIME_A, { rootDirectory: root, now: 1_000 }),
    ).toEqual(registry.current());

    await registry.shutdown();
  });

  it('reconciles a failed rename before a queued renewal can observe it', async () => {
    const root = await temporaryRoot();
    const registry = new FailedPublicationThenRenewalRegistry({
      runtimeId: RUNTIME_A,
      sessionId: 'session-a',
      roomId: ROOM_ID,
      networkName: 'planner',
      endpoint: '/tmp/endpoint-a',
      rootDirectory: root,
      now: 1_000,
    });

    await registry.start();
    const rename = registry.updateNetworkName('renamed');
    await registry.renameCommitted;
    const renewal = registry.renew();
    registry.releaseRenameFailureNow();
    await registry.renewalStarted;

    try {
      expect(registry.networkName).toBe('planner');
      expect(registry.current()?.networkName).toBe('planner');
      expect(
        await readRuntimeRecord(ROOM_ID, RUNTIME_A, { rootDirectory: root, now: 1_000 }),
      ).toEqual(registry.current());
    } finally {
      registry.releaseRenewalNow();
    }

    await expect(rename).rejects.toThrow('rename publication fails after commit');
    await expect(renewal).resolves.toBeUndefined();
    expect(registry.observedNames).toEqual(['planner', 'renamed', 'planner']);
    expect(registry.networkName).toBe('planner');
    expect(registry.current()?.networkName).toBe('planner');
    expect(
      await readRuntimeRecord(ROOM_ID, RUNTIME_A, { rootDirectory: root, now: 1_000 }),
    ).toEqual(registry.current());

    await registry.shutdown();
  });

  it('removes the last committed record when shutdown rejects a queued name publication', async () => {
    const root = await temporaryRoot();
    const registry = new RuntimeRegistry({
      runtimeId: RUNTIME_A,
      sessionId: 'session-a',
      roomId: ROOM_ID,
      networkName: 'planner',
      endpoint: '/tmp/endpoint-a',
      rootDirectory: root,
      now: 1_000,
    });

    await registry.start();
    expect(registry.current()?.networkName).toBe('planner');
    const rename = registry.updateNetworkName('renamed');
    const shutdown = registry.shutdown();

    await expect(rename).rejects.toThrow('stopped');
    expect(registry.networkName).toBe('planner');
    expect(await shutdown).toBe(true);
    expect(
      await readRuntimeRecord(ROOM_ID, RUNTIME_A, { rootDirectory: root, now: 1_000 }),
    ).toBeUndefined();
    expect(registry.current()).toBeUndefined();
  });
  it('rejects a late direct renewal and leaves exact shutdown cleanup final', async () => {
    const root = await temporaryRoot();
    const registry = new RuntimeRegistry({
      runtimeId: RUNTIME_A,
      sessionId: 'session-a',
      roomId: ROOM_ID,
      networkName: 'planner',
      endpoint: '/tmp/endpoint-a',
      rootDirectory: root,
      now: 1_000,
    });

    const renewal = registry.renew();
    const shutdown = registry.shutdown();

    await expect(renewal).rejects.toThrow('stopped');
    expect(await shutdown).toBe(false);
    expect(
      await readRuntimeRecord(ROOM_ID, RUNTIME_A, { rootDirectory: root, now: 1_000 }),
    ).toBeUndefined();
  });
});
