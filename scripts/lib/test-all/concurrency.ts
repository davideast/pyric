// How many test jobs to run at once, from how busy the machine is when the run
// starts. The suites mostly wait on child processes and timeouts, so a busy
// machine turns them into timeouts. The count is half the threads the CPUs
// leave free, so it shrinks smoothly as the machine fills up, down to one job
// at a time, and no more jobs than free memory holds.
//
// The machine is sampled by scripts/lib/machine-load.ts, shared with
// test/apps/run.ts.

import { GIB, type MachineLoad } from '../machine-load.ts';

export { sampleMachineLoad, type MachineLoad } from '../machine-load.ts';

/** Memory one job can take: a CLI shard starts dev servers and child processes. */
const MEMORY_PER_JOB = GIB;

export function chooseConcurrency(machine: MachineLoad): number {
  const byCpu = Math.floor((machine.threads - machine.load) / 2);
  const byMemory = Math.floor(machine.freeMemoryBytes / MEMORY_PER_JOB);
  return Math.max(1, Math.min(byCpu, byMemory));
}

