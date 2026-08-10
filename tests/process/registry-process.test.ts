import { access, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { getRegistryPaths, getRuntimeRecordPath } from '../../src/discovery/registry.js';

const CHILD_TIMEOUT_MS = 8_000;
const PUBLICATION_READY_TIMEOUT_MS = 2_000;
const PUBLICATION_POLL_INTERVAL_MS = 25;
const ROOM_A = `r1-${'a'.repeat(32)}`;
const ROOM_B = `r1-${'b'.repeat(32)}`;
const STORAGE_KEY_A = 'room-a';
const STORAGE_KEY_B = 'room-b';
const CARD_BASE_NOW = Date.parse('2026-01-01T00:00:00.000Z');
const WORKER_PATH = fileURLToPath(new URL('./registry-worker.ts', import.meta.url));
const LOADER_PATH =
  process.platform === 'win32'
    ? new URL('./ts-source-loader.mjs', import.meta.url).href
    : fileURLToPath(new URL('./ts-source-loader.mjs', import.meta.url));
const REPOSITORY_ROOT = fileURLToPath(new URL('../../', import.meta.url));

function nodeModuleSpecifier(path: string): string {
  return process.platform === 'win32' ? pathToFileURL(path).href : path;
}
interface WorkerInput {
  readonly root: string;
  readonly room: string;
  readonly [key: string]: unknown;
}

interface WorkerResponse {
  readonly mode: string;
  readonly [key: string]: unknown;
}

interface PublishedRecord {
  readonly runtimeId: string;
  readonly sessionId: string;
  readonly roomId: string;
  readonly networkName: string;
  readonly endpoint: string;
  readonly leaseExpiresAt: number;
}

interface StartResponse extends WorkerResponse {
  readonly record: PublishedRecord;
}

interface PublishedAgentCard {
  readonly runtimeInstanceId: string;
  readonly sessionId: string;
  readonly roomId: string;
  readonly displayName: string;
  readonly runtimeStartedAt: string;
  readonly leaseExpiresAt: string;
  readonly endpoint: {
    readonly kind: string;
    readonly address: string;
    readonly runtimeInstanceId: string;
  };
}

interface AgentCardStartResponse extends WorkerResponse {
  readonly card: PublishedAgentCard;
}

interface AgentCardPeer {
  readonly runtimeId: string;
  readonly runtimeInstanceId: string;
  readonly roomId: string;
  readonly networkName: string;
  readonly displayName: string;
}

interface AgentCardDiscoveryResponse extends WorkerResponse {
  readonly peers: readonly AgentCardPeer[];
  readonly lookup?: LookupResponse;
}

interface AgentCardCleanupResponse extends WorkerResponse {
  readonly result: {
    readonly cardsRemoved: number;
    readonly temporaryFilesRemoved: number;
    readonly totalRemoved: number;
  };
}

interface CleanupResponse extends WorkerResponse {
  readonly removed: boolean;
}

interface LookupAddress {
  readonly runtimeId: string;
  readonly roomId: string;
}

interface LookupResponse {
  readonly kind: string;
  readonly address?: LookupAddress;
  readonly addresses?: readonly LookupAddress[];
  readonly candidates?: readonly LookupAddress[];
}

interface DiscoveryResponse extends WorkerResponse {
  readonly records: readonly PublishedRecord[];
  readonly lookup?: LookupResponse;
}

const temporaryRoots: string[] = [];

function runtimeId(index: number): string {
  const value = index.toString(16);
  return `${value.padStart(8, '0')}-0000-4000-8000-${value.padStart(12, '0')}`;
}

function inputFor(
  root: string,
  room: string,
  index: number,
  overrides: Readonly<Record<string, unknown>> = {},
): WorkerInput {
  return {
    root,
    room,
    runtimeId: runtimeId(index),
    sessionId: `process-session-${index}`,
    networkName: 'planner',
    endpoint: `process-endpoint-${index}`,
    ...overrides,
  };
}

function agentCardInputFor(
  root: string,
  room: string,
  index: number,
  overrides: Readonly<Record<string, unknown>> = {},
): WorkerInput {
  return {
    ...inputFor(root, room, index),
    storageKey: room === ROOM_A ? STORAGE_KEY_A : STORAGE_KEY_B,
    ...overrides,
  };
}

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'pi-to-pi-process-'));
  temporaryRoots.push(root);
  return root;
}

