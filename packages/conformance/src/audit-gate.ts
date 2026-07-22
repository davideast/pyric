#!/usr/bin/env bun
/**
 * CI gate over packages/conformance/src/audit.ts.
 *
 * The audit produces two ranked worklists of COMPAT rows whose claim
 * outruns their evidence:
 *   - high-risk unverified ✓ rows (no oracle observation, local test
 *     evidence, or explicit exception), and
 *   - evidence-tier gaps: unit-backed ✓ rows whose own risk taxonomy says
 *     the behavior is unobserved in production (or cited but not replayed).
 *
 * This gate is a RATCHET, not a cliff. It tolerates the existing debt
 * recorded in `audit-baseline.json` but FAILS the build if a PR
 * introduces a NEW row in either worklist (a fresh ✓ claim, or a
 * status flip to ✓, without accompanying evidence). That
 * keeps fidelity from silently eroding while letting tracks pay down
 * the backlog incrementally (remove an id from the baseline once its
 * row is oracle-locked or honestly downgraded).
 *
 * Usage:
 *   bun run packages/conformance/src/audit-gate.ts            # enforce (CI)
 *   bun run packages/conformance/src/audit-gate.ts --update   # rewrite baseline to current set
 *
 * Exit codes: 0 clean (subset of baseline), 1 NEW uncited ✓ row(s).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
export const BASELINE_PATH = join(HERE, '..', 'baselines', 'audit-baseline.json');
const AUDIT_PATH = join(HERE, 'audit.ts');

interface Candidate { id?: string; matrix: string; number: number; behavior?: string }
interface AuditJson { summary: Record<string, number>; candidates: Candidate[]; evidenceTierGaps?: Candidate[] }

function runAudit(): AuditJson {
  // Invoke the audit in --json mode in a child bun so a crash there
  // surfaces as a gate failure rather than a silent import error.
  const out = execFileSync('bun', ['run', AUDIT_PATH, '--json'], { encoding: 'utf8' });
  return JSON.parse(out) as AuditJson;
}

const idOf = (c: Candidate) => c.id ?? `${c.matrix}#${c.number}`;

/** The gated set: both worklists, deduped, in stable order. */
export function gatedIds(audit: AuditJson): string[] {
  return [...new Set([...audit.candidates, ...(audit.evidenceTierGaps ?? [])].map(idOf))].sort();
}

/**
 * The ratchet arithmetic: `introduced` (in the current worklists but not the
 * baseline) fails the gate; `resolved` (in the baseline but no longer
 * flagged) is reported so debt can be retired from the baseline.
 */
export function diffAgainstBaseline(current: string[], baseline: string[]): { introduced: string[]; resolved: string[] } {
  const baselineSet = new Set(baseline);
  const currentSet = new Set(current);
  return {
    introduced: current.filter((id) => !baselineSet.has(id)),
    resolved: baseline.filter((id) => !currentSet.has(id)),
  };
}

if (import.meta.main) {
  const audit = runAudit();
  const current = gatedIds(audit);

  if (process.argv.includes('--update')) {
    const baselineFile = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));
    baselineFile.ids = current;
    writeFileSync(BASELINE_PATH, JSON.stringify(baselineFile, null, 2) + '\n');
    console.log(`Baseline updated: ${current.length} tolerated row(s).`);
    process.exit(0);
  }

  const baseline: string[] = JSON.parse(readFileSync(BASELINE_PATH, 'utf8')).ids;
  const { introduced, resolved } = diffAgainstBaseline(current, baseline);

  console.log(`# Oracle audit gate`);
  console.log(`Current uncited ✓ rows: ${current.length} — ${audit.candidates.length} high-risk unverified, ${(audit.evidenceTierGaps ?? []).length} unit-backed evidence-tier gap(s) (baseline tolerates ${baseline.length}).`);
  if (resolved.length > 0) {
    console.log(`\n${resolved.length} baseline row(s) no longer flagged — once an oracle locks them, drop from audit-baseline.json:`);
    for (const id of resolved) console.log(`  - ${id}`);
  }

  if (introduced.length > 0) {
    console.error(`\n✗ ${introduced.length} NEW uncited ✓ row(s) not in the baseline:`);
    for (const id of introduced) {
      const c = [...audit.candidates, ...(audit.evidenceTierGaps ?? [])].find((x) => idOf(x) === id);
      console.error(`  - ${id}${c ? ` — ${c.behavior?.slice(0, 100) ?? ''}` : ''}`);
    }
    console.error(`\nEvery high-risk ✓ row must have oracle/test evidence or an explicit exception, and every`);
    console.error(`unit-backed ✓ row claiming unobserved behavior needs an observation before it flips.`);
    console.error(`Add evidence, classify the exception, or honestly downgrade its status. Do not add to the baseline.`);
    process.exit(1);
  }

  console.log(`\n✓ No new uncited ✓ rows. Gate clean.`);
  process.exit(0);
}
