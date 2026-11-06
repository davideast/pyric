/**
 * Which host a live Node process's observed calls reach, found at start the
 * way the observed-call sender finds it (`resolveRemoteHost`:
 * `PYRIC_SANDBOX=remote:<url>`, else the host `.pyric/serve.json` names),
 * and whether that host is live, from its `/__pyric/health` report. The
 * register entry reads it to say so when no live host would show the
 * process's calls, instead of dropping them silently. It also reads the
 * imports a live host passes through (`pyricLive({ passThrough })`), which
 * the process then passes through too.
 */
import { parsePyricSandbox, readLiveHostStatus, type LiveHostStatus } from 'pyric/sandbox/internal';
import { resolveRemoteHost } from '../remote/resolve-host.js';

export type LiveHostReach =
  /**
   * A live host answers: its url, the project it was started for, the
   * imports it passes through (its health report's `firebase/*` list, plus
   * `firebase-admin` when the report carries `admin`), and that `admin` field.
   */
  | {
      readonly kind: 'live';
      readonly url: string;
      readonly projectId: string;
      readonly passThrough: readonly string[];
      readonly admin?: LiveHostStatus['admin'];
    }
  /** A host answers, but a sandbox one: it would show the calls among sandbox traffic. */
  | { readonly kind: 'sandbox'; readonly url: string }
  /** No host answers for the project. */
  | { readonly kind: 'none' };

const HEALTH_TIMEOUT_MS = 2_000;
const ADMIN_SDK = 'firebase-admin';

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
    // The project the host was started for, which this process's own start resolves the same way.
    const admin = live.admin === undefined ? {} : { admin: live.admin };
    // The host reports firebase-admin as `admin`, not in `passThrough`; the process still passes it through.
    const adminImport = live.admin === undefined ? [] : [ADMIN_SDK];
    const passThrough = [...(live.passThrough ?? []), ...adminImport];
    return { kind: 'live', url: host.serveUrl, projectId: live.configProjectId, passThrough, ...admin };
  } catch {
    return { kind: 'none' };
  }
}
