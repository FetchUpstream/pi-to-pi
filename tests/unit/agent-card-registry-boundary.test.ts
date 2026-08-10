import { mkdtemp, readFile, readdir, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  AgentCardRegistry,
  cleanupAgentCardState,
  listLiveAgentCardPeers,
  listLiveAgentCards,
  removeAgentCard,
} from '../../src/discovery/agent-card-registry.js';
import { buildAgentCardPath, withAgentCardWriteLock } from '../../src/discovery/filesystem.js';
import { lookupPeerByName } from '../../src/discovery/lookup.js';

const ROOM_ID = `r1-${'a'.repeat(32)}`;
const STORAGE_KEY = 'room-key-1';
const RUNTIME_A = '11111111-1111-4111-8111-111111111111';
const RUNTIME_B = '22222222-2222-4222-8222-222222222222';
const RUNTIME_C = '33333333-3333-4333-8333-333333333333';
const RUNTIME_D = '44444444-4444-4444-8444-444444444444';
const RUNTIME_E = '55555555-5555-4555-8555-555555555555';
const RUNTIME_F = '66666666-6666-4666-8666-666666666666';
const BASE_NOW = Date.parse('2026-01-01T00:00:00.000Z');

const roots: string[] = [];

async function root(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), 'pi-to-pi-agent-card-'));
  roots.push(value);
  return value;
}

function registry(rootDirectory: string, runtimeId: string, now: () => number): AgentCardRegistry {
  return new AgentCardRegistry({
    rootDirectory,
    room: { roomId: ROOM_ID, storageKey: STORAGE_KEY },
    runtimeId,
    sessionId: `session-${runtimeId.slice(0, 4)}`,
    displayName: 'planner',
    endpoint: { kind: 'unix', address: `/tmp/pi-to-pi-${runtimeId.slice(0, 4)}` },
    clock: now,
  });
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((value) => rm(value, { recursive: true, force: true })));
});

