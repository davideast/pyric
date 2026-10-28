import { repeatStable, scenarioPath, stable } from './probe-runtime.ts';
import type { RtdbClimbContext, RtdbClimbProbe } from './probe-types.ts';
import { RULES_DEPLOY_REFUSAL_CASES as CASES } from './rules-deploy-refusals.cases.ts';

/** Drop the `line:column:` prefix: the column counts from the start of the whole rules document. */
function refusalMessage(body: string): string {
  let text = body;
  try {
    const parsed = JSON.parse(body) as { error?: unknown };
    if (typeof parsed.error === 'string') text = parsed.error;
  } catch {
    // A non-JSON body is recorded as sent.
  }
  return text.trim().replace(/^\d+:\d+:\s*/, '');
}

export function createProbe(ctx: RtdbClimbContext): RtdbClimbProbe {
  return {
    name: 'rtdb-rules-deploy-refusals',
    matrixRow: 'rtdb#89',
    rowIds: ['rtdb#89'],
    description:
      'Deploys one rule expression at a time through the rules REST endpoint and records whether production accepts the ruleset or refuses it, with the refusal text: method argument count and types, regular expression literals and flags, `$wildcard` variables, and snapshot operands of comparison and arithmetic operators. The prior rules are restored and read back after every attempt.',
    observe: () => repeatStable(2, async (attempt) => {
      const path = scenarioPath(ctx, 'rules-deploy-refusals', attempt);
      const run = path.split('/')[1]!;
      const rulesUrl = `${ctx.config.databaseURL}/.settings/rules.json?access_token=${encodeURIComponent(ctx.rtdbAdminToken)}`;
      const readRules = async (): Promise<Record<string, unknown>> => {
        const response = await fetch(rulesUrl);
        if (!response.ok) throw new Error(`rules deploy refusal read failed: ${response.status}`);
        return response.json() as Promise<Record<string, unknown>>;
      };
      const putRules = (body: Record<string, unknown>) => fetch(`${rulesUrl}&print=silent`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const before = await readRules();
      const rootRules = before.rules && typeof before.rules === 'object'
        ? before.rules as Record<string, unknown>
        : {};
      const oracleRules = rootRules.pyric_oracle && typeof rootRules.pyric_oracle === 'object'
        ? rootRules.pyric_oracle as Record<string, unknown>
        : {};
      const withCase = (subtree: Record<string, unknown>) => ({
        ...before,
        rules: {
          ...rootRules,
          pyric_oracle: { ...oracleRules, [run]: { 'rtdb-climb': { 'rules-deploy-refusals': { [`attempt-${attempt}`]: { probe: subtree } } } } },
        },
      });

      const outcomes: Record<string, { accepted: boolean; status: number; message: string | null }> = {};
      try {
        for (const [label, subtree] of Object.entries(CASES)) {
          const response = await putRules(withCase(subtree));
          outcomes[label] = response.ok
            ? { accepted: true, status: response.status, message: null }
            : { accepted: false, status: response.status, message: refusalMessage(await response.text()) };
        }
      } finally {
        const restored = await putRules(before);
        if (!restored.ok) throw new Error(`rules deploy refusal restore failed: ${restored.status}`);
        const after = await readRules();
        if (stable(after) !== stable(before)) {
          throw new Error('rules deploy refusal restore did not read back the prior rules');
        }
      }
      return { outcomes };
    }),
  };
}
