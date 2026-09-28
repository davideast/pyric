#!/usr/bin/env bun
/**
 * Replay a standard library module's test cases through the Rules Test API
 * and record what production decided for each.
 *
 * Firestore modules. Every case in the module's `*.test.json` becomes its own
 * block, wrapped the way the module tests wrap it: one
 * `allow <wrapOperation>: if <call>;` rule under `/c<n>/test/{docId}`, with
 * the case's request and documents at `c<n>/<path>`. A case's
 * `functionMocks` are sent as they are: a `get()` path in a call expression
 * names its own document, outside the `c<n>` prefix, so the mock path needs no
 * change. All blocks share one ruleset, so a module replays in one request.
 *
 * Storage modules (`storage/<name>`). A Storage rule can read the object's
 * name, so a case's path is sent unchanged rather than under a `c<n>` prefix.
 * Cases that share a match path and call expression share one ruleset with
 * one `allow <methods>: if <call>;` rule under the case's `wrapMatch`
 * (default `/test/{file}`), wrapped the way the Storage module tests wrap it,
 * and each ruleset is its own request. A case's `functionMocks` become
 * `firestore.get` and `firestore.exists` mocks.
 *
 * The case expectation is sent as the test expectation, so production's
 * `SUCCESS` means it agrees with the case and `FAILURE` means it decided the
 * other way.
 *
 * Output: packages/pyric/test/rules/modules/fixtures/stdlib-replay-<module>.json,
 * with `/` in the module name written as `-`.
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
import {
  buildApiTestCase,
  buildStorageApiTestCase,
  type StorageTestCase,
  type TestCase,
} from '../../pyric/src/rules/test/spec.ts';
import { REPO_ROOT } from './rules-expression-cost-suites.ts';
import { STDLIB_DIR, apiValue } from './measure-stdlib-cost.ts';

const DEFAULT_TIME = '2026-07-21T00:00:00Z';
const RULES_API = 'https://firebaserules.googleapis.com/v1';

const moduleName = process.argv[2];
if (!moduleName) {
  throw new Error('usage: replay-stdlib-cases.ts <module>');
}
const storage = moduleName.startsWith('storage/');
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

function resolveRules(serviceLines: string[]): string {
  const resolved = resolveModulesBrowser([
    "rules_version = '2+modules';",
    `import { ${exports.join(', ')} } from '${moduleName}';`,
    ...serviceLines,
    '',
  ].join('\n'));
  if (!resolved.success) throw new Error(`${moduleName}: ${resolved.error.code} ${resolved.error.message}`);
  return resolved.data.resolved.replace(/\n\/\/ @pyric-source-map:.*$/s, '\n');
}

/** One Rules Test API request: a ruleset and the module cases it tests. */
interface ReplayRequest {
  file: 'firestore.rules' | 'storage.rules';
  rules: string;
  indices: number[];
  testCases: unknown[];
}

function firestoreRequests(): ReplayRequest[] {
  const blocks = cases.map((c, n) => [
    `    match /c${n}${c.wrapMatch ?? '/test/{docId}'} {`,
    `      allow ${c.wrapOperation}: if ${call(c)};`,
    '    }',
  ].join('\n'));
  const rules = resolveRules([
    'service cloud.firestore {',
    '  match /databases/{database}/documents {',
    ...blocks,
    '  }',
    '}',
  ]);
  const testCases = cases.map((c, n) => {
    const time = c.requestTime ?? DEFAULT_TIME;
    const tc: TestCase = {
      description: c.description,
      expectation: c.expectation,
      method: c.method,
      path: `c${n}/${c.path}`,
      auth: c.auth ?? null,
      requestTime: time,
      // A REQUEST_TIME value is sent as the request time, as the cost probes send it.
      ...(c.data ? { data: apiValue(c.data, time) } : {}),
      ...(c.resource ? { resource: apiValue(c.resource, time) } : {}),
      ...(c.functionMocks ? { functionMocks: c.functionMocks } : {}),
    } as TestCase;
    const api: any = buildApiTestCase(tc);
    // Without the field production makes request.auth undefined, not null.
    if (tc.auth === null) api.request.auth = null;
    return api;
  });
  return [{ file: 'firestore.rules', rules, indices: cases.map((_, n) => n), testCases }];
}

function storageRequests(): ReplayRequest[] {
  const groups = new Map<string, number[]>();
  cases.forEach((c, n) => {
    const key = JSON.stringify([c.wrapMatch ?? '/test/{file}', call(c)]);
    groups.set(key, [...(groups.get(key) ?? []), n]);
  });
  return [...groups.entries()].map(([key, indices]) => {
    const [match, condition] = JSON.parse(key) as [string, string];
    const methods = [...new Set(indices.map((n) => cases[n]!.method as string))];
    const rules = resolveRules([
      'service firebase.storage {',
      '  match /b/{bucket}/o {',
      `    match ${match} {`,
      `      allow ${methods.join(', ')}: if ${condition};`,
      '    }',
      '  }',
      '}',
    ]);
    const testCases = indices.map((n) => {
      const c = cases[n]!;
      const tc: StorageTestCase = {
        description: c.description,
        expectation: c.expectation,
        method: c.method,
        path: c.path,
        auth: c.auth ?? null,
        requestTime: c.requestTime ?? DEFAULT_TIME,
        ...(c.resource ? { resource: c.resource } : {}),
        ...(c.existingResource ? { existingResource: c.existingResource } : {}),
        ...(c.functionMocks ? { functionMocks: c.functionMocks } : {}),
      };
      const api: any = buildStorageApiTestCase(tc);
      // Without the field production makes request.auth undefined, not null.
      if (tc.auth === null) api.request.auth = null;
      return api;
    });
    return { file: 'storage.rules', rules, indices, testCases };
  });
}

const { parityScope } = await import('../../pyric/test/rules/parity/harness.ts');
const scope = parityScope();
const states: { state?: string; debugMessages?: string[] }[] = new Array(cases.length);
for (const request of storage ? storageRequests() : firestoreRequests()) {
  const res = await fetch(`${RULES_API}/projects/${scope.projectId}:test`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${await scope.resolveToken()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      source: { files: [{ name: request.file, content: request.rules }] },
      testSuite: { testCases: request.testCases },
    }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Rules Test API ${res.status}: ${text.slice(0, 2000)}`);
  const body = JSON.parse(text) as { testResults?: { state?: string; debugMessages?: string[] }[]; issues?: unknown[] };
  const results = body.testResults ?? [];
  if (results.length !== request.indices.length) {
    throw new Error(`expected ${request.indices.length} results, got ${results.length}: ${JSON.stringify(body.issues ?? [])}`);
  }
  request.indices.forEach((n, k) => { states[n] = results[k]!; });
}

const rows = cases.map((c, n) => ({
  case: c.description,
  expectation: c.expectation,
  production: states[n]!.state === 'SUCCESS' ? c.expectation : c.expectation === 'ALLOW' ? 'DENY' : 'ALLOW',
  state: states[n]!.state,
}));
const disagreements = rows
  .map((row, n) => ({ ...row, notes: states[n]!.debugMessages ?? [] }))
  .filter((r) => r.state !== 'SUCCESS');
const out = join(
  REPO_ROOT, 'packages', 'pyric', 'test', 'rules', 'modules', 'fixtures',
  `stdlib-replay-${moduleName.replace(/\//g, '-')}.json`,
);
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
for (const d of disagreements) {
  console.log(`  ${d.case}: expected ${d.expectation}, production ${d.production}`);
  for (const note of d.notes) console.log(`    ${note}`);
}
if (disagreements.length > 0) process.exitCode = 1;
