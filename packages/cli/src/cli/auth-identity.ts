/**
 * `pyric auth reset`: the CLI view of pointing a connected client, or this
 * caller, at an identity.
 *
 * Impersonating an identity, reading whose calls run under it, and listing the
 * sessions a sandbox holds are `auth impersonate`, `auth whoami`, and
 * `auth sessions` on the service surface now
 * (`packages/cli/src/bridge/surface/methods/auth/`), which act on this
 * project's local `.pyric/state` and need no running bridge. Reset stays here
 * because retargeting a connected client is a concept a bridge alone has, so
 * it runs through `bridge-tool-call.ts` against the running bridge.
 *
 * `--target` names another connected client. Without it a command acts on
 * this caller's own bridge identity, which the bridge records but does not
 * yet stamp on forwarded tool calls. See `../auth/identity.ts` for the traced
 * behaviour, and {@link SELF_SCOPE_NOTE} for the sentence both surfaces print.
 */

import type { ParsedArgs } from './parse-args.js';
import {
  runBridgeCommand,
  type BridgeCommandDeps,
  type BridgeToolResult,
} from './bridge-tool-call.js';
import { SELF_SCOPE_NOTE, TARGET_SCOPE_NOTE, describeIdentity } from '../auth/identity.js';

/** Read a flag that must carry a string value, not a bare boolean. */
function stringFlag(parsed: ParsedArgs, key: string): string | null | undefined {
  const value = parsed.flags.get(key);
  if (value === undefined) return undefined;
  if (typeof value === 'string' && value.length > 0) return value;
  return null;
}

/** The `target` argument, or an error when `--target` was given without a value. */
function targetFromFlags(parsed: ParsedArgs): { target?: string } | { error: string } {
  const target = stringFlag(parsed, 'target');
  if (target === null) {
    return { error: '--target requires the target id of a connected client.' };
  }
  return target === undefined ? {} : { target };
}

/**
 * Print the summary, and the sentence that names whose calls actually change
 * when the bridge has not already said it. A current bridge puts the note in
 * the summary; an older answer, or a stubbed one, does not, and the CLI must
 * not be the surface that drops it.
 */
function withScopeNote(note: string) {
  return (result: BridgeToolResult, out: { write(s: string): void }) => {
    out.write(`${result.summary}\n`);
    if (!result.summary.includes(note)) out.write(`${note}\n`);
  };
}

export async function runAuthReset(
  parsed: ParsedArgs,
  deps: BridgeCommandDeps = {},
): Promise<number> {
  const err = deps.stderr ?? process.stderr;
  const scope = targetFromFlags(parsed);
  if ('error' in scope) {
    err.write(`pyric auth reset: ${scope.error}\n`);
    return 1;
  }
  return runBridgeCommand(
    'auth reset',
    'auth_reset',
    scope,
    parsed,
    deps,
    withScopeNote(scope.target === undefined ? SELF_SCOPE_NOTE : TARGET_SCOPE_NOTE),
  );
}

export { describeIdentity };
