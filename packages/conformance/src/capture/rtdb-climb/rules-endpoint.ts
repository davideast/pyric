/**
 * The rtdb-climb probes' calls to `/.settings/rules.json`. Each one waits out
 * a 429 with back-off (`fetchWithRateLimitRetry`), because the rules endpoint
 * throttles a project for minutes after a burst, and a probe that threw on a
 * 429 would leave its rules in place or record the 429 as a verdict.
 */
import { fetchWithRateLimitRetry, rateLimitDeps } from '../../rtdb-rules-rate-limit.ts';
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
  const put = (document: Record<string, unknown>) => fetchWithRateLimitRetry(`${rulesUrl}&print=silent`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(document),
  }, `${label} rules write`, options);
  return {
    async read() {
      const response = await fetchWithRateLimitRetry(rulesUrl, undefined, `${label} rules read`, options);
      if (!response.ok) throw new Error(`${label} rules read failed: ${response.status}`);
      return response.json() as Promise<Record<string, unknown>>;
    },
    put,
    async write(document) {
      const response = await put(document);
      if (!response.ok) throw new Error(`${label} rules write failed: ${response.status}`);
    },
  };
}
