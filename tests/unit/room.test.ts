import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  GIT_COMMON_DIRECTORY_ARGS,
  InvalidProjectLabelError,
  InvalidRoomIdError,
  RoomIsolationError,
  assertExactRoom,
  canonicalizeDirectory,
  deriveExplicitRoomId,
  deriveRoom,
  deriveRoomId,
  discoverGitCommonDirectory,
  hashRoomId,
  isSameRoom,
  isValidRoomId,
  normalizeProjectLabel,
  resolveRoom,
} from '../../src/room.js';

const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'pi-to-pi-room-'));
  temporaryDirectories.push(directory);
  return directory;
}

function git(args: readonly string[], cwd?: string): string {
  return execFileSync('git', [...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
}

function gitIsAvailable(): boolean {
  try {
    git(['--version']);
    return true;
  } catch {
    return false;
  }
}

function initializeRepository(directory: string): void {
  git(['init', '--quiet', directory]);
  writeFileSync(join(directory, 'README.md'), 'room test\n');
  git(['add', 'README.md'], directory);
  git(
    [
      '-c',
      'user.name=Room Test',
      '-c',
      'user.email=room@example.test',
      'commit',
      '--quiet',
      '-m',
      'init',
    ],
    directory,
  );
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe('explicit project normalization', () => {
  it('normalizes NFKC, case, Unicode letters/numbers, and separators', () => {
    expect(normalizeProjectLabel('  Ｆrontend / Café + 東京  ')).toBe('frontend-café-東京');
    expect(normalizeProjectLabel('a---b..c')).toBe('a-b-c');
    expect(normalizeProjectLabel('release_42')).toBe('release-42');
  });

  it('bounds labels by Unicode code points and trims the bounded separator', () => {
    expect(normalizeProjectLabel(`${'a'.repeat(48)}!!!`)).toBe('a'.repeat(48));
    expect(normalizeProjectLabel(`${'a'.repeat(47)} ${'b'.repeat(10)}`)).toBe('a'.repeat(47));
  });

  it('rejects controls and labels that normalize to empty', () => {
    expect(() => normalizeProjectLabel('frontend\u0000')).toThrow(InvalidProjectLabelError);
    expect(() => normalizeProjectLabel('frontend\nbackend')).toThrow(InvalidProjectLabelError);
    expect(() => normalizeProjectLabel('frontend\uFEFFbackend')).toThrow(InvalidProjectLabelError);
    expect(() => normalizeProjectLabel('---///')).toThrow(InvalidProjectLabelError);
    expect(() => normalizeProjectLabel('')).toThrow(InvalidProjectLabelError);
  });
});

describe('deterministic room ids', () => {
  it('uses a source discriminator and the first 128 bits of SHA-256', () => {
    const expectedDigest = createHash('sha256')
      .update('explicit\u0000frontend', 'utf8')
      .digest('hex')
      .slice(0, 32);

    expect(hashRoomId('explicit', 'frontend')).toBe(`r1-${expectedDigest}`);
    expect(deriveExplicitRoomId(' FRONTEND ')).toBe(`r1-${expectedDigest}`);
    expect(deriveExplicitRoomId('ＦＲＯＮＴＥＮＤ')).toBe(deriveExplicitRoomId('frontend'));
    expect(deriveExplicitRoomId('backend')).not.toBe(deriveExplicitRoomId('frontend'));
    expect(hashRoomId('explicit', 'frontend')).not.toBe(hashRoomId('cwd', 'frontend'));
    expect(isValidRoomId(`r1-${expectedDigest}`)).toBe(true);
    expect(isValidRoomId(`r1-${expectedDigest.toUpperCase()}`)).toBe(false);
    expect(isValidRoomId(`r2-${expectedDigest}`)).toBe(false);
  });

  it('rejects empty and delimiter-ambiguous hash inputs', () => {
    expect(() => hashRoomId('cwd', '')).toThrow();
    expect(() => hashRoomId('cwd', 'tmp\u0000room')).toThrow();
  });
});

describe('Git and cwd room derivation', () => {
  it('invokes Git with a non-shell argument vector and canonicalizes its result', () => {
    const directory = temporaryDirectory();
    const commonDirectory = join(directory, '.git');
    mkdirSync(commonDirectory);
    const runner = vi.fn(() => '.git\n');

    expect(discoverGitCommonDirectory(directory, { gitRunner: runner })).toBe(
      realpathSync(resolve(commonDirectory)),
    );
    expect(runner).toHaveBeenCalledWith(resolve(directory), GIT_COMMON_DIRECTORY_ARGS);
    expect(Object.isFrozen(GIT_COMMON_DIRECTORY_ARGS)).toBe(true);
  });

  it('groups Git worktrees by the canonical common directory', () => {
    if (!gitIsAvailable()) {
      return;
    }

    const parent = temporaryDirectory();
    const repository = join(parent, 'repository');
    const worktree = join(parent, 'worktree');
    mkdirSync(repository);
    initializeRepository(repository);
    git(['worktree', 'add', '--quiet', '-b', 'room-test-worktree', worktree], repository);

    const mainRoom = resolveRoom({ cwd: repository });
    const worktreeRoom = resolveRoom({ cwd: worktree });
    expect(mainRoom.source).toBe('git');
    expect(worktreeRoom.source).toBe('git');
    expect(mainRoom.value).toBe(worktreeRoom.value);
    expect(mainRoom.roomId).toBe(worktreeRoom.roomId);
  });

  it('keeps unrelated Git repositories isolated', () => {
    if (!gitIsAvailable()) {
      return;
    }

    const parent = temporaryDirectory();
    const first = join(parent, 'first');
    const second = join(parent, 'second');
    mkdirSync(first);
    mkdirSync(second);
    initializeRepository(first);
    initializeRepository(second);

    expect(deriveRoom({ cwd: first })).not.toBe(deriveRoom({ cwd: second }));
  });

  it('falls back to canonical cwd when Git fails', () => {
    const directory = temporaryDirectory();
    const otherDirectory = temporaryDirectory();
    const runner = vi.fn(() => {
      throw new Error('git unavailable');
    });

    const resolved = resolveRoom({ cwd: join(directory, '.'), gitRunner: runner });
    const otherResolved = resolveRoom({ cwd: join(otherDirectory, '.'), gitRunner: runner });
    expect(resolved.source).toBe('cwd');
    expect(resolved.value).toBe(canonicalizeDirectory(directory));
    expect(resolved.roomId).toBe(deriveRoomId('cwd', resolved.value));
    expect(resolved.roomId).not.toBe(otherResolved.roomId);
    expect(runner).toHaveBeenCalledTimes(2);
  });

  it.each(['', '\u0000'])('falls back when Git returns malformed output (%j)', (output) => {
    const directory = temporaryDirectory();
    const runner = vi.fn(() => output);

    const resolved = resolveRoom({ cwd: directory, gitRunner: runner });

    expect(resolved.source).toBe('cwd');
    expect(resolved.value).toBe(canonicalizeDirectory(directory));
    expect(resolved.roomId).toBe(deriveRoomId('cwd', directory));
  });

  it('canonicalizes direct path derivation inputs and rejects NUL paths', () => {
    const directory = temporaryDirectory();
    expect(deriveRoomId('cwd', join(directory, '.'))).toBe(deriveRoomId('cwd', directory));
    expect(() => deriveRoomId('cwd', `${directory}\u0000unsafe`)).toThrow('NUL');
  });

  it('converges equivalent path spellings and symlinks', () => {
    const directory = temporaryDirectory();
    const alias = join(directory, 'alias');
    try {
      symlinkSync(directory, alias, process.platform === 'win32' ? 'junction' : 'dir');
    } catch {
      // Symlinks may be unavailable on a restricted Windows test runner.
      return;
    }

    const gitRunner = () => {
      throw new Error('not a Git repository');
    };
    const direct = resolveRoom({ cwd: directory, gitRunner });
    const equivalent = resolveRoom({ cwd: join(alias, '..'), gitRunner });
    const symlinked = resolveRoom({ cwd: alias, gitRunner });

    expect(direct.source).toBe('cwd');
    expect(equivalent.roomId).toBe(direct.roomId);
    expect(symlinked.roomId).toBe(direct.roomId);
  });

  it('does not invoke Git when an explicit project is supplied', () => {
    const runner = vi.fn(() => {
      throw new Error('must not run');
    });

    const resolved = resolveRoom({
      project: 'Frontend',
      cwd: '/path/that/need/not/exist',
      gitRunner: runner,
    });
    expect(resolved.source).toBe('explicit');
    expect(resolved.value).toBe('frontend');
    expect(resolved.roomId).toBe(deriveExplicitRoomId('frontend'));
    expect(runner).not.toHaveBeenCalled();
  });
});

describe('exact room isolation', () => {
  it('accepts only valid equal room ids and rejects cross-room targets', () => {
    const current = deriveExplicitRoomId('frontend');
    const other = deriveExplicitRoomId('backend');

    expect(isSameRoom(current, current)).toBe(true);
    expect(isSameRoom(current, { roomId: current })).toBe(true);
    expect(isSameRoom(current, other)).toBe(false);
    expect(isSameRoom('not-a-room', 'not-a-room')).toBe(false);
    expect(assertExactRoom(current, current)).toBe(current);
    expect(() => assertExactRoom(current, other)).toThrow(RoomIsolationError);
    expect(() => assertExactRoom(current, 'not-a-room')).toThrow(InvalidRoomIdError);
  });
});
