/**
 * `pyric serve sessions`: the clients connected to a running bridge, and the
 * identity it holds for each of them.
 *
 * This is the only surface that prints the target ids. `pyric auth reset
 * --target <id>` acts on the live bridge, and the derived `pyric auth sessions`
 * answers about this project's headless sandbox instead, so without this
 * command nothing at a terminal names the id `--target` takes.
 *
 * It lives under the `serve` word rather than `auth` because what it lists is
 * a property of the served bridge, not of an auth pool: a client is connected
 * or it is not, whoever it is signed in as.
 */

import type { ParsedArgs } from './parse-args.js';
import { runBridgeCommand, type BridgeCommandDeps } from './bridge-tool-call.js';

/** One connected client, as the bridge's `auth_sessions` tool reports it. */
interface ListedSession {
  target: string;
  platform: string;
  deviceLabel?: string;
  identity: string;
}

/** The rows the bridge's answer carries, or none when it carried no sessions. */
function listedSessions(data: unknown): ListedSession[] {
  if (data === null || typeof data !== 'object') return [];
  const sessions = (data as { sessions?: unknown }).sessions;
  if (!Array.isArray(sessions)) return [];
  return sessions as ListedSession[];
}

/** One client's row: the id `--target` takes, where it runs, and who it acts as. */
function sessionRow(session: ListedSession): string {
  let platform = session.platform;
  if (session.deviceLabel !== undefined) platform = `${session.platform} (${session.deviceLabel})`;
  return `  ${session.target}  ${platform}  ${session.identity}\n`;
}

export async function runServeSessions(
  parsed: ParsedArgs,
  deps: BridgeCommandDeps = {},
): Promise<number> {
  return runBridgeCommand(
    'serve sessions',
    'auth_sessions',
    {},
    parsed,
    deps,
    (result, out) => {
      out.write(`${result.summary}\n`);
      for (const session of listedSessions(result.data)) out.write(sessionRow(session));
    },
  );
}
