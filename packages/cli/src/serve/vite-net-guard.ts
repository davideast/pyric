/**
 * The network guard in the Vite dev server process.
 *
 * Under `vite dev` the plugin swaps `firebase/*` for the browser. Modules Vite
 * loads for server rendering (`ssrLoadModule`, an environment runner, a
 * framework's SSR entry or loaders) are a different path: Vite externalizes
 * installed packages for SSR before any plugin `resolveId` runs, so their
 * `firebase/*` and `firebase-admin/*` imports load the real SDKs and talk to
 * live Firebase (#1123). Until the plugin routes them, this guard keeps that
 * traffic from reaching production.
 *
 * It installs the register's guard (`../register/net-guard.ts`) rather than a
 * copy. Two things differ from a `@pyric/cli/register` child:
 *   - The activator is the plugin running under `vite dev`, not `PYRIC_SANDBOX`.
 *   - The default mode is `block`. A registered child may talk to production
 *     beside the sandbox on purpose, so it reports by default. Nothing in the
 *     dev server process is meant to reach live Firebase except the AI
 *     upstreams the plugin permits, and SSR code that does reach it looks
 *     swapped to its author. `PYRIC_GUARD=warn` and `PYRIC_GUARD=off` still
 *     select the other modes, and `PYRIC_GUARD_ALLOW` still permits hosts.
 *
 * A process launched under `pyric sandbox` already has the register's guard;
 * that one is kept as it is.
 */
import { NET_GUARD_GLOBAL, installNetGuard, type NetGuard, type NetGuardHooks } from '../register/net-guard.js';

export const VITE_SSR_ISSUE_URL = 'https://github.com/davideast/pyric/issues/1123';

/** Stands in for `PYRIC_SANDBOX` in the env the guard reads; never written to `process.env`. */
const VITE_GUARD_ACTIVATOR = 'vite-dev';

/** Explains a guard verdict in the dev server: why SSR code reached production. */
export const VITE_SSR_GUARD_NOTE =
  '[pyric] This Vite dev server does not swap firebase/* or firebase-admin/* imports in server-rendered ' +
  `modules yet, so those calls go to live Firebase instead of the sandbox (${VITE_SSR_ISSUE_URL}). ` +
  'Until then, call Firebase from browser code, or call firebase-admin from a separate process started with ' +
  '`node --import @pyric/cli/register` and PYRIC_SANDBOX=remote against a hosted dev server.\n';

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

/** The env the guard installs under: activated, and `block` unless `PYRIC_GUARD` names a mode. */
export function viteGuardEnv(env: Record<string, string | undefined>): Record<string, string | undefined> {
  const namesMode = (env.PYRIC_GUARD ?? '').trim().length > 0;
  const mode = namesMode ? env.PYRIC_GUARD : 'block';
  const activator = env.PYRIC_SANDBOX || VITE_GUARD_ACTIVATOR;
  return { ...env, PYRIC_SANDBOX: activator, PYRIC_GUARD: mode };
}

/** Writes each guard line, then the SSR note once after the first verdict. */
function withSsrNote(write: (line: string) => void): (line: string) => void {
  let noted = false;
  return (line) => {
    write(line);
    const isVerdict = / (BLOCK|WARN|ALLOW) /.test(line);
    const needsNote = isVerdict && !noted;
    if (!needsNote) return;
    noted = true;
    write(VITE_SSR_GUARD_NOTE);
  };
}

/**
 * Install the guard in this process once, and publish it so the plugin's AI
 * upstreams can be permitted (`permitGuardHost`). Returns the guard in force,
 * or `null` when `PYRIC_GUARD=off`.
 */
export function installViteNetGuard(input: ViteNetGuardInput = {}): NetGuard | null {
  const slot = input.slot ?? (globalThis as unknown as GuardSlot);
  const existing = slot[NET_GUARD_GLOBAL] as NetGuard | undefined;
  if (existing !== undefined) return existing;
  const alreadyAttempted = slot[VITE_GUARD_ATTEMPTED] === true;
  if (alreadyAttempted) return null;
  slot[VITE_GUARD_ATTEMPTED] = true;
  const write = input.write ?? ((line: string) => void process.stderr.write(line));
  const guard = installNetGuard({
    ...input.hooks,
    env: viteGuardEnv(input.env ?? process.env),
    write: withSsrNote(write),
  });
  if (guard !== null) slot[NET_GUARD_GLOBAL] = guard;
  return guard;
}
