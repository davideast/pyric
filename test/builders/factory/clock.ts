/** The supervisor's clock. Tests pass `FakeClock`, so no test waits on real time. */

export interface Clock {
  now(): number;
  /** Resolves after `ms`, or as soon as `signal` aborts. Never rejects. */
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  sleep(ms, signal) {
    return new Promise((resolve) => {
      if (signal?.aborted === true) return resolve();
      const timer = setTimeout(done, Math.max(0, ms));
      function done(): void {
        clearTimeout(timer);
        signal?.removeEventListener('abort', done);
        resolve();
      }
      signal?.addEventListener('abort', done, { once: true });
    });
  },
};
