import { describe, expect, it } from 'vitest';
import { AlarmCommandDispatcher, CommandRejectedError, type AlarmCommandRequest } from '../../src/alarm/dispatcher.js';

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (reason?: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function command(overrides: Partial<AlarmCommandRequest> = {}): AlarmCommandRequest {
  return {
    command: 'disarm',
    source: 'native',
    requestedAt: Date.now(),
    ...overrides,
  };
}

describe('AlarmCommandDispatcher', () => {
  it('serializes concurrent commands: only one is ever in the handler at a time, in FIFO order', async () => {
    let concurrent = 0;
    let maxConcurrent = 0;
    const startedOrder: string[] = [];

    const dispatcher = new AlarmCommandDispatcher(async (cmd) => {
      startedOrder.push(cmd.command);
      concurrent += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await delay(cmd.command === 'first' ? 20 : 5);
      concurrent -= 1;
      return cmd.command;
    });

    const now = Date.now();
    const first = dispatcher.dispatch(command({ command: 'first', requestedAt: now }));
    const second = dispatcher.dispatch(command({ command: 'second', source: 'native', requestedAt: now + 10_000 }));

    await expect(first).resolves.toBe('first');
    await expect(second).resolves.toBe('second');
    expect(maxConcurrent).toBe(1);
    expect(startedOrder).toEqual(['first', 'second']);
  });

  it('rejects a still-queued home_assistant command when a conflicting native command arrives afterward', async () => {
    const occupying = deferred<string>();
    const dispatcher = new AlarmCommandDispatcher(async (cmd) => {
      if (cmd.command === 'occupy') return occupying.promise;
      return cmd.command;
    });

    const now = Date.now();
    // Occupies the queue so the next two commands stay queued (not executing) until it resolves.
    const occupyResult = dispatcher.dispatch(command({ command: 'occupy', source: 'native', requestedAt: now - 100_000 }));

    const haResult = dispatcher.dispatch(
      command({ command: 'arm_away', source: 'home_assistant', requestedAt: now }),
    );
    const nativeResult = dispatcher.dispatch(
      command({ command: 'disarm', source: 'native', requestedAt: now + 100 }),
    );

    occupying.resolve('occupy');

    await expect(occupyResult).resolves.toBe('occupy');
    await expect(haResult).rejects.toBeInstanceOf(CommandRejectedError);
    await expect(nativeResult).resolves.toBe('disarm');
  });

  it('rejects a home_assistant command outright when a conflicting native command is already executing', async () => {
    const nativeHandlerStarted = deferred<void>();
    const releaseNative = deferred<string>();

    const dispatcher = new AlarmCommandDispatcher(async (cmd) => {
      if (cmd.command === 'arm_home') {
        nativeHandlerStarted.resolve();
        return releaseNative.promise;
      }
      return cmd.command;
    });

    const now = Date.now();
    const nativeResult = dispatcher.dispatch(command({ command: 'arm_home', source: 'native', requestedAt: now }));

    await nativeHandlerStarted.promise;

    const haResult = dispatcher.dispatch(
      command({ command: 'disarm', source: 'home_assistant', requestedAt: now + 50 }),
    );
    await expect(haResult).rejects.toBeInstanceOf(CommandRejectedError);

    releaseNative.resolve('arm_home');
    await expect(nativeResult).resolves.toBe('arm_home');
  });

  it('does not apply precedence across commands outside the conflict window', async () => {
    const dispatcher = new AlarmCommandDispatcher(async (cmd) => cmd.command, { windowMs: 500 });
    const now = Date.now();

    const haResult = dispatcher.dispatch(
      command({ command: 'arm_away', source: 'home_assistant', requestedAt: now }),
    );
    const nativeResult = dispatcher.dispatch(
      command({ command: 'disarm', source: 'native', requestedAt: now + 10_000 }),
    );

    await expect(haResult).resolves.toBe('arm_away');
    await expect(nativeResult).resolves.toBe('disarm');
  });

  it('honors a custom windowMs', async () => {
    const dispatcher = new AlarmCommandDispatcher(async (cmd) => cmd.command, { windowMs: 5 });
    const now = Date.now();

    const haResult = dispatcher.dispatch(
      command({ command: 'arm_away', source: 'home_assistant', requestedAt: now }),
    );
    const nativeResult = dispatcher.dispatch(
      command({ command: 'disarm', source: 'native', requestedAt: now + 50 }),
    );

    // 50ms apart with a 5ms window: no conflict, both should succeed.
    await expect(haResult).resolves.toBe('arm_away');
    await expect(nativeResult).resolves.toBe('disarm');
  });

  it('propagates handler errors without blocking subsequently queued commands', async () => {
    const dispatcher = new AlarmCommandDispatcher(async (cmd) => {
      if (cmd.command === 'boom') throw new Error('handler failed');
      return cmd.command;
    });

    const now = Date.now();
    const failing = dispatcher.dispatch(command({ command: 'boom', source: 'native', requestedAt: now }));
    const following = dispatcher.dispatch(
      command({ command: 'disarm', source: 'native', requestedAt: now + 10_000 }),
    );

    await expect(failing).rejects.toThrow('handler failed');
    await expect(following).resolves.toBe('disarm');
  });

  it('CommandRejectedError carries the rejected command for callers to inspect', async () => {
    const occupying = deferred<void>();
    const dispatcher = new AlarmCommandDispatcher(async (cmd) => {
      if (cmd.command === 'occupy') return occupying.promise;
      return cmd.command;
    });

    const now = Date.now();
    dispatcher.dispatch(command({ command: 'occupy', source: 'native', requestedAt: now - 100_000 }));

    const rejectedCommand = command({ command: 'arm_away', source: 'home_assistant', requestedAt: now });
    const haResult = dispatcher.dispatch(rejectedCommand);
    dispatcher.dispatch(command({ command: 'disarm', source: 'native', requestedAt: now + 100 }));

    try {
      await haResult;
      expect.unreachable('expected haResult to reject');
    } catch (err) {
      expect(err).toBeInstanceOf(CommandRejectedError);
      expect((err as CommandRejectedError).command).toEqual(rejectedCommand);
    } finally {
      occupying.resolve();
    }
  });
});
