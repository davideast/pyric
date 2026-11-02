/**
 * Test cleanup for Functions children: whatever a test asserted, no
 * `functions/child.js` process it caused may outlive it. Reads /proc, so it is
 * a no-op off Linux.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';

/** Pids whose parent is `ppid` and whose command runs the built Functions child. */
export function functionsChildrenOf(ppid: number): number[] {
  if (!existsSync('/proc')) return [];
  return readdirSync('/proc').filter((entry) => /^\d+$/.test(entry)).map(Number).filter((pid) => {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].split(' ');
      const cmdline = readFileSync(`/proc/${pid}/cmdline`, 'utf8');
      return Number(stat[1]) === ppid && cmdline.includes('functions/child.js');
    } catch {
      return false;
    }
  });
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** SIGKILL every Functions child of `ppid` that is still running. */
export function killFunctionsChildren(ppid: number): void {
  for (const pid of functionsChildrenOf(ppid)) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // Already gone.
    }
  }
}
