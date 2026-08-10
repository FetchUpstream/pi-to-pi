import { chmod, mkdir, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  RuntimeRegistry,
  ensureRegistryPaths,
  getRegistryPaths,
  listRuntimeRecords,
  removeRuntimeRecord,
} from '../../src/discovery/registry.js';
import {
  AgentCardRegistry,
  cleanupAgentCardState,
  listLiveAgentCardPeers,
  removeAgentCard,
} from '../../src/discovery/agent-card-registry.js';
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
  readonly storageKey?: string;
  readonly endpointKind?: 'unix' | 'named-pipe';
  readonly maxEntries?: number;
  readonly maxDurationMs?: number;
  readonly mtimeMs?: number;
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

function createAgentCardWorkerRegistry(payload: WorkerPayload): AgentCardRegistry {
  const runtimeId = required(payload, 'runtimeId');
  const sessionId = payload.sessionId ?? `process-session-${runtimeId.slice(0, 8)}`;
  const endpoint = payload.endpoint ?? `process-endpoint-${runtimeId.slice(0, 8)}`;
  return new AgentCardRegistry({
    runtimeId,
    sessionId,
    room: { roomId: payload.room, storageKey: payload.storageKey ?? 'room-key-1' },
    displayName: payload.networkName ?? 'planner',
    endpoint: { kind: payload.endpointKind ?? 'unix', address: endpoint },
    rootDirectory: payload.root,
    ...(payload.now === undefined ? {} : { clock: () => payload.now as number }),
    ttlMs: payload.ttlMs,
    renewalIntervalMs: payload.renewalIntervalMs,
  });
}

async function startAgentCardRuntime(payload: WorkerPayload): Promise<void> {
  const registry = createAgentCardWorkerRegistry(payload);
  await registry.start();
  const card = registry.current();
  if (card === undefined) {
    throw new Error('runtime did not publish an Agent Card');
  }

  if (payload.holdMs !== undefined) {
    await delay(payload.holdMs);
  }
  const removed = payload.shutdown === true ? await registry.shutdown() : undefined;
  console.log(JSON.stringify({ mode: 'agent-card-start', card, removed }));
}

async function discoverAgentCards(payload: WorkerPayload): Promise<void> {
  const room = { roomId: payload.room, storageKey: payload.storageKey ?? 'room-key-1' };
  const peers = await listLiveAgentCardPeers(room, {
    rootDirectory: payload.root,
    now: payload.now,
    maxEntries: payload.maxEntries,
    maxDurationMs: payload.maxDurationMs,
  });
  const lookup =
    payload.query === undefined ? undefined : lookupPeerByName(payload.query, room, peers);
  console.log(JSON.stringify({ mode: 'agent-card-discover', peers, lookup }));
}

async function cleanupAgentCards(payload: WorkerPayload): Promise<void> {
  const room = { roomId: payload.room, storageKey: payload.storageKey ?? 'room-key-1' };
  const result = await cleanupAgentCardState(room, {
    rootDirectory: payload.root,
    now: payload.now,
    ttlMs: payload.ttlMs,
    maxEntries: payload.maxEntries,
    maxDurationMs: payload.maxDurationMs,
    ...(payload.runtimeId === undefined ? {} : { runtimeInstanceId: payload.runtimeId }),
  });
  console.log(JSON.stringify({ mode: 'agent-card-cleanup', result }));
}

async function removeAgentCardOwner(payload: WorkerPayload): Promise<void> {
  const runtimeId = required(payload, 'runtimeId');
  const room = { roomId: payload.room, storageKey: payload.storageKey ?? 'room-key-1' };
  const removed = await removeAgentCard(room, runtimeId, {
    rootDirectory: payload.root,
    expectedSessionId: payload.expectedSessionId,
    expectedEndpoint: payload.expectedEndpoint,
  });
  console.log(JSON.stringify({ mode: 'agent-card-remove', runtimeId, removed }));
}

async function writeAgentCardEntry(payload: WorkerPayload, temporary: boolean): Promise<void> {
  required(payload, 'runtimeId');
  const fileName = payload.fileName;
  const pattern = temporary
    ? /^\.[0-9a-f-]+\.json\.tmp-[0-9]+-[a-z0-9]+-[0-9a-f]+$/u
    : /^[a-z0-9._-]+\.json$/u;
  if (fileName === undefined || !pattern.test(fileName)) {
    throw new Error('fileName is not safe for an Agent Card entry');
  }
  const registry = createAgentCardWorkerRegistry(payload);
  const paths = await registry.getPaths();
  const path = join(paths.agentsDirectory, fileName);
  await writeFile(path, payload.content ?? (temporary ? 'temporary' : '{malformed'), {
    encoding: 'utf8',
    mode: 0o600,
  });
  await chmod(path, 0o600);
  if (payload.mtimeMs !== undefined) {
    await utimes(path, new Date(payload.mtimeMs), new Date(payload.mtimeMs));
  }
  console.log(JSON.stringify({ mode: temporary ? 'agent-card-temp' : 'agent-card-corrupt', path }));
}

async function writeAgentCardCorruption(payload: WorkerPayload): Promise<void> {
  await writeAgentCardEntry(payload, false);
}

async function writeAgentCardTemporary(payload: WorkerPayload): Promise<void> {
  await writeAgentCardEntry(payload, true);
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
    case 'agent-card-start':
      await startAgentCardRuntime(payload);
      return;
    case 'discover':
      await discover(payload);
      return;
    case 'agent-card-discover':
      await discoverAgentCards(payload);
      return;
    case 'lookup-runtime':
      await lookupRuntime(payload);
      return;
    case 'cleanup':
      await cleanup(payload);
      return;
    case 'agent-card-cleanup':
      await cleanupAgentCards(payload);
      return;
    case 'agent-card-remove':
      await removeAgentCardOwner(payload);
      return;
    case 'corrupt':
      await corrupt(payload);
      return;
    case 'agent-card-corrupt':
      await writeAgentCardCorruption(payload);
      return;
    case 'agent-card-temp':
      await writeAgentCardTemporary(payload);
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
