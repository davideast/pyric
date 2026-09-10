/**
 * The result the identity methods return.
 *
 * `impersonate`, the two `actAs` methods, and `useAppSession` all report the
 * same thing: the identity every later call runs under. They differ in what
 * they set it to, so the reporting lives here once and each record names only
 * the mode it selects.
 *
 * `whoami` reports more, because there are two identities and confusing them
 * is the mistake this surface exists to prevent. It names the `agent`, which
 * is what the agent's own calls run under, and the `appSession`, which is the
 * user the sandbox's SDK is signed in as, and then says which of the two the
 * next call runs as. A sign-in moves the app session and leaves the agent
 * alone; only `useAppSession` copies one onto the other.
 */
import { describeAppSession, readAppSession } from './app-session.js';
import type { IdentityInput } from './identity.js';
import type { OperationResult, SurfaceContext } from './types.js';

/** One line naming the agent identity, in the words each method sets it with. */
export function describeAgentIdentity(held: IdentityInput): string {
  if (held.mode === 'admin') return 'admin, which bypasses rules';
  if (held.mode === 'anonymous') return 'anonymous';
  if (held.mode === 'app-session') return "the app's own session";
  const parts = [held.uid ?? ''];
  if (held.tenant !== undefined) parts.push(`tenant ${held.tenant}`);
  return parts.join(', ');
}

/** Report the held identity in the shape the identity methods return. */
function reported(held: { mode: string; uid?: string }): OperationResult {
  return {
    ok: true,
    summary: held.uid ? `Acting as ${held.uid}` : `Acting as ${held.mode}`,
    data: { identity: held },
  };
}

/** Set the identity every later call runs under, and report it. */
export function switchHeldIdentity(ctx: SurfaceContext, input: IdentityInput): OperationResult {
  return reported(ctx.identity.switchTo(input));
}

/**
 * Report both identities without changing either. `runsAs` is the agent
 * identity, said again in one phrase, because that is the question a caller
 * asks this method to answer.
 */
export function describeBothIdentities(ctx: SurfaceContext): OperationResult {
  const agent = ctx.identity.describe();
  const appSession = readAppSession(ctx.sandbox);
  const runsAs = describeAgentIdentity(agent);
  return {
    ok: true,
    summary:
      `The next call runs as ${runsAs}. ` +
      `The app session is ${describeAppSession(appSession)}. ` +
      'A sign-in moves the app session only; useAppSession adopts it as the agent identity.',
    data: { agent, appSession, runsAs },
  };
}
