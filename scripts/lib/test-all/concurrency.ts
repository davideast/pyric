// How many test jobs to run at once, from how busy the machine is when the run
// starts. The suites mostly wait on child processes and timeouts, so a busy
// machine turns them into timeouts. The count is half the threads the CPUs
// leave free, so it shrinks smoothly as the machine fills up, down to one job
// at a time, and no more jobs than free memory holds.
//
// Busy threads are sampled from the CPU counters over a two-second window
// rather than read from the load average. `bun run test` builds the packages
// first, and the one-minute load average still counts that build for a minute
// after it ends, which would make every run on an idle machine look busy.

import { existsSync, readFileSync } from 'node:fs';
import { availableParallelism, cpus, freemem, type CpuInfo } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';

export interface MachineLoad {
  /** CPU threads the process can use. */
  threads: number;
  /** Threads busy over the sampled window, from 0 to `threads`. */
  load: number;
  /** Memory available to new processes, in bytes. */
  freeMemoryBytes: number;
}

/** Memory one job can take: a CLI shard starts dev servers and child processes. */
const MEMORY_PER_JOB = 1024 ** 3;
const SAMPLE_MS = 2000;

export function chooseConcurrency(machine: MachineLoad): number {
  const byCpu = Math.floor((machine.threads - machine.load) / 2);
  const byMemory = Math.floor(machine.freeMemoryBytes / MEMORY_PER_JOB);
  return Math.max(1, Math.min(byCpu, byMemory));
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
  if (existsSync('/proc/stat')) return parseProcStat(readFileSync('/proc/stat', 'utf8'));
  return cpus();
}

/** `MemAvailable` from /proc/meminfo, in bytes. */
export function parseMemAvailable(text: string): number | undefined {
  const match = /^MemAvailable:\s+(\d+) kB$/m.exec(text);
  return match ? Number(match[1]) * 1024 : undefined;
}

/**
 * Memory new processes can use. On Linux that is MemAvailable, which counts
 * reclaimable page cache; Bun's `os.freemem()` reports MemFree, a third of it
 * on a machine whose cache is warm.
 */
function readFreeMemory(): number {
  if (!existsSync('/proc/meminfo')) return freemem();
  return parseMemAvailable(readFileSync('/proc/meminfo', 'utf8')) ?? freemem();
}

export async function sampleMachineLoad(windowMs = SAMPLE_MS): Promise<MachineLoad> {
  const before = readCpuTimes();
  await sleep(windowMs);
  return { threads: availableParallelism(), load: busyThreads(before, readCpuTimes()), freeMemoryBytes: readFreeMemory() };
}