describe('AgentCardRegistry boundary', () => {
  it('publishes one ISO card without touching the legacy record tree', async () => {
    const rootDirectory = await root();
    const registryInstance = registry(rootDirectory, RUNTIME_A, () => BASE_NOW);

    await registryInstance.start();
    const card = registryInstance.current();
    expect(card?.runtimeInstanceId).toBe(RUNTIME_A);
    expect(card?.endpoint.runtimeInstanceId).toBe(RUNTIME_A);
    expect(card?.runtimeStartedAt).toBe('2026-01-01T00:00:00.000Z');
    expect(card?.leaseExpiresAt).toBe('2026-01-01T00:01:30.000Z');

    const path = buildAgentCardPath(rootDirectory, STORAGE_KEY, RUNTIME_A);
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(card);
    expect(await readdir(join(rootDirectory, 'rooms', STORAGE_KEY, 'agents'))).toEqual([
      `${RUNTIME_A}.json`,
    ]);
    expect(await readdir(join(rootDirectory, 'rooms'))).toEqual([STORAGE_KEY]);
    await registryInstance.shutdown();
  });

  it('lists cards as collision-safe lookup peers and isolates rooms', async () => {
    const rootDirectory = await root();
    const first = registry(rootDirectory, RUNTIME_A, () => BASE_NOW);
    const second = registry(rootDirectory, RUNTIME_B, () => BASE_NOW);
    await first.start();
    await second.start();

    const peers = await listLiveAgentCardPeers(
      { roomId: ROOM_ID, storageKey: STORAGE_KEY },
      { rootDirectory, now: BASE_NOW, maxDurationMs: 2_000 },
    );
    expect(peers.map((peer) => peer.runtimeId).sort()).toEqual([RUNTIME_A, RUNTIME_B].sort());
    expect(new Set(peers.map((peer) => peer.networkName)).size).toBe(2);
    expect(lookupPeerByName('planner', ROOM_ID, peers).kind).toBe('ambiguous');
    expect(await listLiveAgentCards(`r1-${'b'.repeat(32)}`, { rootDirectory })).toEqual([]);

    await Promise.all([first.shutdown(), second.shutdown()]);
  });

  it('serializes metadata renewal and removes only the exact owner', async () => {
    const rootDirectory = await root();
    let now = BASE_NOW;
    const first = registry(rootDirectory, RUNTIME_A, () => now);
    const second = registry(rootDirectory, RUNTIME_B, () => now);
    await Promise.all([first.start(), second.start()]);

    now += 1_000;
    await Promise.all([first.updateMetadata({ state: 'busy' }), first.renew()]);
    expect(first.current()?.state).toBe('busy');
    expect(
      (
        await listLiveAgentCards(
          { roomId: ROOM_ID, storageKey: STORAGE_KEY },
          { rootDirectory, now },
        )
      ).map((card) => card.state),
    ).toContain('busy');

    expect(
      await removeAgentCard({ roomId: ROOM_ID, storageKey: STORAGE_KEY }, RUNTIME_A, {
        rootDirectory,
        expectedSessionId: first.sessionId,
        expectedEndpoint: first.current()!.endpoint.address,
      }),
    ).toBe(true);
    expect(
      await listLiveAgentCards(
        { roomId: ROOM_ID, storageKey: STORAGE_KEY },
        { rootDirectory, now },
      ),
    ).toHaveLength(1);
    expect(
      (
        await listLiveAgentCards(
          { roomId: ROOM_ID, storageKey: STORAGE_KEY },
          { rootDirectory, now },
        )
      )[0]?.runtimeInstanceId,
    ).toBe(RUNTIME_B);
    await second.shutdown();
  });

  it('removes only cards expired for two additional TTLs and keeps renewed cards', async () => {
    const rootDirectory = await root();
    let now = BASE_NOW;
    const stale = new AgentCardRegistry({
      rootDirectory,
      room: { roomId: ROOM_ID, storageKey: STORAGE_KEY },
      runtimeId: RUNTIME_A,
      sessionId: 'session-a',
      endpoint: { kind: 'unix', address: '/tmp/stale' },
      clock: () => now,
      ttlMs: 100,
    });
    const live = registry(rootDirectory, RUNTIME_B, () => now);
    await Promise.all([stale.start(), live.start()]);

    now += 301;
    const result = await cleanupAgentCardState(
      { roomId: ROOM_ID, storageKey: STORAGE_KEY },
      {
        rootDirectory,
        now,
        ttlMs: 100,
      },
    );
    expect(result.cardsRemoved).toBe(1);
    expect(
      (
        await listLiveAgentCards(
          { roomId: ROOM_ID, storageKey: STORAGE_KEY },
          { rootDirectory, now },
        )
      ).map((card) => card.runtimeInstanceId),
    ).toEqual([RUNTIME_B]);
    await live.shutdown();
    await stale.shutdown();
  });
  it('validates each final candidate independently and ignores malformed or unsafe records', async () => {
    const rootDirectory = await root();
    const live = registry(rootDirectory, RUNTIME_A, () => BASE_NOW);
    const expired = new AgentCardRegistry({
      rootDirectory,
      room: { roomId: ROOM_ID, storageKey: STORAGE_KEY },
      runtimeId: RUNTIME_B,
      sessionId: 'session-b',
      endpoint: { kind: 'unix', address: '/tmp/expired' },
      clock: () => BASE_NOW,
      ttlMs: 100,
    });
    await Promise.all([live.start(), expired.start()]);

    const agentsDirectory = join(rootDirectory, 'rooms', STORAGE_KEY, 'agents');
    const liveCard = live.current()!;
    const otherRoomId = `r1-${'b'.repeat(32)}`;
    const crossRoomCard = {
      ...liveCard,
      runtimeInstanceId: RUNTIME_C,
      roomId: otherRoomId,
      endpoint: { ...liveCard.endpoint, runtimeInstanceId: RUNTIME_C },
    };
    const mismatchedEndpointCard = {
      ...liveCard,
      runtimeInstanceId: RUNTIME_D,
      endpoint: { ...liveCard.endpoint, runtimeInstanceId: RUNTIME_B },
    };
    await writeFile(join(agentsDirectory, `${RUNTIME_C}.json`), JSON.stringify(crossRoomCard), {
      mode: 0o600,
    });
    await writeFile(
      join(agentsDirectory, `${RUNTIME_E}.json`),
      JSON.stringify(mismatchedEndpointCard),
      {
        mode: 0o600,
      },
    );
    await writeFile(join(agentsDirectory, 'not-a-runtime.json'), '{malformed', { mode: 0o600 });
    await symlink(
      buildAgentCardPath(rootDirectory, STORAGE_KEY, RUNTIME_A),
      join(agentsDirectory, `${RUNTIME_F}.json`),
    );

    const cards = await listLiveAgentCards(
      { roomId: ROOM_ID, storageKey: STORAGE_KEY },
      { rootDirectory, now: BASE_NOW + 100 },
    );
    expect(cards.map((card) => card.runtimeInstanceId)).toEqual([RUNTIME_A]);
    const peers = await listLiveAgentCardPeers(
      { roomId: ROOM_ID, storageKey: STORAGE_KEY },
      { rootDirectory, now: BASE_NOW + 100 },
    );
    expect(peers[0]?.runtimeId).toBe(RUNTIME_A);
    expect(peers[0]?.networkName).toMatch(/^planner-[0-9a-hjkmnp-tv-z]{4}$/u);

    await Promise.all([live.shutdown(), expired.shutdown()]);
  });

  it('cleans stale cards and only abandoned temporary files within the bounded grace period', async () => {
    const rootDirectory = await root();
    let now = BASE_NOW;
    const stale = new AgentCardRegistry({
      rootDirectory,
      room: { roomId: ROOM_ID, storageKey: STORAGE_KEY },
      runtimeId: RUNTIME_A,
      sessionId: 'session-a',
      endpoint: { kind: 'unix', address: '/tmp/stale' },
      clock: () => now,
      ttlMs: 100,
    });
    const live = registry(rootDirectory, RUNTIME_B, () => now);
    await Promise.all([stale.start(), live.start()]);

    const agentsDirectory = join(rootDirectory, 'rooms', STORAGE_KEY, 'agents');
    const oldTemporary = join(agentsDirectory, `.${RUNTIME_A}.json.tmp-123-abcd-deadbeef`);
    const freshTemporary = join(agentsDirectory, `.${RUNTIME_B}.json.tmp-123-abcd-deadbeef`);
    await writeFile(oldTemporary, 'old', { mode: 0o600 });
    await writeFile(freshTemporary, 'fresh', { mode: 0o600 });
    await utimes(oldTemporary, new Date(BASE_NOW), new Date(BASE_NOW));
    await utimes(freshTemporary, new Date(BASE_NOW + 250), new Date(BASE_NOW + 250));

    now = BASE_NOW + 300;
    const result = await cleanupAgentCardState(
      { roomId: ROOM_ID, storageKey: STORAGE_KEY },
      { rootDirectory, now, ttlMs: 100, maxEntries: 32, maxDurationMs: 2_000 },
    );
    expect(result).toEqual({ cardsRemoved: 1, temporaryFilesRemoved: 1, totalRemoved: 2 });
    await expect(readFile(oldTemporary, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(freshTemporary, 'utf8')).resolves.toBe('fresh');
    expect(
      (
        await listLiveAgentCards(
          { roomId: ROOM_ID, storageKey: STORAGE_KEY },
          { rootDirectory, now },
        )
      ).map((card) => card.runtimeInstanceId),
    ).toEqual([RUNTIME_B]);

    await Promise.all([stale.shutdown(), live.shutdown()]);
  });

  it('revalidates a candidate after a queued renewal before stale deletion', async () => {
    const rootDirectory = await root();
    let now = BASE_NOW;
    const stale = new AgentCardRegistry({
      rootDirectory,
      room: { roomId: ROOM_ID, storageKey: STORAGE_KEY },
      runtimeId: RUNTIME_A,
      sessionId: 'session-a',
      endpoint: { kind: 'unix', address: '/tmp/stale' },
      clock: () => now,
      ttlMs: 100,
    });
    await stale.start();
    now = BASE_NOW + 301;

    const cardPath = buildAgentCardPath(rootDirectory, STORAGE_KEY, RUNTIME_A);
    let releaseLock: (() => void) | undefined;
    let resolveLockEntered: (() => void) | undefined;
    const lockEntered = new Promise<void>((resolve) => {
      resolveLockEntered = resolve;
    });
    const holder = withAgentCardWriteLock(cardPath, async () => {
      resolveLockEntered?.();
      await new Promise<void>((resolve) => {
        releaseLock = resolve;
      });
    });
    await lockEntered;

    const renewal = stale.renew();
    await Promise.resolve();
    const cleanup = cleanupAgentCardState(
      { roomId: ROOM_ID, storageKey: STORAGE_KEY },
      { rootDirectory, now, ttlMs: 100 },
    );
    releaseLock?.();
    await Promise.all([holder, renewal]);
    expect((await cleanup).cardsRemoved).toBe(0);
    expect(
      await listLiveAgentCards(
        { roomId: ROOM_ID, storageKey: STORAGE_KEY },
        { rootDirectory, now },
      ),
    ).toHaveLength(1);
    await stale.shutdown();
  });
});