function runWorker(mode: string, payload: WorkerInput): Promise<WorkerResponse> {
  const child = spawn(
    process.execPath,
    [
      '--no-warnings',
      '--experimental-strip-types',
      '--loader',
      nodeModuleSpecifier(LOADER_PATH),
      nodeModuleSpecifier(WORKER_PATH),
      mode,
    ],
    {
      cwd: REPOSITORY_ROOT,
      env: {
        ...process.env,
        PI_TO_PI_PROCESS_PAYLOAD: JSON.stringify(payload),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );

  return new Promise<WorkerResponse>((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      if (!settled) {
        settled = true;
        reject(new Error(`child process timed out after ${CHILD_TIMEOUT_MS}ms (${mode})`));
      }
    }, CHILD_TIMEOUT_MS);

    child.stdout?.on('data', (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });
    child.stderr?.on('data', (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });
    child.once('error', (error: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code, signal) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        reject(
          new Error(
            `child process failed (${mode}): code=${String(code)} signal=${String(signal)}\n${stderr}`,
          ),
        );
        return;
      }

      const lines = stdout.trim().split(/\r?\n/u).filter(Boolean);
      const line = lines.at(-1);
      if (line === undefined) {
        reject(new Error(`child process produced no JSON output (${mode})\n${stderr}`));
        return;
      }
      try {
        const parsed: unknown = JSON.parse(line);
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
          throw new Error('worker output is not a JSON object');
        }
        resolve(parsed as WorkerResponse);
      } catch (error: unknown) {
        reject(
          new Error(
            `child process produced invalid JSON (${mode}): ${
              error instanceof Error ? error.message : String(error)
            }\nstdout=${stdout}\nstderr=${stderr}`,
          ),
        );
      }
    });
  });
}

async function startRuntime(
  root: string,
  room: string,
  index: number,
  overrides: Readonly<Record<string, unknown>> = {},
): Promise<PublishedRecord> {
  const result = (await runWorker(
    'start',
    inputFor(root, room, index, overrides),
  )) as StartResponse;
  return result.record;
}

async function startAgentCard(
  root: string,
  room: string,
  index: number,
  overrides: Readonly<Record<string, unknown>> = {},
): Promise<PublishedAgentCard> {
  const result = (await runWorker(
    'agent-card-start',
    agentCardInputFor(root, room, index, overrides),
  )) as AgentCardStartResponse;
  return result.card;
}

async function discoverAgentCards(
  root: string,
  room: string,
  overrides: Readonly<Record<string, unknown>> = {},
): Promise<AgentCardDiscoveryResponse> {
  return (await runWorker(
    'agent-card-discover',
    agentCardInputFor(root, room, 0, overrides),
  )) as AgentCardDiscoveryResponse;
}

async function cleanupAgentCards(
  root: string,
  room: string,
  overrides: Readonly<Record<string, unknown>> = {},
): Promise<AgentCardCleanupResponse> {
  return (await runWorker('agent-card-cleanup', {
    root,
    room,
    storageKey: room === ROOM_A ? STORAGE_KEY_A : STORAGE_KEY_B,
    ...overrides,
  })) as AgentCardCleanupResponse;
}

