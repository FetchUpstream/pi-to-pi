import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

type FixtureEvent = {
  readonly event?: string;
  readonly [key: string]: unknown;
};

type EventWaiter = {
  readonly predicate: (event: FixtureEvent) => boolean;
  readonly resolve: (event: FixtureEvent) => void;
  readonly timer: ReturnType<typeof setTimeout>;
};

const fixturePath = fileURLToPath(new URL('./lifecycle.mjs', import.meta.url));

function startFixture(): {
  readonly child: ChildProcessWithoutNullStreams;
  readonly events: FixtureEvent[];
  readonly waitForEvent: (
    predicate: (event: FixtureEvent) => boolean,
    timeoutMs?: number,
  ) => Promise<FixtureEvent>;
} {
  const child = spawn(process.execPath, [fixturePath], {
    shell: false,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const events: FixtureEvent[] = [];
  const waiters: EventWaiter[] = [];
  let pending = '';

  child.stdout.setEncoding('utf8');
  child.stdin.on('error', () => {});
  child.stdout.on('data', (chunk: string) => {
    pending += chunk;
    let newlineIndex = pending.indexOf('\n');
    while (newlineIndex !== -1) {
      const line = pending.slice(0, newlineIndex).replace(/\r$/, '');
      pending = pending.slice(newlineIndex + 1);
      if (line.trim() !== '') {
        events.push(JSON.parse(line) as FixtureEvent);
      }
      newlineIndex = pending.indexOf('\n');
    }
    for (let index = waiters.length - 1; index >= 0; index -= 1) {
      const waiter = waiters[index];
      const event = events.find(waiter.predicate);
      if (event) {
        clearTimeout(waiter.timer);
        waiters.splice(index, 1);
        waiter.resolve(event);
      }
    }
  });

  const waitForEvent = (
    predicate: (event: FixtureEvent) => boolean,
    timeoutMs = 2_000,
  ): Promise<FixtureEvent> => {
    const existing = events.find(predicate);
    if (existing) {
      return Promise.resolve(existing);
    }
    return new Promise<FixtureEvent>((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = waiters.findIndex((waiter) => waiter.timer === timer);
        if (index !== -1) {
          waiters.splice(index, 1);
        }
        reject(new Error(`Timed out waiting for lifecycle fixture event after ${timeoutMs}ms`));
      }, timeoutMs);
      waiters.push({ predicate, resolve, timer });
    });
  };

  return { child, events, waitForEvent };
}

async function stopFixture(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null) {
    return;
  }
  try {
    child.stdin.write('{"command":"shutdown"}\n');
    child.stdin.end();
  } catch {
    // The fixture may already have destroyed stdin during shutdown.
  }
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      child.kill();
      resolve();
    }, 2_000);
    child.once('close', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

describe('lifecycle fixture input ownership', () => {
  it('rejects an oversized command line and accepts the next shutdown command', async () => {
    const fixture = startFixture();
    try {
      await fixture.waitForEvent((event) => event.event === 'ready');
      const oversized = JSON.stringify({ command: 'diagnostic', message: 'x'.repeat(65 * 1024) });
      fixture.child.stdin.write(`${oversized}\n{"command":"shutdown"}\n`);

      const error = await fixture.waitForEvent((event) => event.error === 'command_line_too_large');
      expect(error.maxBytes).toBe(64 * 1024);
      await expect(
        fixture.waitForEvent((event) => event.event === 'exited'),
      ).resolves.toMatchObject({
        code: 0,
      });
    } finally {
      await stopFixture(fixture.child);
    }
  });

  it('does not process commands queued after shutdown begins', async () => {
    const fixture = startFixture();
    try {
      await fixture.waitForEvent((event) => event.event === 'ready');
      fixture.child.stdin.write(
        '{"command":"shutdown"}\n{"command":"diagnostic","message":"must not run"}\n',
      );

      await fixture.waitForEvent((event) => event.event === 'exited');
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(fixture.events).not.toContainEqual(
        expect.objectContaining({ message: 'must not run' }),
      );
    } finally {
      await stopFixture(fixture.child);
    }
  });
});
