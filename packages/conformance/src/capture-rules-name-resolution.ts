#!/usr/bin/env bun
/**
 * Capture how production's Firestore Rules compiler resolves function and
 * variable names: which scopes a call or an identifier reaches, and which
 * unresolved names or unused functions it reports.
 *
 * Every probe submits one ruleset to the Rules Test API (`projects.test`),
 * which compiles and evaluates it without deploying it. The capture records,
 * per probe, whether the ruleset compiled, the verbatim issues with severity
 * and position, and the decision for a get by uid a (granted when the ruleset
 * works) and by uid b (denied).
 *
 * Output: packages/pyric/test/rules/grammar/fixtures/name-resolution/captures.json
 *
 * Credentials: the same contract as `capture-rules-compile-limits.ts`.
 *
 * Usage:
 *   PARITY_PROJECT_ID=<project> bun run packages/conformance/src/capture-rules-name-resolution.ts
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from './rules-expression-cost-suites.ts';
import { tools, type Issue, type ProbeCase } from './capture-rules-compile-limits.ts';

const OUT_DIR = join(REPO_ROOT, 'packages', 'pyric', 'test', 'rules', 'grammar', 'fixtures', 'name-resolution');
const OUT = join(OUT_DIR, 'captures.json');

const LEAF = "request.auth.uid == 'a'";

/** A ruleset with optional global and service functions around the document match body. */
function ruleset(block: string, opts: { global?: string; service?: string } = {}): string {
  return `rules_version = '2';\n${opts.global ? `${opts.global}\n` : ''}service cloud.firestore {\n${opts.service ? `${opts.service}\n` : ''}  match /databases/{database}/documents {\n${block}\n  }\n}\n`;
}

/** Each probe: a name and the ruleset source. Every case reads p/d1. */
export const PROBES: Record<string, string> = {
  'undefined-call-in-function-body': ruleset(
    `    match /p/{d} {\n      function f() { return ${LEAF} || notDeclared(); }\n      allow read: if f();\n    }`,
  ),
  'sibling-match-function': ruleset(
    `    match /q/{e} {\n      function s() { return ${LEAF}; }\n      allow read: if s();\n    }\n    match /p/{d} {\n      allow read: if s();\n    }`,
  ),
  'service-function-calls-match-function': ruleset(
    `    function inner() { return ${LEAF}; }\n    match /p/{d} {\n      allow read: if outer();\n    }`,
    { service: `  function outer() { return inner(); }` },
  ),
  'global-function-calls-service-function': ruleset(
    `    match /p/{d} {\n      allow read: if g();\n    }`,
    { global: `function g() { return s(); }`, service: `  function s() { return ${LEAF}; }` },
  ),
  'unbound-variable-in-rule': ruleset(
    `    match /p/{d} {\n      allow read: if ${LEAF} && x.a1 == 'R';\n    }`,
  ),
  'unbound-variable-in-function': ruleset(
    `    match /p/{d} {\n      function f() { return ${LEAF} && x == 1; }\n      allow read: if f();\n    }`,
  ),
  'service-function-reads-capture': ruleset(
    `    match /p/{d} {\n      allow read: if f();\n    }`,
    { service: `  function f() { return ${LEAF} && database != ''; }` },
  ),
  'parent-function-reads-child-capture': ruleset(
    `    function f() { return ${LEAF} && d != ''; }\n    match /p/{d} {\n      allow read: if f();\n    }`,
  ),
  'function-reads-enclosing-captures': ruleset(
    `    function g() { return database != ''; }\n    match /p/{d} {\n      function f() { return ${LEAF} && d != '' && g(); }\n      allow read: if f();\n    }`,
  ),
  'let-and-parameter-resolve': ruleset(
    `    match /p/{d} {\n      function f(u) { let v = u; let w = v; return w == 'a'; }\n      allow read: if f(request.auth.uid);\n    }`,
  ),
  // Each global call sits under `|| true`, so its value does not decide the
  // verdict; the probe observes only name resolution.
  'globals-resolve': ruleset(
    `    match /p/{d} {\n      allow read: if ${LEAF} && (math.abs(-1) == 1 || true) && (timestamp.value(0) < request.time || true) && (duration.value(1, 's') > duration.value(0, 's') || true) && (latlng.value(0, 0) != null || true) && (hashing.sha256('a') != null || true) && (int('1') == 1 || true) && (string(1) == '1' || true) && (float(1) == 1.0 || true) && (path('/a/b') != null || true) && (existsAfter(/databases/$(database)/documents/p/$(d)) || true) && (resource == null || true);\n    }`,
  ),
  'unused-functions-every-scope': ruleset(
    `    function r0() { return true; }\n    match /p/{d} {\n      function m0() { return true; }\n      function m1() { return s1(); }\n      allow read: if m1();\n    }`,
    {
      global: `function g0() { return true; }`,
      service: `  function s0() { return s2(); }\n  function s1() { return ${LEAF}; }\n  function s2() { return true; }`,
    },
  ),
};

interface NameProbeRecord { name: string; source: string; compiles: boolean; issues: Issue[]; cases: { description: string; decision: 'ALLOW' | 'DENY'; notes: string[] }[] }

async function main(): Promise<void> {
  const { run, projectId } = await tools();
  const cases: ProbeCase[] = [
    { description: 'uid a', uid: 'a', path: 'p' },
    { description: 'uid b', uid: 'b', path: 'p' },
  ];
  const probes: NameProbeRecord[] = [];
  for (const [name, source] of Object.entries(PROBES)) {
    const res = await run('firestore', source, cases);
    const rec: NameProbeRecord = {
      name, source, compiles: res.compiles, issues: res.issues,
      cases: res.results.map((r, i) => ({ description: cases[i]!.description, ...r })),
    };
    probes.push(rec);
    console.log(`  ${name.padEnd(40)} ${rec.compiles ? 'compiles' : 'REJECTED'} ${rec.cases.map((c) => `${c.description}=${c.decision}`).join(', ')} ${rec.issues.map((i) => `${i.severity}@${i.line ?? '?'}:${i.column ?? '?'} ${i.description}`).join('; ')}`);
  }
  mkdirSync(OUT_DIR, { recursive: true });
  const fixture = {
    schema: 'pyric.rules-name-resolution.v1',
    capturedAt: new Date().toISOString(),
    projectId,
    method: 'Rules Test API projects.test, one ruleset per probe from PROBES in packages/conformance/src/capture-rules-name-resolution.ts; each case is a get of p/d1 with uid a (granted when the ruleset works) and uid b (denied).',
    calls: probes.length,
    probes,
  };
  writeFileSync(OUT, JSON.stringify(fixture, null, 2) + '\n');
  console.log(`[name-resolution] ${probes.length} Rules Test API calls; wrote ${OUT}`);
}

if (import.meta.main) {
  await main();
}
