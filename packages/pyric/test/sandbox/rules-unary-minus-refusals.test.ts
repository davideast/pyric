/**
 * Firestore refuses `--`, a minus applied to a minus, and a parenthesized
 * literal past int64 at compile (#1898).
 *
 * Production reads `--` written with no space as the decrement operator,
 * which rules do not support, and refuses `- -1` at the second minus. A
 * literal in parentheses is not negated by the minus before it, so
 * `-(9223372036854775808)` is an invalid number literal, while
 * `- 9223372036854775808` is the int64 minimum. Each probe below is a
 * production capture from the 2026-11-03 Firestore rules defect hunt, in
 * `test/rules/grammar/fixtures/unary-minus/captures.json`. `c5i` (`1 ++1`)
 * was already refused and stays refused.
 *
 * Each probe loads through `setRules` in the in-process sandbox. A source
 * production refuses is reported by `inspect()` with production's issue
 * and denies `getDoc`; one production compiles allows it.
 */
import 'fake-indexeddb/auto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import { inspect, setRules } from 'pyric/sandbox/firestore';
import { doc, getDoc, getFirestore } from '../../src/firestore/index.js';

interface Probe {
  name: string;
  source: string;
  compiles: boolean;
  issues?: string[];
  cases?: Array<{ description: string; method: string; path: string; decision: string }>;
}

const fixture = JSON.parse(
  readFileSync(new URL('../rules/grammar/fixtures/unary-minus/captures.json', import.meta.url), 'utf8'),
) as { probes: Probe[] };

/** Probes whose first production issue pyric reports verbatim. */
const reportsProductionIssue = new Set(['c5f-decrement-literal', 'c5h-minus-space-minus', 'k1-paren-min-literal', 'k3-double-negated-min']);

function pathOf(source: string): string {
  const match = /match \/(\w+)\/\{id\}/.exec(source);
  if (match === null) throw new Error('probe has no collection match');
  return `${match[1]}/1`;
}

async function load(source: string): Promise<{ rejection: string | undefined; read: string }> {
  const sandbox = initializeSandbox({});
  setRules(sandbox, source);
  const refusal = inspect(sandbox).rules.lint.findings.find((f) => f.rule === 'PARSE_ERROR' || f.rule === 'COMPILE_LIMIT');
  let read = 'ok';
  try {
    await getDoc(doc(getFirestore(sandbox.withAuth({ uid: 'u' })), pathOf(source)));
  } catch (err) {
    read = (err as { code?: string }).code ?? String(err);
  }
  return { rejection: refusal?.message, read };
}

describe('Firestore refuses the unary minus spellings production refuses', () => {
  for (const probe of fixture.probes.filter((p) => !p.compiles)) {
    it(`${probe.name}: refused with "${probe.issues?.[0]}"`, async () => {
      const { rejection, read } = await load(probe.source);
      expect(read).toBe('permission-denied');
      expect(rejection).toBeDefined();
      if (reportsProductionIssue.has(probe.name)) expect(rejection).toContain(probe.issues![0]!);
    });
  }

  for (const probe of fixture.probes.filter((p) => p.compiles)) {
    it(`${probe.name}: compiles and allows getDoc`, async () => {
      const { rejection, read } = await load(probe.source);
      expect(rejection).toBeUndefined();
      expect(probe.cases?.every((c) => c.decision === 'ALLOW')).toBe(true);
      expect(read).toBe('ok');
    });
  }
});
