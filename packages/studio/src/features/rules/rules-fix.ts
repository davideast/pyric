/**
 * The AI rules-fix assist: propose an edited ruleset that allows a denied op,
 * VERIFIED on a throwaway fork (it reuses the same `rerunAgainstRules` engine the
 * manual "Test against an edited rule" uses). The model iterates via the
 * `test_rules_edit` tool until it allows the op with no regressions; the verified
 * ruleset is captured for one-click Apply.
 *
 * No playground tool is lifted: the verification rides the in-repo rerun engine.
 */

import { fork, discard, type SandboxSnapshot } from 'pyric/sandbox';
import type { ToolHandler, ToolResult } from '@inbrowser/agent';
import { rerunAgainstRules, issueOp } from '../rules-debug/rerun.js';
import type { Denial as ModelDenial } from '../rules-debug/model.js';

export const RULES_FIX_SYSTEM =
  'You are a Firebase Security Rules expert. A specific Firestore operation was ' +
  'DENIED. Propose the SMALLEST edit to the ruleset that ALLOWS this operation ' +
  'without over-granting (do not loosen rules beyond what this op needs). Use the ' +
  'test_rules_edit tool to verify each proposal: it reports whether your edited ' +
  'ruleset now allows the op and any regressions (previously-allowed ops your edit ' +
  'would now deny). Refine until it allows the op with ZERO regressions, then give ' +
  'the final complete ruleset in a code block and explain the change in one sentence.';

export interface RulesFixPromptInput {
  method: string;
  path: string;
  auth: { uid: string } | null;
  rulesSource: string;
  requestData?: unknown;
  resourceData?: unknown;
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

export function buildRulesFixPrompt(d: RulesFixPromptInput): string {
  const lines = [
    'A Firestore operation was DENIED by security rules. Propose a fix.',
    `Operation: ${d.method} ${d.path}`,
    `request.auth: ${d.auth ? `signed in as ${d.auth.uid}` : 'null (unauthenticated)'}`,
  ];
  if (d.requestData !== undefined) lines.push(`request.resource.data: ${safeJson(d.requestData)}`);
  if (d.resourceData !== undefined) lines.push(`existing document (resource.data): ${safeJson(d.resourceData)}`);
  lines.push(
    '',
    'Current firestore.rules:',
    '```',
    d.rulesSource,
    '```',
    '',
    'Propose the smallest edit that allows this op, verify it with test_rules_edit, and refine until it allows with no regressions.',
  );
  return lines.join('\n');
}

export interface TestRulesEditDeps {
  /** The denied op to make allow. */
  denial: ModelDenial;
  getSnapshot: () => Promise<SandboxSnapshot | null>;
  /** Recently-allowed ops to re-run for regressions (issueOp re-issues each). */
  recentOps: ModelDenial[];
  /** Called with a ruleset that allows the op with no regressions (for Apply). */
  onVerifiedFix: (rules: string) => void;
}

/** The `test_rules_edit` tool: verify a proposed ruleset on a fork. */
export function makeTestRulesEditTool(deps: TestRulesEditDeps): ToolHandler {
  return {
    name: 'test_rules_edit',
    description:
      'Test a proposed edited Firestore ruleset against the denied operation. ' +
      'Returns whether the edit now allows the op and any regressions (recently-' +
      'allowed ops the edit would now deny). Call with your COMPLETE proposed ' +
      'firestore.rules; refine until it allows the op with no regressions.',
    parameters: {
      type: 'object',
      properties: {
        rules: { type: 'string', description: 'The complete proposed firestore.rules source.' },
      },
      required: ['rules'],
    },
    async execute(args): Promise<ToolResult> {
      const rules = String((args as { rules?: unknown }).rules ?? '');
      if (!rules.trim()) return { ok: false, summary: 'No ruleset provided.' };
      const snap = await deps.getSnapshot();
      if (!snap) return { ok: false, summary: 'No sandbox snapshot to test against.' };

      // 1. Does the edited ruleset allow the denied op? (fork + re-issue, no mutation)
      const rerun = await rerunAgainstRules(snap, deps.denial, rules, snap);
      const allowsNow = rerun.result.outcome === 'allow';

      // 2. Regression: re-run a sample of recently-allowed ops under the edit.
      const regressions: string[] = [];
      for (const op of deps.recentOps.slice(0, 8)) {
        const branch = fork(snap, rules);
        try {
          const r = await issueOp(branch.sandbox, op);
          if (r.outcome === 'deny') regressions.push(`${op.method} ${op.path}`);
        } finally {
          discard(branch);
        }
      }

      const clean = allowsNow && regressions.length === 0;
      if (clean) deps.onVerifiedFix(rules);
      const summary = allowsNow
        ? regressions.length === 0
          ? 'Allows the op, no regressions.'
          : `Allows the op, but ${regressions.length} regression(s): ${regressions.join(', ')}`
        : 'This ruleset still denies the op.';
      return { ok: clean, summary, data: { allowsNow, regressions } };
    },
  };
}
