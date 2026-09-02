/**
 * The interlock: the launcher's statement about interception in the child it
 * is about to start, plus the warn-only watchdog for the child's answer.
 *
 * The status line is knowable synchronously from the env `pyric sandbox` just
 * assembled: guard mode, whether NODE_OPTIONS really carries the register
 * import, and where the child's handshake beacon will land. The watchdog is
 * the other half: a child still alive well after launch that never posted a
 * beacon is probably not intercepted.
 */
import { beaconEndpoint } from '../register/beacon.js';
import { parseGuardMode, type GuardMode } from '../register/net-guard.js';
import { formatInlinedArtifactWarnings, scanBackendArtifacts } from './sandbox-preflight.js';
import { detectUnsupportedRuntime, formatUnsupportedRuntimeWarning } from './unsupported-runtime.js';

/**
 * What `pyric sandbox` can say about the interception it is about to hand the
 * child, entirely from the env it just assembled: no waiting, no round trip.
 */
export interface InterlockStatus {
  /** Net-guard mode the child will run under (`PYRIC_GUARD`, default warn). */
  readonly guard: GuardMode;
  /** Whether `NODE_OPTIONS` actually carries the register `--import`. */
  readonly registerImported: boolean;
  /** Where the child's handshake beacon will land, or null when the
   *  activator carries no bridge URL. */
  readonly beacon: string | null;
}

/**
 * Read the interlock off the child env. Everything here is synchronous by
 * construction: it is a statement about the launch, printed before anything at
 * runtime has had a chance to go wrong.
 */
export function describeInterlock(
  childEnv: NodeJS.ProcessEnv,
  registerUrl: string,
): InterlockStatus {
  return {
    guard: parseGuardMode(childEnv.PYRIC_GUARD),
    registerImported: (childEnv.NODE_OPTIONS ?? '').includes(`--import ${registerUrl}`),
    beacon: beaconEndpoint(childEnv.PYRIC_SANDBOX),
  };
}

/**
 * The startup status line, alongside the other `✔ <service>` checks.
 *
 * The healthy line is deliberately short: one fact per field and nothing the
 * reader has to skim past. The degraded line is long because it reports a
 * broken launch, which is worth every word.
 */
export function formatInterlockLine(status: InterlockStatus): string {
  if (!status.registerImported) {
    return (
      `⚠ interlock guard=${status.guard}, register is NOT in the child's NODE_OPTIONS. ` +
      `Its firebase-admin/firebase imports will NOT be rewritten and would reach LIVE Firebase.\n`
    );
  }
  return `✔ interlock guard=${status.guard}, register loaded via NODE_OPTIONS\n`;
}

export interface LaunchCheckOptions {
  /** The environment the child is about to receive. */
  readonly childEnv: NodeJS.ProcessEnv;
  /** Absolute `file:` URL of the register module, to look for in NODE_OPTIONS. */
  readonly registerUrl: string;
  /** The child's argv, for the unsupported-runtime check. */
  readonly argv: readonly string[];
  /** Project root whose backend build dirs are pre-flighted. */
  readonly cwd: string;
  readonly write: (line: string) => void;
}

/**
 * Every statement the launcher makes about the child, printed in one block
 * before the spawn, and the interlock status it derived on the way.
 *
 * Three checks, in order:
 *
 *  1. The interlock status line, from the env alone.
 *  2. The pre-flight artifact scan. The loader swap only reaches code that
 *     still imports firebase or firebase-admin, so a backend bundle that
 *     compiled the SDK in sails past register untouched and talks to live
 *     Google. Warn-only, and silent on a clean project.
 *  3. The unsupported-runtime warning, for the other way interception can be
 *     absent: a child runtime that never evaluates Node loader hooks at all.
 *
 * The pre-flight scan runs only here, on the launched-child path. With no
 * child there is nothing to pre-flight.
 */
