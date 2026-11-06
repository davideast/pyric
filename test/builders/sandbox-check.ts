/**
 * The check a phase runs on itself before it does anything: that it is
 * inside a run's sandbox. The canary's plant phase and a builder's run phase
 * both start with it, so a caller that skips the sandbox fails before
 * anything is planted or any builder starts.
 */
import { ownDirs } from './namespace.ts';
import { sandboxInventory } from './sandbox-inventory.ts';

/**
 * Throws, naming every problem, unless this process is inside the sandbox of
 * the run at `root`. `alsoOwn` names more directories whose sockets are the
 * run's own, such as an agent session's read-only sandbox directory with
 * its forwarder's socket. Returns how many directories the walk listed.
 */
export function assertInsideSandbox(root: string, refusing: string, alsoOwn: readonly string[] = []): number {
  const { problems, walked } = sandboxInventory([...ownDirs(root), ...alsoOwn]);
  if (problems.length > 0) throw new Error(`refusing to ${refusing}: this process is not inside a run's sandbox:\n- ${problems.join('\n- ')}`);
  return walked;
}

export function inventoryLine(walked: number): string {
  return `sandbox inventory: loopback only, resolv.conf names 127.0.0.1, no capabilities, host binds read-only, no /mnt, /run/WSL or /run/user, no foreign socket in ${walked} directories`;
}
