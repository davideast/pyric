/**
 * What every live mode start prints: that this is live mode, and which
 * project. The register entry also says which host its calls reach, and how to start one
 * when none would show them.
 */
import type { LiveHostReach } from '@pyric/cli/register/internal/supplied-rows';
import { ADMIN_PASS_THROUGH } from './refusal.js';

const REGISTER_ENTRY = '@pyric/live/register';

/**
 * The Admin line of `entry`: `firebase-admin` passes through to the Node
 * processes under the live register, whose Admin SDK calls use their own
 * credential, reach production unobserved and bypass Security Rules. The
 * register says it of its own process; the Vite host, of those processes.
 */
export function adminPassThroughLine(entry: string): string {
  const callers = entry === REGISTER_ENTRY ? "This process's Admin SDK calls" : 'Their Admin SDK calls';
  return (
    `${entry}: ${ADMIN_PASS_THROUGH} passes through for Node processes under ${REGISTER_ENTRY}. ` +
    `${callers} use the process's own credential, go to production unobserved, and bypass Security Rules.`
  );
}

/**
 * One start line for each passed-through import: the Admin line for
 * `firebase-admin`, and `passThroughLine` for the rest. Each entry hands in
 * the line from its own `@pyric/cli` seam, so the Vite plugin never loads
 * the register's.
 */
export function passThroughLines(entry: string, passThrough: readonly string[], passThroughLine: (specifier: string) => string): string[] {
  return passThrough.map((specifier) => {
    const isAdmin = specifier === ADMIN_PASS_THROUGH;
    return isAdmin ? adminPassThroughLine(entry) : `${entry}: ${passThroughLine(specifier)}`;
  });
}

/** The start line of `entry` (`pyric-live`, `@pyric/live/vite`, `@pyric/live/register`). */
export function liveStartLine(entry: string, projectId: string): string {
  return (
    `${entry}: live mode for the Firebase project ${projectId}. Your app talks to production with its real data, ` +
    'and production bills each read, write and listener delivery.'
  );
}

const START_HOST = 'npx pyric-live, or vite dev with pyricLive() from @pyric/live/vite';

/** What a Node process's start says about the host its observed calls reach. */
export function hostReachLine(entry: string, reach: LiveHostReach, projectId: string, projectRoot: string): string {
  if (reach.kind === 'none') {
    return (
      `${entry}: no host is reachable, so this process's calls are not shown in the chip or Studio. ` +
      `Start one in ${projectRoot} with ${START_HOST}.`
    );
  }
  if (reach.kind === 'sandbox') {
    return (
      `${entry}: the host at ${reach.url} is a sandbox host, not a live one, so it does not show this process's calls. ` +
      `Stop it, then start one with ${START_HOST}.`
    );
  }
  const isOtherProject = reach.projectId !== projectId;
  if (isOtherProject) {
    return (
      `${entry}: the live host at ${reach.url} is for the Firebase project ${reach.projectId}, and this process talks to ${projectId}. ` +
      'Start the host and this process from the same project.'
    );
  }
  return `${entry}: reporting calls to the live host at ${reach.url}.`;
}
