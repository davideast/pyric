/**
 * The network guard in the Vite dev server process.
 *
 * Under `vite dev` the plugin swaps `firebase/*` for the browser and routes
 * the served `firebase/*` subpaths and `firebase-admin/*` in the modules Vite
 * loads for server rendering to the sandbox (`vite-ssr-routing.ts`, #1123).
 * Code the swap doesn't reach, such as an installed package Vite externalizes
 * that loads `firebase-admin` itself, can act with admin authority only once
 * it holds a Google access token. This guard refuses every request for one
 * (ADR 0022), as it does in a `@pyric/cli/register` child.
 *
 * It installs the register's guard (`../register/net-guard.ts`) rather than a
 * copy. The activator is the plugin running under `vite dev`, not
 * `PYRIC_SANDBOX`; `PYRIC_GUARD` selects the mode as it does there.
 *
 * A live dev server (`pyricLive()`) installs live mode's network report
 * instead ({@link installViteLiveReport}): in live mode pyric observes and
 * never blocks at the network (ADR 0022, amendment 2026-11-07).
 *
 * A process launched under `pyric sandbox` already has the register's guard;
 * that one is kept as it is.
 */
import { NET_GUARD_GLOBAL, installNetGuard, type NetGuard, type NetGuardHooks } from '../register/net-guard.js';
import { installLiveNetGuard, type LiveNetReport } from '../register/live-net-guard.js';

export const VITE_SSR_ISSUE_URL = 'https://github.com/davideast/pyric/issues/1123';

/** Stands in for `PYRIC_SANDBOX` in the env the guard reads; never written to `process.env`. */
const VITE_GUARD_ACTIVATOR = 'vite-dev';

type GuardSlot = Record<symbol, unknown>;

/** Marks a process where this module already ran the install, so a Vite restart does not repeat it. */
const VITE_GUARD_ATTEMPTED = Symbol.for('pyric.viteNetGuardAttempted');

export interface ViteNetGuardInput {
  env?: Record<string, string | undefined>;
  write?: (line: string) => void;
  /** Where the installed guard is published. Defaults to `globalThis`. */
  slot?: GuardSlot;
  /** Stand-ins for the hooked Node seams, for tests. */
  hooks?: Omit<NetGuardHooks, 'env' | 'write'>;
}

/** The env the guard installs under: activated by the plugin when no `PYRIC_SANDBOX` is set. */
export function viteGuardEnv(env: Record<string, string | undefined>): Record<string, string | undefined> {
  const activator = env.PYRIC_SANDBOX || VITE_GUARD_ACTIVATOR;
  return { ...env, PYRIC_SANDBOX: activator };
}

/**
 * Install the guard in this process once, and publish it so the plugin's AI
 * upstreams can be permitted (`permitGuardHost`). Returns the guard in force,
 * or `null` under `PYRIC_GUARD=off`.
 */
export function installViteNetGuard(input: ViteNetGuardInput = {}): NetGuard | null {
  const slot = input.slot ?? (globalThis as unknown as GuardSlot);
  const existing = slot[NET_GUARD_GLOBAL] as NetGuard | undefined;
  if (existing !== undefined) return existing;
  if (slot[VITE_GUARD_ATTEMPTED] === true) return null;
  slot[VITE_GUARD_ATTEMPTED] = true;
  const guard = installNetGuard({ ...input.hooks, env: viteGuardEnv(input.env ?? process.env), write: input.write });
  if (guard !== null) slot[NET_GUARD_GLOBAL] = guard;
  return guard;
}

/** Marks a process where the live report is installed, so a Vite restart does not install it twice. */
const VITE_LIVE_REPORT = Symbol.for('pyric.viteLiveReport');

/**
 * Installs live mode's network report in the live dev server once: it
 * refuses nothing, and names each Google host no live row observes, with the
 * `@pyric/live/vite` prefix. The health report reads the hosts it lists.
 */
export function installViteLiveReport(input: Pick<ViteNetGuardInput, 'env' | 'write' | 'slot' | 'hooks'> = {}): LiveNetReport {
  const slot = input.slot ?? (globalThis as unknown as GuardSlot);
  const existing = slot[VITE_LIVE_REPORT] as LiveNetReport | undefined;
  if (existing !== undefined) return existing;
  const report = installLiveNetGuard({ ...input.hooks, env: input.env, write: input.write, logPrefix: '@pyric/live/vite' });
  slot[VITE_LIVE_REPORT] = report;
  return report;
}
