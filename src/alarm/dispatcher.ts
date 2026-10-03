export type CommandSource = 'native' | 'home_assistant';

export interface AlarmCommandRequest {
  /** Domain-level command name/payload (e.g. 'arm_away', 'arm_home', 'disarm'). Opaque to the dispatcher. */
  command: string;
  source: CommandSource;
  /** Epoch-millisecond timestamp the request was issued, used for FR-014's conflict window. */
  requestedAt: number;
}

export type CommandHandler<T = unknown> = (command: AlarmCommandRequest) => T | Promise<T>;

/**
 * Thrown (as the dispatch() promise's rejection reason) when a command never
 * reaches the handler because FR-014's native-interface-precedence rule
 * rejected it in favor of a competing native-sourced command.
 */
export class CommandRejectedError extends Error {
  readonly command: AlarmCommandRequest;

  constructor(command: AlarmCommandRequest, message: string) {
    super(message);
    this.command = command;
  }
}

const DEFAULT_PRECEDENCE_WINDOW_MS = 500;

interface QueueEntry {
  command: AlarmCommandRequest;
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  /** True once processQueue() has handed this entry to the handler — no longer cancellable. */
  executing: boolean;
}

/**
 * Single-writer command dispatcher for the AlarmPanel (research.md section
 * 10 / FR-014). All arm/disarm commands, regardless of source, must flow
 * through one dispatcher instance so the native-interface-precedence rule is
 * a single, testable comparison rather than a race spread across API
 * handlers. Accepted commands are serialized: only one is ever in the
 * handler at a time, in FIFO arrival order.
 *
 * Precedence rule: when a `home_assistant`-sourced command and a
 * `native`-sourced command are both pending (queued or currently executing)
 * for requestedAt timestamps within `windowMs` of each other, the native
 * command wins — the Home Assistant command is rejected with
 * CommandRejectedError instead of ever reaching the handler. This is
 * evaluated symmetrically regardless of arrival order: a Home Assistant
 * command dispatched after a conflicting native one is rejected immediately;
 * a Home Assistant command already queued is rejected retroactively the
 * moment a conflicting native command arrives.
 *
 * A command already handed to the handler (`executing: true`) cannot be
 * un-executed if a conflicting native command arrives afterward — the
 * precedence rule only preempts commands that are still queued.
 *
 * No HTTP wiring here (Phase 02): the handler is an injected callback so
 * this module stays a pure, dependency-free unit of business logic; a later
 * phase wires it to the real AlarmPanel repository and maps
 * CommandRejectedError to REST contract's `409 Conflict`.
 */
export class AlarmCommandDispatcher {
  private readonly handler: CommandHandler;
  private readonly windowMs: number;
  private readonly queue: QueueEntry[] = [];
  private processing = false;

  constructor(handler: CommandHandler, options: { windowMs?: number } = {}) {
    this.handler = handler;
    this.windowMs = options.windowMs ?? DEFAULT_PRECEDENCE_WINDOW_MS;
  }

  dispatch<T = unknown>(command: AlarmCommandRequest): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const entry: QueueEntry = {
        command,
        resolve: resolve as (value: unknown) => void,
        reject,
        executing: false,
      };

      if (command.source === 'home_assistant' && this.hasConflictingNative(command)) {
        reject(
          new CommandRejectedError(
            command,
            'Rejected: a native-interface command took precedence within the conflict window.',
          ),
        );
        return;
      }

      if (command.source === 'native') {
        this.supersedeQueuedHomeAssistantCommands(command);
      }

      this.queue.push(entry);
      void this.processQueue();
    });
  }

  private isWithinWindow(a: AlarmCommandRequest, b: AlarmCommandRequest): boolean {
    return Math.abs(a.requestedAt - b.requestedAt) <= this.windowMs;
  }

  private hasConflictingNative(command: AlarmCommandRequest): boolean {
    return this.queue.some(
      (entry) => entry.command.source === 'native' && this.isWithinWindow(entry.command, command),
    );
  }

  private supersedeQueuedHomeAssistantCommands(nativeCommand: AlarmCommandRequest): void {
    for (let i = this.queue.length - 1; i >= 0; i -= 1) {
      const entry = this.queue[i];
      if (!entry.executing && entry.command.source === 'home_assistant' && this.isWithinWindow(entry.command, nativeCommand)) {
        this.queue.splice(i, 1);
        entry.reject(
          new CommandRejectedError(
            entry.command,
            'Rejected: superseded by a native-interface command within the conflict window.',
          ),
        );
      }
    }
  }

  private async processQueue(): Promise<void> {
    if (this.processing) return;
    this.processing = true;

    try {
      while (this.queue.length > 0) {
        const entry = this.queue[0];
        entry.executing = true;
        try {
          const result = await this.handler(entry.command);
          entry.resolve(result);
        } catch (err) {
          entry.reject(err);
        } finally {
          this.queue.shift();
        }
      }
    } finally {
      this.processing = false;
    }
  }
}