async function discover(
  root: string,
  room: string,
  overrides: Readonly<Record<string, unknown>> = {},
): Promise<DiscoveryResponse> {
  return (await runWorker('discover', { root, room, ...overrides })) as DiscoveryResponse;
}
async function waitForPublishedRecords(
  root: string,
  room: string,
  runtimeIds: readonly string[],
  overrides: Readonly<Record<string, unknown>> = {},
): Promise<readonly PublishedRecord[]> {
  const deadline = Date.now() + PUBLICATION_READY_TIMEOUT_MS;
  let latestRecords: readonly PublishedRecord[] = [];

  while (true) {
    latestRecords = (await discover(root, room, overrides)).records;
    const discoveredRuntimeIds = new Set(latestRecords.map((record) => record.runtimeId));
    if (runtimeIds.every((runtimeId) => discoveredRuntimeIds.has(runtimeId))) {
      return latestRecords;
    }

    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      break;
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, Math.min(PUBLICATION_POLL_INTERVAL_MS, remainingMs));
    });
  }

  throw new Error(
    `timed out waiting for runtime publication: expected=${runtimeIds.join(',')} discovered=${latestRecords
      .map((record) => record.runtimeId)
      .join(',')}`,
  );
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe('multi-process registry publication and discovery', () => {
  it('discovers same-room runtimes and returns every full address for duplicate names', async () => {
    const root = await temporaryRoot();
    const [first, second] = await Promise.all([
      startRuntime(root, ROOM_A, 1),
      startRuntime(root, ROOM_A, 2),
    ]);

    const result = await discover(root, ROOM_A, { query: 'planner' });
    expect(result.records.map((record) => record.runtimeId).sort()).toEqual(
      [first.runtimeId, second.runtimeId].sort(),
    );
    expect(result.records.every((record) => record.roomId === ROOM_A)).toBe(true);
    expect(result.lookup?.kind).toBe('ambiguous');
    expect(result.lookup?.addresses?.map((address) => address.runtimeId).sort()).toEqual(
      [first.runtimeId, second.runtimeId].sort(),
    );
  }, 30_000);

  it('isolates different rooms during listing and rejects a cross-room runtime target', async () => {
    const root = await temporaryRoot();
    const [sameRoom, otherRoom] = await Promise.all([
      startRuntime(root, ROOM_A, 3),
      startRuntime(root, ROOM_B, 4),
    ]);

    const roomA = await discover(root, ROOM_A, { query: 'planner' });
    expect(roomA.records.map((record) => record.runtimeId)).toEqual([sameRoom.runtimeId]);
    expect(roomA.lookup?.kind).toBe('found');
    expect(roomA.lookup?.address?.roomId).toBe(ROOM_A);

    const roomB = await discover(root, ROOM_B, { query: 'planner' });
    expect(roomB.records.map((record) => record.runtimeId)).toEqual([otherRoom.runtimeId]);

    const crossRoom = await runWorker('lookup-runtime', {
      root,
      room: ROOM_A,
      targetRuntimeId: otherRoom.runtimeId,
      rooms: [ROOM_A, ROOM_B],
    });
    const result = crossRoom.result as LookupResponse;
    expect(result.kind).toBe('cross-room');
    expect(result.addresses?.map((address) => address.runtimeId)).toEqual([otherRoom.runtimeId]);
  }, 30_000);

  it('keeps complete records from many concurrent child-process starts', async () => {
    const root = await temporaryRoot();
    const indexes = Array.from({ length: 8 }, (_, offset) => offset + 10);
    const records = await Promise.all(indexes.map((index) => startRuntime(root, ROOM_A, index)));

    const result = await discover(root, ROOM_A, { query: 'planner' });
    const sortedRecords = [...records].sort((left, right) =>
      left.runtimeId.localeCompare(right.runtimeId),
    );
    const sortedDiscoveredRecords = [...result.records].sort((left, right) =>
      left.runtimeId.localeCompare(right.runtimeId),
    );
    expect(sortedDiscoveredRecords).toEqual(sortedRecords);
    expect(result.lookup?.kind).toBe('ambiguous');
    expect(result.lookup?.addresses).toHaveLength(indexes.length);

    const paths = getRegistryPaths(ROOM_A, { rootDirectory: root });
    const files = await readdir(paths.recordsDirectory);
    expect(files.filter((file) => file.endsWith('.json'))).toHaveLength(indexes.length);
    expect(files.some((file) => file.includes('.tmp-') || file.endsWith('.lock'))).toBe(false);
  }, 30_000);

  it('excludes an expired child-process lease and garbage-collects the exact record', async () => {
    const root = await temporaryRoot();
    const stale = await startRuntime(root, ROOM_A, 30, { now: 10_000, ttlMs: 50 });
    expect(stale.leaseExpiresAt).toBe(10_050);

    const result = await discover(root, ROOM_A, { now: 10_050, removeExpired: true });
    expect(result.records).toEqual([]);
    expect(
      await pathExists(getRuntimeRecordPath(ROOM_A, stale.runtimeId, { rootDirectory: root })),
    ).toBe(false);
  }, 30_000);

  it('keeps replacement ownership intact while an old child cleans up concurrently', async () => {
    const root = await temporaryRoot();
    const old = await startRuntime(root, ROOM_A, 40, { now: 20_000 });

    const replacementRuntimeId = runtimeId(41);
    const replacementStart = startRuntime(root, ROOM_A, 41, { now: 20_000, holdMs: 75 });
    const publishedRecords = await waitForPublishedRecords(
      root,
      ROOM_A,
      [old.runtimeId, replacementRuntimeId],
      { now: 20_000 },
    );
    expect(publishedRecords.map((record) => record.runtimeId).sort()).toEqual(
      [old.runtimeId, replacementRuntimeId].sort(),
    );

    const cleanupPromise = runWorker('cleanup', {
      root,
      room: ROOM_A,
      runtimeId: old.runtimeId,
      expectedSessionId: old.sessionId,
      expectedEndpoint: old.endpoint,
      expectedNetworkName: old.networkName,
      delayMs: 20,
    });
    const [replacement, cleanup] = await Promise.all([replacementStart, cleanupPromise]);

    expect((cleanup as CleanupResponse).removed).toBe(true);
    const result = await discover(root, ROOM_A, { now: 20_000 });
    expect(result.records.map((record) => record.runtimeId)).toEqual([replacement.runtimeId]);
    expect(
      await pathExists(getRuntimeRecordPath(ROOM_A, old.runtimeId, { rootDirectory: root })),
    ).toBe(false);
  }, 30_000);

  it('ignores malformed and incorrectly named entries written by another process', async () => {
    const root = await temporaryRoot();
    const valid = await startRuntime(root, ROOM_A, 50, { now: 30_000 });
    const malformedFile = `${runtimeId(51)}.json`;
    const malformedPath = getRegistryPaths(ROOM_A, { rootDirectory: root }).recordsDirectory;

    await runWorker('corrupt', {
      root,
      room: ROOM_A,
      fileName: malformedFile,
      content: '{not-json',
    });
    await runWorker('corrupt', {
      root,
      room: ROOM_A,
      fileName: 'not-a-runtime.json',
      content: '{}',
    });

    const result = await discover(root, ROOM_A, { removeExpired: true, now: 30_000 });
    expect(result.records.map((record) => record.runtimeId)).toEqual([valid.runtimeId]);
    expect(await readFile(join(malformedPath, malformedFile), 'utf8')).toBe('{not-json');
  }, 30_000);
});

