import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  RuntimeRegistry,
  ensureRegistryPaths,
  getRegistryPaths,
  listRuntimeRecords,
  removeRuntimeRecord,
} from '../../src/discovery/registry.js';
import { lookupPeerByName, lookupPeerByRuntimeId } from '../../src/discovery/lookup.js';

interface WorkerPayload {
  readonly root: string;
  readonly room: string;
  readonly runtimeId?: string;
  readonly sessionId?: string;
  readonly networkName?: string;
  readonly endpoint?: string;
  readonly now?: number;
  readonly ttlMs?: number;
  readonly renewalIntervalMs?: number;
  readonly holdMs?: number;
  readonly shutdown?: boolean;
  readonly delayMs?: number;
  readonly expectedSessionId?: string;
  readonly expectedEndpoint?: string;
  readonly expectedNetworkName?: string;
  readonly removeExpired?: boolean;
  readonly query?: string;
  readonly targetRuntimeId?: string;
  readonly rooms?: readonly string[];
  readonly fileName?: string;
  readonly content?: string;
}

function readPayload(): WorkerPayload {
  const serialized = process.env.PI_TO_PI_PROCESS_PAYLOAD;
  if (serialized === undefined) {
    throw new Error('PI_TO_PI_PROCESS_PAYLOAD is required');
  }
  return JSON.parse(serialized) as WorkerPayload;
}

function required(
  payload: WorkerPayload,
  field: 'root' | 'room' | 'runtimeId' | 'targetRuntimeId',
): string {
  const value = payload[field];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${field} is required`);
  }
  return value;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function startRuntime(payload: WorkerPayload): Promise<void> {
  const runtimeId = required(payload, 'runtimeId');
  const sessionId = payload.sessionId ?? `process-session-${runtimeId.slice(0, 8)}`;
  const networkName = payload.networkName ?? 'planner';
  const endpoint = payload.endpoint ?? `process-endpoint-${runtimeId.slice(0, 8)}`;
  const registry = new RuntimeRegistry({
    runtimeId,
    sessionId,
    roomId: payload.room,
    networkName,
    endpoint,
    rootDirectory: payload.root,
    now: payload.now,
    ttlMs: payload.ttlMs,
    renewalIntervalMs: payload.renewalIntervalMs,
  });

  await registry.start();
  const record = registry.current();
  if (record === undefined) {
    throw new Error('runtime did not publish a record');
  }

  if (payload.holdMs !== undefined) {
    await delay(payload.holdMs);
  }

  let removed: boolean | undefined;
  if (payload.shutdown === true) {
    removed = await registry.shutdown();
  }

  console.log(JSON.stringify({ mode: 'start', record, removed }));
}

async function discover(payload: WorkerPayload): Promise<void> {
  const records = await listRuntimeRecords(payload.room, {
    rootDirectory: payload.root,
    now: payload.now,
    removeExpired: payload.removeExpired,
  });
  const lookup =
    payload.query === undefined
      ? undefined
      : lookupPeerByName(payload.query, payload.room, records);

  console.log(JSON.stringify({ mode: 'discover', records, lookup }));
}

async function lookupRuntime(payload: WorkerPayload): Promise<void> {
  const rooms = payload.rooms ?? [payload.room];
  const records = (
    await Promise.all(
      rooms.map((room) =>
        listRuntimeRecords(room, {
          rootDirectory: payload.root,
          now: payload.now,
        }),
      ),
    )
  ).flat();
  const targetRuntimeId = required(payload, 'targetRuntimeId');
  const result = lookupPeerByRuntimeId(targetRuntimeId, payload.room, records);

  console.log(JSON.stringify({ mode: 'lookup-runtime', records, result }));
}

async function cleanup(payload: WorkerPayload): Promise<void> {
  const runtimeId = required(payload, 'runtimeId');
  if (payload.delayMs !== undefined) {
    await delay(payload.delayMs);
  }
  const removed = await removeRuntimeRecord(payload.room, runtimeId, {
    rootDirectory: payload.root,
    expectedSessionId: payload.expectedSessionId,
    expectedEndpoint: payload.expectedEndpoint,
    expectedNetworkName: payload.expectedNetworkName,
  });

  console.log(JSON.stringify({ mode: 'cleanup', runtimeId, removed }));
}

async function corrupt(payload: WorkerPayload): Promise<void> {
  const fileName = payload.fileName;
  if (fileName === undefined || !/^[a-z0-9._-]+\.json$/u.test(fileName)) {
    throw new Error('fileName must be a safe JSON record filename');
  }
  await ensureRegistryPaths(payload.room, { rootDirectory: payload.root });
  const paths = getRegistryPaths(payload.room, { rootDirectory: payload.root });
  await mkdir(paths.recordsDirectory, { recursive: true, mode: 0o700 });
  const path = join(paths.recordsDirectory, fileName);
  await writeFile(path, payload.content ?? '{malformed', { encoding: 'utf8', mode: 0o600 });
  await chmod(path, 0o600);

  console.log(JSON.stringify({ mode: 'corrupt', path }));
}

async function main(): Promise<void> {
  const mode = process.argv[2];
  const payload = readPayload();
  switch (mode) {
    case 'start':
      await startRuntime(payload);
      return;
    case 'discover':
      await discover(payload);
      return;
    case 'lookup-runtime':
      await lookupRuntime(payload);
      return;
    case 'cleanup':
      await cleanup(payload);
      return;
    case 'corrupt':
      await corrupt(payload);
      return;
    default:
      throw new Error(`unknown worker mode: ${mode ?? '<missing>'}`);
  }
}

try {
  await main();
} catch (error: unknown) {
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exitCode = 1;
}
