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
};

export class FairQueue {
  private readonly guildQueues = new Map<string, Job<unknown>[]>();
  private readonly guildOrder: string[] = [];
  private readonly globalLimiter: RollingLimiter;
  private readonly guildLimiters = new Map<string, RollingLimiter>();
  private running = false;

  constructor(private readonly options: FairQueueOptions) {
    this.globalLimiter = new RollingLimiter(options.globalLimit, options.windowMs);
  }

  enqueue<T>(guildId: string, run: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const queue = this.guildQueues.get(guildId) ?? [];
      if (queue.length === 0 && !this.guildQueues.has(guildId)) this.guildOrder.push(guildId);
      queue.push({ guildId, run, resolve: resolve as (value: unknown) => void, reject });
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
        const waitMs = Math.max(this.globalLimiter.waitMs(), guildLimiter.waitMs());
        if (waitMs > 0) await sleep(waitMs);

        this.globalLimiter.take();
        guildLimiter.take();

        try {
          job.resolve(await job.run());
        } catch (error) {
          logger.warn('Queued job failed', {
            queue: this.options.name,
            guildId,
            error: error instanceof Error ? error.message : String(error),
          });
          job.reject(error);
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

    const limiter = new RollingLimiter(this.options.perGuildLimit, this.options.windowMs);
    this.guildLimiters.set(guildId, limiter);
    return limiter;
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