describe('multi-process Agent Card registry publication and cleanup', () => {
  it('publishes concurrent cards atomically and maps duplicate names to distinct peers', async () => {
    const root = await temporaryRoot();
    const indexes = Array.from({ length: 6 }, (_, offset) => offset + 60);
    const cards = await Promise.all(indexes.map((index) => startAgentCard(root, ROOM_A, index)));
    const discovery = await discoverAgentCards(root, ROOM_A, { query: 'planner' });

    expect(discovery.peers.map((peer) => peer.runtimeId).sort()).toEqual(
      cards.map((card) => card.runtimeInstanceId).sort(),
    );
    expect(new Set(discovery.peers.map((peer) => peer.networkName)).size).toBe(indexes.length);
    expect(discovery.lookup?.kind).toBe('ambiguous');
    expect(discovery.lookup?.addresses).toHaveLength(indexes.length);
    expect(
      discovery.peers.every(
        (peer) => peer.runtimeId === peer.runtimeInstanceId && peer.roomId === ROOM_A,
      ),
    ).toBe(true);

    const files = await readdir(join(root, 'rooms', STORAGE_KEY_A, 'agents'));
    expect(files.filter((file) => file.endsWith('.json'))).toHaveLength(indexes.length);
    expect(files.some((file) => file.includes('.tmp-') || file.endsWith('.lock'))).toBe(false);
    for (const card of cards) {
      const source = await readFile(
        join(root, 'rooms', STORAGE_KEY_A, 'agents', `${card.runtimeInstanceId}.json`),
        'utf8',
      );
      const persisted = JSON.parse(source) as PublishedAgentCard;
      expect(persisted.runtimeInstanceId).toBe(card.runtimeInstanceId);
      expect(persisted.endpoint.runtimeInstanceId).toBe(card.runtimeInstanceId);
      expect(typeof persisted.leaseExpiresAt).toBe('string');
    }
  }, 30_000);

  it('isolates room listings and prevents an old owner from removing a replacement card', async () => {
    const root = await temporaryRoot();
    const [oldCard, replacementCard, otherRoomCard] = await Promise.all([
      startAgentCard(root, ROOM_A, 70),
      startAgentCard(root, ROOM_A, 71),
      startAgentCard(root, ROOM_B, 72),
    ]);

    const removal = (await runWorker(
      'agent-card-remove',
      agentCardInputFor(root, ROOM_A, 70, {
        expectedSessionId: `process-session-70`,
        expectedEndpoint: 'process-endpoint-70',
      }),
    )) as CleanupResponse;
    expect(removal.removed).toBe(true);

    const roomA = await discoverAgentCards(root, ROOM_A, { query: 'planner' });
    const roomB = await discoverAgentCards(root, ROOM_B, { query: 'planner' });
    expect(roomA.peers.map((peer) => peer.runtimeId)).toEqual([replacementCard.runtimeInstanceId]);
    expect(roomB.peers.map((peer) => peer.runtimeId)).toEqual([otherRoomCard.runtimeInstanceId]);
    expect(roomA.lookup?.kind).toBe('found');
    expect(roomB.lookup?.kind).toBe('found');
    expect(
      await pathExists(
        join(root, 'rooms', STORAGE_KEY_A, 'agents', `${oldCard.runtimeInstanceId}.json`),
      ),
    ).toBe(false);
    expect(
      await pathExists(
        join(root, 'rooms', STORAGE_KEY_A, 'agents', `${replacementCard.runtimeInstanceId}.json`),
      ),
    ).toBe(true);
  }, 30_000);

  it('bounds stale-card and temporary-file cleanup across processes', async () => {
    const root = await temporaryRoot();
    const now = CARD_BASE_NOW + 151;
    const stale = await startAgentCard(root, ROOM_A, 80, { now: CARD_BASE_NOW, ttlMs: 50 });
    const oldTemporaryName = `.${stale.runtimeInstanceId}.json.tmp-123-abcd-deadbeef`;
    const freshTemporaryName = `.${runtimeId(81)}.json.tmp-123-abcd-deadbeef`;
    await runWorker(
      'agent-card-temp',
      agentCardInputFor(root, ROOM_A, 80, {
        fileName: oldTemporaryName,
        mtimeMs: CARD_BASE_NOW - 100,
        now,
        ttlMs: 50,
      }),
    );
    await runWorker(
      'agent-card-temp',
      agentCardInputFor(root, ROOM_A, 81, {
        fileName: freshTemporaryName,
        mtimeMs: CARD_BASE_NOW + 150,
        now,
        ttlMs: 50,
      }),
    );

    const cleanup = await cleanupAgentCards(root, ROOM_A, {
      now,
      ttlMs: 50,
      maxEntries: 4,
      maxDurationMs: 2_000,
    });
    expect(cleanup.result).toEqual({ cardsRemoved: 1, temporaryFilesRemoved: 1, totalRemoved: 2 });
    expect(await pathExists(join(root, 'rooms', STORAGE_KEY_A, 'agents', oldTemporaryName))).toBe(
      false,
    );
    expect(await pathExists(join(root, 'rooms', STORAGE_KEY_A, 'agents', freshTemporaryName))).toBe(
      true,
    );
    expect((await discoverAgentCards(root, ROOM_A, { now })).peers).toEqual([]);
  }, 30_000);
});
