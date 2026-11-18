/**
 * The rtdb-climb probes' calls to `/.settings/rules.json`. Each one waits out
 * a 429 with back-off (`fetchWithRateLimitRetry`), tracks in-flight PUTs on
 * `ctx.rulesSession`, and registers a shared-promise baseline restore cleanup
 * on `ctx.rulesSession` until the probe restores its initial snapshot.
 */
import { ORACLE_RESTORE_ATTEMPTS } from '../../oracle-signal-restore.ts';
import { fetchWithRateLimitRetry, rateLimitDeps } from '../../rtdb-rules-rate-limit.ts';
import { stable } from './probe-runtime.ts';
import type { RtdbClimbContext } from './probe-types.ts';

export interface ClimbRulesEndpoint {
  /** The whole rules document; throws on a non-OK answer. */
  read(): Promise<Record<string, unknown>>;
  /** Replaces the rules document and returns the answer for the caller to judge. */
  put(document: Record<string, unknown>): Promise<Response>;
  /** Replaces the rules document; throws on a non-OK answer. */
  write(document: Record<string, unknown>): Promise<void>;
}

/** The rules endpoint for `ctx`'s database. `label` starts every log line and error. */
export function climbRulesEndpoint(ctx: RtdbClimbContext, label: string): ClimbRulesEndpoint {
  const rulesUrl = `${ctx.config.databaseURL}/.settings/rules.json?access_token=${encodeURIComponent(ctx.rtdbAdminToken)}`;
  const options = { deps: rateLimitDeps(ctx.rulesRateLimitDeps ?? {}), logPrefix: '[rtdb-climb]' };
  const session = ctx.rulesSession ?? null;

  let baselineDoc: Record<string, unknown> | null = null;
  let baselineStable: string | null = null;
  let dirty = false;
  let unregister: (() => void) | null = null;
  let restorePromise: Promise<Response> | null = null;

  const track = <T>(promise: Promise<T>): Promise<T> => {
    if (session) {
      return session.trackMutation(promise);
    }
    return promise;
  };

  const sendPut = (document: Record<string, unknown>): Promise<Response> =>
    track(
      fetchWithRateLimitRetry(
        `${rulesUrl}&print=silent`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(document),
        },
        `${label} rules write`,
        options,
      ),
    );

  const restoreBaselineOnce = async (): Promise<Response> => {
    if (!dirty || baselineDoc === null) {
      return new Response(null, { status: 204 });
    }
    if (restorePromise !== null) {
      return restorePromise;
    }
    const targetDoc = baselineDoc;
    restorePromise = (async () => {
      try {
        const res = await sendPut(targetDoc);
        if (res.ok) {
          dirty = false;
        }
        return res;
      } finally {
        if (!dirty && unregister !== null) {
          unregister();
          unregister = null;
        }
        restorePromise = null;
      }
    })();
    return restorePromise;
  };

  const read = async (): Promise<Record<string, unknown>> => {
    const response = await fetchWithRateLimitRetry(rulesUrl, undefined, `${label} rules read`, options);
    if (!response.ok) throw new Error(`${label} rules read failed: ${response.status}`);
    const parsed = (await response.json()) as Record<string, unknown>;
    if (baselineDoc === null) {
      baselineDoc = parsed;
      baselineStable = stable(parsed);
    }
    return parsed;
  };

  const put = async (document: Record<string, unknown>): Promise<Response> => {
    if (baselineStable !== null && stable(document) === baselineStable && dirty) {
      return restoreBaselineOnce();
    }
    if (session && unregister === null && baselineDoc !== null) {
      unregister = session.registerProbeCleanup(async () => {
        for (let attempt = 1; attempt <= ORACLE_RESTORE_ATTEMPTS; attempt += 1) {
          const isLast = attempt === ORACLE_RESTORE_ATTEMPTS;
          const res = await restoreBaselineOnce();
          if (!res.ok) {
            dirty = true;
            if (isLast) {
              throw new Error(`${label} rules interrupt restore failed: ${res.status}`);
            }
            continue;
          }
          const verifyRes = await fetchWithRateLimitRetry(
            rulesUrl,
            undefined,
            `${label} rules read`,
            options,
          );
          if (verifyRes.ok) {
            const afterDoc = (await verifyRes.json()) as Record<string, unknown>;
            if (stable(afterDoc) === baselineStable) {
              return;
            }
          }
          dirty = true;
          if (isLast) {
            throw new Error(`${label} rules interrupt read-back did not match prior rules`);
          }
        }
      });
    }
    dirty = true;
    return sendPut(document);
  };

  const write = async (document: Record<string, unknown>): Promise<void> => {
    const response = await put(document);
    if (!response.ok) throw new Error(`${label} rules write failed: ${response.status}`);
  };

  return { read, put, write };
}
