/**
 * Deploy preflight: ensure the Google APIs a target needs are enabled on the
 * project BEFORE any mutation.
 *
 * Auto-enables the missing APIs when the caller has permission
 * (roles/serviceusage.serviceUsageAdmin or Owner); when it can't, prints the
 * per-API console link and fails fast so the user can enable manually and retry.
 *
 * Why a preflight, not login: API enablement is per-project, login is project-
 * agnostic, and an API can be disabled after login. This mirrors firebase-tools'
 * `ensureApiEnabled` at deploy time. See design rationale
 *
 * Pure fetch over Service Usage v1 (`services.get` to detect,
 * `services:batchEnable` + long-running-operation poll to enable). No `node:*`
 * imports — same host-agnostic shape as preflight.ts.
 */
import type { ProjectScope } from './scope.js';

const SERVICEUSAGE_API = 'https://serviceusage.googleapis.com/v1';

/** Bounded wait for a batchEnable long-running operation to finish. */
const ENABLE_TIMEOUT_MS = 120_000;
const POLL_INTERVAL_MS = 2_000;

interface Sink {
  write(s: string): void;
}

export interface EnsureApisResult {
  ok: boolean;
  /** Process exit code when `ok` is false: 1 = needs manual action (no
   *  permission), 2 = runtime/transport failure. */
  exit?: number;
}

export interface EnsureApisOptions {
  scope: ProjectScope;
  apis: readonly string[];
  out: Sink;
  err: Sink;
  /** Injectable for tests; default to global fetch / real timers / Date.now. */
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

interface Operation {
  name?: string;
  done?: boolean;
  error?: { message?: string };
}

/** Console deeplink that enables a single API on the project. */
function consoleEnableUrl(api: string, projectId: string): string {
  return `https://console.developers.google.com/apis/api/${api}/overview?project=${encodeURIComponent(projectId)}`;
}

/**
 * Current enablement of one service. `'unknown'` when the GET itself fails
 * (e.g. `serviceusage.services.get` denied) — treated as "attempt enable" so
 * batchEnable surfaces the real, actionable permission error.
 */
async function serviceState(
  fetchImpl: typeof fetch,
  token: string,
  projectId: string,
  api: string,
): Promise<'enabled' | 'disabled' | 'unknown'> {
  let res: Response;
  try {
    res = await fetchImpl(
      `${SERVICEUSAGE_API}/projects/${encodeURIComponent(projectId)}/services/${encodeURIComponent(api)}`,
      { headers: { authorization: `Bearer ${token}` } },
    );
  } catch {
    return 'unknown';
  }
  if (!res.ok) return 'unknown';
  const body = (await res.json().catch(() => ({}))) as { state?: string };
  return body.state === 'ENABLED' ? 'enabled' : 'disabled';
}

/**
 * Ensure every API in `apis` is enabled on the project. Returns `{ ok: true }`
 * when all are (already, or after a successful enable); `{ ok: false, exit }`
 * when enablement is needed but the caller lacks permission (console links
 * printed) or a transport/operation failure occurs.
 */
export async function ensureApisEnabled(opts: EnsureApisOptions): Promise<EnsureApisResult> {
  const { scope, apis, out, err } = opts;
  if (apis.length === 0) return { ok: true };
  const fetchImpl = opts.fetchImpl ?? fetch;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = opts.now ?? (() => Date.now());

  let token: string;
  try {
    token = await scope.resolveToken();
  } catch (e) {
    err.write(
      `pyric deploy: failed to resolve access token for API check: ${e instanceof Error ? e.message : String(e)}\n`,
    );
    return { ok: false, exit: 2 };
  }

  // Detect the missing ones. De-dupe so a union of overlapping target lists
  // doesn't probe the same API twice.
  const unique = [...new Set(apis)];
  const states = await Promise.all(
    unique.map((api) =>
      serviceState(fetchImpl, token, scope.projectId, api).then((s) => [api, s] as const),
    ),
  );
  const missing = states.filter(([, s]) => s !== 'enabled').map(([api]) => api);
  if (missing.length === 0) return { ok: true };

  const plural = missing.length > 1;
  out.write(
    `pyric deploy: enabling required Google API${plural ? 's' : ''} on '${scope.projectId}': ${missing.join(', ')}...\n`,
  );

  // batchEnable returns a long-running operation; we poll it to completion.
  let op: Operation;
  try {
    const res = await fetchImpl(
      `${SERVICEUSAGE_API}/projects/${encodeURIComponent(scope.projectId)}/services:batchEnable`,
      {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ serviceIds: missing }),
      },
    );
    if (res.status === 401 || res.status === 403) {
      // No permission to enable (lacks serviceUsageAdmin/Owner). The honest
      // dead-end: print the console links so the user can enable and re-run.
      err.write(
        `pyric deploy: can't enable the required API${plural ? 's' : ''} automatically — ` +
          `your account lacks roles/serviceusage.serviceUsageAdmin (or Owner) on '${scope.projectId}'. ` +
          `Enable ${plural ? 'them' : 'it'} in the console, then re-run:\n`,
      );
      for (const api of missing) err.write(`  ${api}\n    ${consoleEnableUrl(api, scope.projectId)}\n`);
      return { ok: false, exit: 1 };
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      err.write(`pyric deploy: failed to enable APIs (${res.status}): ${body}\n`);
      return { ok: false, exit: 2 };
    }
    op = (await res.json().catch(() => ({}))) as Operation;
  } catch (e) {
    err.write(`pyric deploy: API enable request failed: ${e instanceof Error ? e.message : String(e)}\n`);
    return { ok: false, exit: 2 };
  }

  // Poll the operation until done (bounded). Capture the name once — the LRO
  // GET echoes it, but we poll a fixed URL rather than trusting each response
  // to carry it. An already-done or name-less op skips the loop.
  const opName = op.name;
  if (op.done !== true && typeof opName === 'string') {
    const deadline = now() + ENABLE_TIMEOUT_MS;
    for (;;) {
      if (now() >= deadline) {
        err.write(
          `pyric deploy: timed out waiting for API enablement on '${scope.projectId}'. Re-run to retry.\n`,
        );
        return { ok: false, exit: 2 };
      }
      await sleep(POLL_INTERVAL_MS);
      let res: Response;
      try {
        res = await fetchImpl(`${SERVICEUSAGE_API}/${opName}`, {
          headers: { authorization: `Bearer ${token}` },
        });
      } catch (e) {
        err.write(`pyric deploy: polling API enablement failed: ${e instanceof Error ? e.message : String(e)}\n`);
        return { ok: false, exit: 2 };
      }
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        err.write(`pyric deploy: failed polling API enablement (${res.status}): ${body}\n`);
        return { ok: false, exit: 2 };
      }
      op = (await res.json().catch(() => ({}))) as Operation;
      if (op.done === true) break;
    }
  }
  if (op.error) {
    err.write(`pyric deploy: API enablement failed: ${op.error.message ?? 'unknown error'}\n`);
    return { ok: false, exit: 2 };
  }

  out.write(`pyric deploy: enabled ${missing.join(', ')}.\n`);
  return { ok: true };
}
