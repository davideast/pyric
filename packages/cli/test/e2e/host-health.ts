/**
 * How an e2e test reads a host process's health: with the session token the
 * host's pointer file (`.pyric/serve.json`) names, and never without one.
 *
 * A host that requires the token answers a request without it with a reduced
 * body: `sandboxConnected`, and no `live` report. The host connects its
 * sandbox a few milliseconds before it writes the pointer, so a poll that
 * falls back to a tokenless request can land in that gap and read the
 * reduced body as the host's health. These helpers make no request until the
 * pointer names a token.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export type Health = Record<string, unknown>;

/** What the wait reads of the process that runs the host. */
export interface HostProcess {
  child: { exitCode: number | null };
  output: () => string;
}

export interface HostWaitOptions {
  timeoutMs?: number;
  pollMs?: number;
}

/** The token the pointer file in `root` names, or undefined while the host has not written one. */
export function pointerToken(root: string): string | undefined {
  let text: string;
  try {
    text = readFileSync(join(root, '.pyric/serve.json'), 'utf8');
  } catch {
    return undefined;
  }
  let pointer: { token?: unknown };
  try {
    pointer = JSON.parse(text) as { token?: unknown };
  } catch {
    // The host is writing the file.
    return undefined;
  }
  if (typeof pointer.token === 'string' && pointer.token.length > 0) return pointer.token;
  return undefined;
}

/** The session header for a request to the host of `root`. Throws when the host has published no token. */
export function sessionHeaders(root: string): Record<string, string> {
  const token = pointerToken(root);
  if (token === undefined) throw new Error(`the host of ${root} has published no session token in .pyric/serve.json`);
  return { 'x-pyric-session-token': token };
}

/**
 * The host's health as it answers a request that carries the pointer's
 * token. Null while there is no pointer token, no answer, or an answer that
 * is not 200.
 */
export async function healthOf(url: string, root: string): Promise<Health | null> {
  const token = pointerToken(root);
  if (token === undefined) return null;
  try {
    const response = await fetch(`${url}/__pyric/health`, { headers: { 'x-pyric-session-token': token } });
    if (!response.ok) return null;
    return (await response.json()) as Health;
  } catch {
    return null;
  }
}

function describeLast(health: Health | null, root: string): string {
  if (health !== null) return `health ${JSON.stringify(health)}`;
  const hasToken = pointerToken(root) !== undefined;
  if (hasToken) return 'no health answer';
  return 'no session token in .pyric/serve.json';
}

/**
 * Waits until the host has published its pointer and its health, read with
 * the pointer's token, says the Node sandbox is connected. The host answers
 * health as soon as it listens, before `startHostedSandbox` connects the
 * sandbox, and a call in that window is refused with "sandbox not connected".
 */
export async function waitForHost(host: HostProcess, url: string, root: string, options: HostWaitOptions = {}): Promise<Health> {
  const timeoutMs = options.timeoutMs ?? 90_000;
  const pollMs = options.pollMs ?? 250;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const health = await healthOf(url, root);
    if (health?.sandboxConnected === true) return health;
    if (host.child.exitCode !== null) throw new Error(`the host exited:\n${host.output()}`);
    if (Date.now() > deadline) {
      throw new Error(`the host at ${url} did not connect its sandbox (last: ${describeLast(health, root)}):\n${host.output()}`);
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}
