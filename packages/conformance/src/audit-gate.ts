#!/usr/bin/env bun
/**
 * CI gate over packages/conformance/src/audit.ts.
 *
 * The audit produces a ranked worklist of COMPAT rows that claim ✓
 * conformance but have no oracle observation, local test evidence, or
 * explicit exception in the compatibility ledger.
 *
 * This gate is a RATCHET, not a cliff. It tolerates the existing debt
 * recorded in `audit-baseline.json` but FAILS the build if a PR
 * introduces a NEW high-risk unverified ✓ row (a fresh ✓ claim, or a
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
const BASELINE_PATH = join(HERE, '..', 'baselines', 'audit-baseline.json');
const AUDIT_PATH = join(HERE, 'audit.ts');

interface Candidate { id?: string; matrix: string; number: number; behavior?: string }
interface AuditJson { summary: Record<string, number>; candidates: Candidate[] }

function runAudit(): AuditJson {
  // Invoke the audit in --json mode in a child bun so a crash there
  // surfaces as a gate failure rather than a silent import error.
  const out = execFileSync('bun', ['run', AUDIT_PATH, '--json'], { encoding: 'utf8' });
  return JSON.parse(out) as AuditJson;
}

const idOf = (c: Candidate) => c.id ?? `${c.matrix}#${c.number}`;

const audit = runAudit();
const current = audit.candidates.map(idOf).sort();

if (process.argv.includes('--update')) {
  const baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));
  baseline.ids = current;
  writeFileSync(BASELINE_PATH, JSON.stringify(baseline, null, 2) + '\n');
  console.log(`Baseline updated: ${current.length} tolerated row(s).`);
  process.exit(0);
}

const baseline: string[] = JSON.parse(readFileSync(BASELINE_PATH, 'utf8')).ids;
const baselineSet = new Set(baseline);
const introduced = current.filter((id) => !baselineSet.has(id));
const resolved = baseline.filter((id) => !current.includes(id));

console.log(`# Oracle audit gate`);
console.log(`Current high-risk unverified ✓ rows: ${current.length} (baseline tolerates ${baseline.length}).`);
if (resolved.length > 0) {
  console.log(`\n${resolved.length} baseline row(s) no longer flagged — once an oracle locks them, drop from audit-baseline.json:`);
  for (const id of resolved) console.log(`  - ${id}`);
}

if (introduced.length > 0) {
  console.error(`\n✗ ${introduced.length} NEW uncited ✓ row(s) not in the baseline:`);
  for (const id of introduced) {
    const c = audit.candidates.find((x) => idOf(x) === id);
    console.error(`  - ${id}${c ? ` — ${c.behavior?.slice(0, 100) ?? ''}` : ''}`);
  }
  console.error(`\nEvery high-risk ✓ row must have oracle/test evidence or an explicit exception.`);
  console.error(`Add evidence, classify the exception, or honestly downgrade its status. Do not add to the baseline.`);
  process.exit(1);
}

console.log(`\n✓ No new uncited ✓ rows. Gate clean.`);
process.exit(0);
