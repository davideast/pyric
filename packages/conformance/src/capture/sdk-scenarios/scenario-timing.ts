import type { ScenarioTiming } from './scenario-types.ts';

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function bounded<T>(label: string, promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timeout`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function within(promise: Promise<unknown>, ms: number): Promise<void> {
  const settled = promise.then(() => undefined, () => undefined);
  await bounded('within', settled, ms).catch(() => undefined);
}

/** Real time, for a production capture. */
export const productionTiming: ScenarioTiming = { wait: sleep, bounded, within };

/**
 * A replay against a local sandbox: every wait drains a few macrotasks, so
 * listeners and acknowledgements land without the capture's real delays.
 */
export const replayTiming: ScenarioTiming = {
  async wait() {
    for (let turn = 0; turn < 5; turn++) await sleep(0);
  },
  bounded,
  within,
};
