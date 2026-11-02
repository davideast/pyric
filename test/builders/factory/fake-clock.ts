/**
 * A clock that moves only when a test says so. `runUntilSettled` lets every
 * pending promise run, then jumps to the next timer, until the work settles:
 * an eight-hour run takes milliseconds.
 */
import type { Clock } from './clock.ts';

interface Timer {
  at: number;
  resolve: () => void;
}

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
const SETTLE_TICKS = 5;

export class FakeClock implements Clock {
  private timers: Timer[] = [];

  constructor(private current: number) {}

  now(): number {
    return this.current;
  }

  sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      if (signal?.aborted === true) return resolve();
      const timer: Timer = { at: this.current + Math.max(0, ms), resolve };
      this.timers.push(timer);
      signal?.addEventListener('abort', () => this.fire(timer), { once: true });
    });
  }

  /** Moves to `at`, firing every timer due by then, in order. */
  async advanceTo(at: number): Promise<void> {
    for (let next = this.nextDue(at); next !== undefined; next = this.nextDue(at)) {
      this.current = Math.max(this.current, next.at);
      this.fire(next);
      await this.settle();
    }
    this.current = Math.max(this.current, at);
    await this.settle();
  }

  /** Runs `work` to the end, jumping from timer to timer whenever nothing else can run. */
  async runUntilSettled<T>(work: Promise<T>, limit = 100_000): Promise<T> {
    let settled = false;
    const result = work.finally(() => { settled = true; });
    for (let step = 0; step < limit; step += 1) {
      await this.settle();
      if (settled) return result;
      const next = this.earliest();
      if (next === undefined) throw new Error('the work is waiting on something other than the clock');
      await this.advanceTo(next.at);
    }
    throw new Error(`the work did not settle within ${limit} timer steps`);
  }

  private async settle(): Promise<void> {
    for (let tick = 0; tick < SETTLE_TICKS; tick += 1) await flush();
  }

  private earliest(): Timer | undefined {
    return this.timers.reduce<Timer | undefined>((soonest, timer) => {
      const isSooner = soonest === undefined || timer.at < soonest.at;
      return isSooner ? timer : soonest;
    }, undefined);
  }

  private nextDue(at: number): Timer | undefined {
    const next = this.earliest();
    const isDue = next !== undefined && next.at <= at;
    return isDue ? next : undefined;
  }

  private fire(timer: Timer): void {
    const index = this.timers.indexOf(timer);
    if (index === -1) return;
    this.timers.splice(index, 1);
    timer.resolve();
  }
}
