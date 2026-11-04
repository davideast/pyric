/**
 * Which host a live Node process's observed calls reach, found at start the
 * way the observed-call sender finds it (`resolveRemoteHost`:
 * `PYRIC_SANDBOX=remote:<url>`, else the host `.pyric/serve.json` names),
 * and whether that host is live, from its `/__pyric/health` report. The
 * register entry reads it to say so when no live host would show the
 * process's calls, instead of dropping them silently.
 */
import { parsePyricSandbox, readLiveHostStatus } from 'pyric/sandbox/internal';
import { resolveRemoteHost } from '../remote/resolve-host.js';

export type LiveHostReach =
  /** A live host answers: its url and the project it names. */
  | { readonly kind: 'live'; readonly url: string; readonly projectId: string }
  /** A host answers, but a sandbox one: it would show the calls among sandbox traffic. */
  | { readonly kind: 'sandbox'; readonly url: string }
  /** No host answers for the project. */
  | { readonly kind: 'none' };

const HEALTH_TIMEOUT_MS = 2_000;

async function healthOf(base: string): Promise<unknown> {
  const response = await fetch(`${base.replace(/\/$/, '')}/__pyric/health`, { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) });
  if (!response.ok) return null;
  return response.json();
}

/** The host the process at `projectRoot` would report to, and whether it is live. */
export async function reachLiveHost(projectRoot: string, env: NodeJS.ProcessEnv = process.env): Promise<LiveHostReach> {
  try {
    const activation = parsePyricSandbox(env.PYRIC_SANDBOX);
    const configuredUrl = activation.mode === 'remote' ? activation.url : undefined;
    const host = await resolveRemoteHost({ cwd: projectRoot, configuredUrl, instanceId: env.PYRIC_SANDBOX_INSTANCE, warn: () => {} });
    const live = readLiveHostStatus(await healthOf(host.wsBase));
    if (live === null) return { kind: 'sandbox', url: host.serveUrl };
    return { kind: 'live', url: host.serveUrl, projectId: live.projectId };
  } catch {
    return { kind: 'none' };
  }
}