export function reportLaunchChecks(opts: LaunchCheckOptions): InterlockStatus {
  const interlock = describeInterlock(opts.childEnv, opts.registerUrl);
  opts.write(formatInterlockLine(interlock));
  for (const line of formatInlinedArtifactWarnings(scanBackendArtifacts(opts.cwd))) {
    opts.write(`${line}\n`);
  }
  const unsupportedRuntime = detectUnsupportedRuntime(opts.argv);
  if (unsupportedRuntime !== null) opts.write(formatUnsupportedRuntimeWarning(unsupportedRuntime));
  return interlock;
}

/** How long a child may live without its beacon before we say something. */
const BEACON_GRACE_MS = 15_000;

export interface BeaconWatchdogOptions {
  /** The child command, for attribution in the warning. */
  readonly label: string;
  /** The endpoint the child would post to. Null means nothing to watch. */
  readonly beacon: string | null;
  /** Whether a beacon from this child has been recorded. */
  readonly sawBeacon: () => boolean;
  /** Whether the child is still running. */
  readonly isAlive: () => boolean;
  readonly warn: (line: string) => void;
  readonly graceMs?: number;
}

export interface BeaconWatchdog {
  /** Cancel a pending check. Idempotent. */
  stop(): void;
}

/** The warning itself: one paragraph naming what the silence means and what
 *  to check. Kept separate so its exact wording is testable. */
export function formatMissingBeaconWarning(opts: {
  label: string;
  graceMs: number;
  beacon: string;
}): string {
  const seconds = Math.round(opts.graceMs / 1000);
  return (
    `  ⚠ interlock: \`${opts.label}\` has been running ${seconds}s without posting a register ` +
    `beacon to ${opts.beacon}. Its firebase-admin/firebase imports are probably NOT routed to ` +
    `the pyric sandbox, which means they would reach LIVE Firebase. Check that the command starts ` +
    `a Node process (bun and deno do not evaluate Node loader hooks), that it does not overwrite ` +
    `NODE_OPTIONS, and that NODE_ENV is not production. Warning only: nothing was blocked, and ` +
    `this is reported once per child.`
  );
}

/**
 * The warn-only interlock watchdog.
 *
 * It never kills the child and never blocks a request. The reason is the
 * signal's own honesty: beacon delivery is best-effort (see
 * `register/beacon.ts`), and a plausible silent child is not the same thing as
 * a broken one. A short-lived script that exits before its POST lands, a child
 * that reaches the sandbox only through a grandchild, a dev server slow to
 * boot: each would be killed by a fail-closed version of this check, and each
 * is fine.
 *
 * So the heuristic is the simple, attributable one: the child is still alive
 * `graceMs` after launch and no beacon has arrived. Both halves matter. An
 * exited child was never expected to say anything, and a child whose beacon
 * landed has already proved the point. One warning per child, guaranteed by
 * the one-shot timer; the timer is unref'd so a watchdog can never be the
 * reason a process stays up.
 *
 * `sawBeacon` is a count delta rather than a pid match, deliberately. The
 * process that loads register is often a grandchild (`npm run dev` starts
 * node, `next dev` starts its worker), so the spawned child's own pid is
 * frequently not the pid in the beacon, and matching on it would warn about
 * perfectly healthy launches. The delta's known imprecision runs the other
 * way: a sibling runtime's beacon that lands inside the grace window can mask
 * a real miss. Erring toward silence is the right bias for a warn-only check.
 */
export function startBeaconWatchdog(opts: BeaconWatchdogOptions): BeaconWatchdog {
  const beacon = opts.beacon;
  if (beacon === null) return { stop: () => {} };
  const graceMs = opts.graceMs ?? BEACON_GRACE_MS;
  const timer = setTimeout(() => {
    if (opts.sawBeacon() || !opts.isAlive()) return;
    opts.warn(formatMissingBeaconWarning({ label: opts.label, graceMs, beacon }));
  }, graceMs);
  timer.unref?.();
  return {
    stop(): void {
      clearTimeout(timer);
    },
  };
}
