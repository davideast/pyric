#!/usr/bin/env bun
/**
 * Replay a Firestore standard library module's test cases through the Rules
 * Test API and record what production decided for each.
 *
 * Every case in the module's `*.test.json` becomes its own block, wrapped the
 * way the module tests wrap it: one `allow <wrapOperation>: if <call>;` rule
 * under `/c<n>/test/{docId}`, with the case's request and documents at
 * `c<n>/<path>`. All blocks share one ruleset, so a module replays in one
 * request. The case expectation is sent as the test expectation, so
 * production's `SUCCESS` means it agrees with the case and `FAILURE` means it
 * decided the other way.
 *
 * Output: packages/pyric/test/rules/modules/fixtures/stdlib-replay-<module>.json
 *
 * Credentials: as in `measure-stdlib-cost.ts`. PARITY_SA_BASE64 or
 * PARITY_SA_PATH selects a service account; otherwise the firebase-tools
 * login is used with PARITY_PROJECT_ID (default digame-mas). The Rules Test
 * API evaluates the submitted ruleset without deploying it.
 *
 * Usage:
 *   bun run packages/conformance/src/replay-stdlib-cases.ts <module>
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveModulesBrowser } from '../../pyric/src/rules/modules/resolver-browser.ts';
import { parseStdlibTestFile } from '../../pyric/src/rules/modules/stdlib-cost.ts';
import { buildApiTestCase, type TestCase } from '../../pyric/src/rules/test/spec.ts';
import { REPO_ROOT } from './rules-expression-cost-suites.ts';
import { STDLIB_DIR } from './measure-stdlib-cost.ts';

const DEFAULT_TIME = '2026-07-21T00:00:00Z';
const RULES_API = 'https://firebaserules.googleapis.com/v1';

const moduleName = process.argv[2];
if (!moduleName || moduleName.startsWith('storage/')) {
  throw new Error('usage: replay-stdlib-cases.ts <firestore module>');
}
if (!process.env.PARITY_SA_BASE64 && process.env.PARITY_SA_PATH) {
  process.env.PARITY_SA_BASE64 = Buffer.from(readFileSync(process.env.PARITY_SA_PATH)).toString('base64');
}

const source = readFileSync(join(STDLIB_DIR, `${moduleName}.rules`), 'utf8');
const exports = [...source.matchAll(/^export function (\w+)\s*\(/gm)].map((m) => m[1]!);
const { cases } = parseStdlibTestFile<Record<string, any>>(
  readFileSync(join(STDLIB_DIR, `${moduleName}.test.json`), 'utf8'),
  `${moduleName}.test.json`,
);

const call = (c: Record<string, any>) => c.wrapCallExpr ?? `${c.wrapFunction}(${(c.wrapArgs ?? []).join(', ')})`;
const blocks = cases.map((c, n) => [
  `    match /c${n}${c.wrapMatch ?? '/test/{docId}'} {`,
  `      allow ${c.wrapOperation}: if ${call(c)};`,
  '    }',
].join('\n'));
const resolved = resolveModulesBrowser([
  "rules_version = '2+modules';",
  `import { ${exports.join(', ')} } from '${moduleName}';`,
  'service cloud.firestore {',
  '  match /databases/{database}/documents {',
  ...blocks,
  '  }',
  '}',
  '',
].join('\n'));
if (!resolved.success) throw new Error(`${moduleName}: ${resolved.error.code} ${resolved.error.message}`);
const rules = resolved.data.resolved.replace(/\n\/\/ @pyric-source-map:.*$/s, '\n');

const testCases = cases.map((c, n) => {
  const tc: TestCase = {
    description: c.description,
    expectation: c.expectation,
    method: c.method,
    path: `c${n}/${c.path}`,
    auth: c.auth ?? null,
    requestTime: c.requestTime ?? DEFAULT_TIME,
    ...(c.data ? { data: c.data } : {}),
    ...(c.resource ? { resource: c.resource } : {}),
  } as TestCase;
  const api: any = buildApiTestCase(tc);
  // Without the field production makes request.auth undefined, not null.
  if (tc.auth === null) api.request.auth = null;
  return api;
});

const { parityScope } = await import('../../pyric/test/rules/parity/harness.ts');
const scope = parityScope();
const res = await fetch(`${RULES_API}/projects/${scope.projectId}:test`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${await scope.resolveToken()}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    source: { files: [{ name: 'firestore.rules', content: rules }] },
    testSuite: { testCases },
  }),
});
const text = await res.text();
if (!res.ok) throw new Error(`Rules Test API ${res.status}: ${text.slice(0, 2000)}`);
const body = JSON.parse(text) as { testResults?: { state?: string; debugMessages?: string[] }[]; issues?: unknown[] };
const results = body.testResults ?? [];
if (results.length !== cases.length) {
  throw new Error(`expected ${cases.length} results, got ${results.length}: ${JSON.stringify(body.issues ?? [])}`);
}

const rows = cases.map((c, n) => ({
  case: c.description,
  expectation: c.expectation,
  production: results[n]!.state === 'SUCCESS' ? c.expectation : c.expectation === 'ALLOW' ? 'DENY' : 'ALLOW',
  state: results[n]!.state,
}));
const disagreements = rows.filter((r) => r.state !== 'SUCCESS');
const out = join(REPO_ROOT, 'packages', 'pyric', 'test', 'rules', 'modules', 'fixtures', `stdlib-replay-${moduleName}.json`);
writeFileSync(out, JSON.stringify({
  schema: 'pyric.stdlib-replay.v1',
  capturedAt: new Date().toISOString(),
  project: scope.projectId,
  module: moduleName,
  cases: rows.length,
  agree: rows.length - disagreements.length,
  results: rows,
}, null, 2) + '\n');
console.log(`[stdlib-replay] ${moduleName}: ${rows.length - disagreements.length}/${rows.length} cases agree with production; wrote ${out}`);
for (const d of disagreements) console.log(`  ${d.case}: expected ${d.expectation}, production ${d.production}`);
if (disagreements.length > 0) process.exitCode = 1;
