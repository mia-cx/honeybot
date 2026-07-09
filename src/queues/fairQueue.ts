import { logger } from '../logger.js';

type Job<T> = {
  guildId: string;
  run: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
};

type FairQueueOptions = {
  name: string;
  globalLimit: number;
  perGuildLimit: number;
  windowMs: number;
  logFailures?: boolean;
  maxPendingGlobal?: number;
  maxPendingPerGuild?: number;
};

export class QueueCapacityError extends Error {}

export class FairQueue {
  private readonly guildQueues = new Map<string, Job<unknown>[]>();
  private readonly guildOrder: string[] = [];
  private readonly globalLimiter: RollingLimiter;
  private readonly guildLimiters = new Map<string, RollingLimiter>();
  private readonly guildOutstanding = new Map<string, number>();
  private globalOutstanding = 0;
  private running = false;

  constructor(private readonly options: FairQueueOptions) {
    this.globalLimiter = new RollingLimiter(
      options.globalLimit,
      options.windowMs,
    );
  }

  enqueue<T>(guildId: string, run: () => Promise<T>): Promise<T> {
    if (!this.hasCapacity(guildId)) {
      return Promise.reject(
        new QueueCapacityError(
          `${this.options.name} queue capacity exceeded for guild ${guildId}`,
        ),
      );
    }
    this.reserveCapacity(guildId);
    return new Promise<T>((resolve, reject) => {
      const queue = this.guildQueues.get(guildId) ?? [];
      if (queue.length === 0 && !this.guildQueues.has(guildId))
        this.guildOrder.push(guildId);
      queue.push({
        guildId,
        run,
        resolve: resolve as (value: unknown) => void,
        reject,
      });
      this.guildQueues.set(guildId, queue as Job<unknown>[]);
      void this.drain();
    });
  }

  private async drain() {
    if (this.running) return;
    this.running = true;

    try {
      while (this.guildOrder.length > 0) {
        const guildId = this.guildOrder.shift();
        if (!guildId) continue;

        const queue = this.guildQueues.get(guildId);
        const job = queue?.shift();
        if (!queue || !job) {
          this.guildQueues.delete(guildId);
          continue;
        }

        if (queue.length > 0) this.guildOrder.push(guildId);
        else this.guildQueues.delete(guildId);

        const guildLimiter = this.limiterForGuild(guildId);
        const waitMs = Math.max(
          this.globalLimiter.waitMs(),
          guildLimiter.waitMs(),
        );
        if (waitMs > 0) await sleep(waitMs);

        this.globalLimiter.take();
        guildLimiter.take();

        try {
          job.resolve(await job.run());
        } catch (error) {
          if (this.options.logFailures !== false) {
            logger.warn('Queued job failed', {
              queue: this.options.name,
              guildId,
              error: error instanceof Error ? error.message : String(error),
            });
          }
          job.reject(error);
        } finally {
          this.releaseCapacity(guildId);
        }
      }
    } finally {
      this.running = false;
      if (this.guildOrder.length > 0) void this.drain();
    }
  }

  private limiterForGuild(guildId: string) {
    const existing = this.guildLimiters.get(guildId);
    if (existing) return existing;

    const limiter = new RollingLimiter(
      this.options.perGuildLimit,
      this.options.windowMs,
    );
    this.guildLimiters.set(guildId, limiter);
    return limiter;
  }

  private hasCapacity(guildId: string) {
    return (
      this.globalOutstanding <
        (this.options.maxPendingGlobal ?? Number.POSITIVE_INFINITY) &&
      (this.guildOutstanding.get(guildId) ?? 0) <
        (this.options.maxPendingPerGuild ?? Number.POSITIVE_INFINITY)
    );
  }

  private reserveCapacity(guildId: string) {
    this.globalOutstanding += 1;
    this.guildOutstanding.set(
      guildId,
      (this.guildOutstanding.get(guildId) ?? 0) + 1,
    );
  }

  private releaseCapacity(guildId: string) {
    this.globalOutstanding -= 1;
    const remaining = (this.guildOutstanding.get(guildId) ?? 1) - 1;
    if (remaining > 0) this.guildOutstanding.set(guildId, remaining);
    else this.guildOutstanding.delete(guildId);
  }
}

class RollingLimiter {
  private readonly timestamps: number[] = [];

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  waitMs(now = Date.now()) {
    this.sweep(now);
    if (this.timestamps.length < this.limit) return 0;
    const oldest = this.timestamps[0] ?? now;
    return Math.max(0, oldest + this.windowMs - now);
  }

  take(now = Date.now()) {
    this.sweep(now);
    this.timestamps.push(now);
  }

  private sweep(now: number) {
    const cutoff = now - this.windowMs;
    while (this.timestamps[0] !== undefined && this.timestamps[0] <= cutoff) {
      this.timestamps.shift();
    }
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
