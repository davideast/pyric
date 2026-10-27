// How many test jobs to run at once, from how busy the machine's CPUs are when
// the run starts. The suites mostly wait on child processes and timeouts, so a
// busy machine turns them into timeouts: at 0.7 busy threads per thread or
// more (the machine-load skill's "busy") the run goes one job at a time.
//
// Busy threads are sampled from the CPU counters over a short window rather
// than read from the load average. `bun run test` builds the packages first,
// and the one-minute load average still counts that build for a minute after
// it ends, which would send every run on an idle machine one job at a time.

import { existsSync, readFileSync } from 'node:fs';
import { availableParallelism, cpus, type CpuInfo } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';

export interface MachineLoad {
  /** CPU threads the process can use. */
  threads: number;
  /** Threads busy over the sampled window, from 0 to `threads`. */
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

type CpuTimes = CpuInfo['times'];

function totalOf(times: CpuTimes): number {
  return times.user + times.nice + times.sys + times.idle + times.irq;
}

/** How many threads' worth of CPU time went to work between two `os.cpus()` readings. */
export function busyThreads(before: ReadonlyArray<{ times: CpuTimes }>, after: ReadonlyArray<{ times: CpuTimes }>): number {
  let busy = 0;
  for (const [index, cpu] of after.entries()) {
    const start = before[index]?.times;
    if (start === undefined) continue;
    const total = totalOf(cpu.times) - totalOf(start);
    const idle = cpu.times.idle - start.idle;
    const hasElapsed = total > 0;
    if (hasElapsed) busy += (total - idle) / total;
  }
  return busy;
}

/** One `cpuN` line of /proc/stat: user nice system idle iowait irq softirq steal, in clock ticks. */
export function parseProcStat(text: string): Array<{ times: CpuTimes }> {
  return text.split('\n').filter((line) => /^cpu\d+ /.test(line)).map((line) => {
    const [user = 0, nice = 0, sys = 0, idle = 0, iowait = 0, irq = 0, softirq = 0, steal = 0] = line.split(/\s+/).slice(1).map(Number);
    return { times: { user, nice, sys, idle: idle + iowait, irq: irq + softirq + steal } };
  });
}

/**
 * Per-CPU times, read from /proc/stat on Linux. Bun's `os.cpus()` returns the
 * same times on every call within a process, so it cannot show a change.
 */
function readCpuTimes(): Array<{ times: CpuTimes }> {
  const hasProcStat = existsSync('/proc/stat');
  return hasProcStat ? parseProcStat(readFileSync('/proc/stat', 'utf8')) : cpus();
}

export async function sampleMachineLoad(windowMs = 1000): Promise<MachineLoad> {
  const before = readCpuTimes();
  await sleep(windowMs);
  return { threads: availableParallelism(), load: busyThreads(before, readCpuTimes()) };
}
