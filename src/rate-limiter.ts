import { WordstatError } from "./errors.js";

function abortError(): WordstatError {
  return new WordstatError("CANCELLED", "The request was cancelled");
}

export function delay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(abortError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export class RequestLimiter {
  private active = 0;
  private readonly concurrencyWaiters: Array<() => void> = [];
  private readonly secondStarts: number[] = [];
  private readonly hourStarts: number[] = [];

  constructor(
    private readonly maxConcurrency: number,
    private readonly maxRps: number,
    private readonly maxRph: number,
  ) {}

  private prune(now: number): void {
    while (this.secondStarts[0] !== undefined && this.secondStarts[0] <= now - 1_000) {
      this.secondStarts.shift();
    }
    if (this.maxRph > 0) {
      while (this.hourStarts[0] !== undefined && this.hourStarts[0] <= now - 3_600_000) {
        this.hourStarts.shift();
      }
    }
  }

  private async acquireConcurrency(signal: AbortSignal): Promise<void> {
    while (this.active >= this.maxConcurrency) {
      await new Promise<void>((resolve, reject) => {
        const waiter = (): void => {
          signal.removeEventListener("abort", onAbort);
          resolve();
        };
        const onAbort = (): void => {
          const index = this.concurrencyWaiters.indexOf(waiter);
          if (index >= 0) this.concurrencyWaiters.splice(index, 1);
          reject(abortError());
        };
        this.concurrencyWaiters.push(waiter);
        signal.addEventListener("abort", onAbort, { once: true });
      });
    }
    if (signal.aborted) throw abortError();
    this.active += 1;
  }

  private releaseConcurrency(): void {
    this.active -= 1;
    this.concurrencyWaiters.shift()?.();
  }

  private async waitForRate(signal: AbortSignal): Promise<void> {
    for (;;) {
      const now = Date.now();
      this.prune(now);
      if (this.maxRph > 0 && this.hourStarts.length >= this.maxRph) {
        const retryAfterMs = Math.max(1, this.hourStarts[0]! + 3_600_000 - now);
        throw new WordstatError("RATE_LIMITED", "Local hourly Wordstat budget is exhausted", {
          retryable: true,
          retryAfterSeconds: Math.ceil(retryAfterMs / 1_000),
        });
      }
      if (this.secondStarts.length < this.maxRps) {
        this.secondStarts.push(now);
        if (this.maxRph > 0) this.hourStarts.push(now);
        return;
      }
      const waitMs = Math.max(1, this.secondStarts[0]! + 1_000 - now);
      await delay(waitMs, signal);
    }
  }

  async run<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
    await this.acquireConcurrency(signal);
    try {
      await this.waitForRate(signal);
      return await operation();
    } finally {
      this.releaseConcurrency();
    }
  }

  hourlyRemaining(): number | null {
    this.prune(Date.now());
    return this.maxRph === 0 ? null : Math.max(0, this.maxRph - this.hourStarts.length);
  }
}
