import { logger } from '../logger.js';

type Job<T> = {
  groupKey: string;
  run: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
};

type FairQueueOptions = {
  name: string;
  globalLimit: number;
  perGroupLimit: number;
  windowMs: number;
  logFailures?: boolean;
  maxPendingGlobal?: number;
  maxPendingPerGroup?: number;
};

export class QueueCapacityError extends Error {}

export class FairQueue {
  private readonly groupQueues = new Map<string, Job<unknown>[]>();
  private readonly groupOrder: string[] = [];
  private readonly globalLimiter: RollingLimiter;
  private readonly groupLimiters = new Map<string, RollingLimiter>();
  private readonly groupOutstanding = new Map<string, number>();
  private globalOutstanding = 0;
  private running = false;

  constructor(private readonly options: FairQueueOptions) {
    this.globalLimiter = new RollingLimiter(
      options.globalLimit,
      options.windowMs,
    );
  }

  enqueue<T>(groupKey: string, run: () => Promise<T>): Promise<T> {
    if (!this.hasCapacity(groupKey)) {
      return Promise.reject(
        new QueueCapacityError(
          `${this.options.name} queue capacity exceeded for group ${groupKey}`,
        ),
      );
    }
    this.reserveCapacity(groupKey);
    return new Promise<T>((resolve, reject) => {
      const queue = this.groupQueues.get(groupKey) ?? [];
      if (queue.length === 0 && !this.groupQueues.has(groupKey))
        this.groupOrder.push(groupKey);
      queue.push({
        groupKey,
        run,
        resolve: resolve as (value: unknown) => void,
        reject,
      });
      this.groupQueues.set(groupKey, queue as Job<unknown>[]);
      void this.drain();
    });
  }

  private async drain() {
    if (this.running) return;
    this.running = true;

    try {
      while (this.groupOrder.length > 0) {
        const groupKey = this.groupOrder.shift();
        if (!groupKey) continue;

        const queue = this.groupQueues.get(groupKey);
        const job = queue?.shift();
        if (!queue || !job) {
          this.groupQueues.delete(groupKey);
          continue;
        }

        if (queue.length > 0) this.groupOrder.push(groupKey);
        else this.groupQueues.delete(groupKey);

        const groupLimiter = this.limiterForGroup(groupKey);
        const waitMs = Math.max(
          this.globalLimiter.waitMs(),
          groupLimiter.waitMs(),
        );
        if (waitMs > 0) await sleep(waitMs);

        this.globalLimiter.take();
        groupLimiter.take();

        try {
          job.resolve(await job.run());
        } catch (error) {
          if (this.options.logFailures !== false) {
            logger.warn('Queued job failed', {
              queue: this.options.name,
              groupKey,
              error: error instanceof Error ? error.message : String(error),
            });
          }
          job.reject(error);
        } finally {
          this.releaseCapacity(groupKey);
        }
      }
    } finally {
      this.running = false;
      if (this.groupOrder.length > 0) void this.drain();
    }
  }

  private limiterForGroup(groupKey: string) {
    const existing = this.groupLimiters.get(groupKey);
    if (existing) return existing;

    const limiter = new RollingLimiter(
      this.options.perGroupLimit,
      this.options.windowMs,
    );
    this.groupLimiters.set(groupKey, limiter);
    return limiter;
  }

  private hasCapacity(groupKey: string) {
    return (
      this.globalOutstanding <
        (this.options.maxPendingGlobal ?? Number.POSITIVE_INFINITY) &&
      (this.groupOutstanding.get(groupKey) ?? 0) <
        (this.options.maxPendingPerGroup ?? Number.POSITIVE_INFINITY)
    );
  }

  private reserveCapacity(groupKey: string) {
    this.globalOutstanding += 1;
    this.groupOutstanding.set(
      groupKey,
      (this.groupOutstanding.get(groupKey) ?? 0) + 1,
    );
  }

  private releaseCapacity(groupKey: string) {
    this.globalOutstanding -= 1;
    const remaining = (this.groupOutstanding.get(groupKey) ?? 1) - 1;
    if (remaining > 0) this.groupOutstanding.set(groupKey, remaining);
    else this.groupOutstanding.delete(groupKey);
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
