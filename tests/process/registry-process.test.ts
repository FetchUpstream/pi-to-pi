import { access, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { getRegistryPaths, getRuntimeRecordPath } from '../../src/discovery/registry.js';

const CHILD_TIMEOUT_MS = 8_000;
const ROOM_A = `r1-${'a'.repeat(32)}`;
const ROOM_B = `r1-${'b'.repeat(32)}`;
const WORKER_PATH = fileURLToPath(new URL('./registry-worker.ts', import.meta.url));
const LOADER_PATH = fileURLToPath(new URL('./ts-source-loader.mjs', import.meta.url));
const REPOSITORY_ROOT = fileURLToPath(new URL('../../', import.meta.url));

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

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'pi-to-pi-process-'));
  temporaryRoots.push(root);
  return root;
}

function runWorker(mode: string, payload: WorkerInput): Promise<WorkerResponse> {
  const child = spawn(
    process.execPath,
    ['--no-warnings', '--experimental-strip-types', '--loader', LOADER_PATH, WORKER_PATH, mode],
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

async function discover(
  root: string,
  room: string,
  overrides: Readonly<Record<string, unknown>> = {},
): Promise<DiscoveryResponse> {
  return (await runWorker('discover', { root, room, ...overrides })) as DiscoveryResponse;
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
    expect(result.records.map((record) => record.runtimeId).sort()).toEqual(
      records.map((record) => record.runtimeId).sort(),
    );
    expect(result.records.every((record) => record.endpoint.startsWith('process-endpoint-'))).toBe(
      true,
    );
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

    const [replacement, cleanup] = await Promise.all([
      startRuntime(root, ROOM_A, 41, { now: 20_000, holdMs: 75 }),
      runWorker('cleanup', {
        root,
        room: ROOM_A,
        runtimeId: old.runtimeId,
        expectedSessionId: old.sessionId,
        expectedEndpoint: old.endpoint,
        expectedNetworkName: old.networkName,
        delayMs: 20,
      }),
    ]);

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
