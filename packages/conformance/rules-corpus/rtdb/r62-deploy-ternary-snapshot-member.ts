/**
 * ─── r62-deploy-ternary-snapshot-member ───────────────────────────────
 * A dry-run deploy probe (`PUT /.settings/rules.json?dryRun=true`) for the
 * expressions of r39-root-parent-runtime, each sent alone, so a ruleset that
 * production refuses names the one expression it refuses.
 *
 * Captured in observations/rtdb-rules/rules-rtdb-r62-deploy-ternary-snapshot-member.json:
 * production refuses only `(true ? data.parent() : null).exists()`.
 */
import type { RtdbDeployScenarioRecord } from './types.ts';

const construct = 'rtdb.method.snapshot.parent';

function readRule(description: string, read: string, expectation: RtdbDeployScenarioRecord['deployCases'][number]['expectation']) {
  return { description, construct, rules: JSON.stringify({ a: { '.read': read } }), expectation };
}

const ACCEPTED = { verdict: 'ACCEPTED' } as const;

export const scenario: RtdbDeployScenarioRecord = {
  fm: 'rtdb#71',
  rationale: 'production stopped deploying the r39 ruleset, so each of its expressions gets its own deploy verdict. Pyric still accepts the refused one.',
  provenance: 'Split from r39-root-parent-runtime after its deploy failed with "Invalid property access: target is not an object".',
  deployCases: [
    readRule('(true ? root.parent() : null) == null', '(true ? root.parent() : null) == null', ACCEPTED),
    readRule('(true ? root.parent() : null) != null || true', '(true ? root.parent() : null) != null || true', ACCEPTED),
    readRule('((true ? root.parent() : 1) == 1) || true', '((true ? root.parent() : 1) == 1) || true', ACCEPTED),
    readRule('(true ? root.parent() : 1) != 1', '(true ? root.parent() : 1) != 1', ACCEPTED),
    readRule("(true ? root.parent() : '').length == null || true", "(true ? root.parent() : '').length == null || true", ACCEPTED),
    readRule('root.parent().exists() || true', 'root.parent().exists() || true', ACCEPTED),
    readRule('(true ? data.parent() : null).exists()', '(true ? data.parent() : null).exists()', {
      verdict: 'REJECTED',
      error: 'Invalid property access: target is not an object.',
    }),
    readRule('data.parent().exists()', 'data.parent().exists()', ACCEPTED),
  ],
};
