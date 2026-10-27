// How many test jobs to run at once, from the machine's load when the run
// starts. The suites mostly wait on child processes and timeouts, so a busy
// machine turns them into timeouts: at 0.7 load per thread or more (the
// machine-load skill's "busy") the run goes one job at a time.

import { availableParallelism, loadavg } from 'node:os';

export interface MachineLoad {
  /** CPU threads the process can use. */
  threads: number;
  /** The one-minute load average. */
  load: number;
}

/** Load per thread at or above which the machine counts as busy. */
const BUSY_LOAD_PER_THREAD = 0.7;

export function chooseConcurrency(machine: MachineLoad): number {
  const isBusy = machine.load / machine.threads >= BUSY_LOAD_PER_THREAD;
  if (isBusy) return 1;
  const freeThreads = machine.threads - machine.load;
  return Math.max(1, Math.floor(freeThreads / 2));
}

export function measureMachineLoad(): MachineLoad {
  return { threads: availableParallelism(), load: loadavg()[0] ?? 0 };
}
