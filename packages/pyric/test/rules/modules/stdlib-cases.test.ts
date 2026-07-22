/**
 * Stdlib semantic test runner — executes every `*.test.json` fixture
 * under `src/rules/modules/stdlib/` against the in-repo simulator.
 *
 * Until this file existed, the fixtures' `wrapFunction`/`wrapArgs`/
 * `wrapOperation`/`wrapMatch` fields were consumed by NOTHING in the
 * tree: the sibling `stdlib.test.ts` asserts resolved-text/AST shape
 * (that inlining works), not that the functions DECIDE correctly. The
 * manifest's "Verified: Unit tests" column was aspirational. This
 * runner closes that gap: every case is wrapped in a minimal ruleset,
 * resolved through the real `2+modules` resolver, and evaluated by
 * `SimulateFirestoreRulesHandler` — the same engine the playground
 * sandbox uses — asserting the expected ALLOW/DENY.
 *
 * Case shape (see docs/rules/reference/test-case-schema.md for the
 * base `TestCase` fields):
 *   - `wrapFunction`  — exported stdlib function under test (imported
 *     from the module the fixture file is named after).
 *   - `wrapCallExpr`  — full call expression for the `allow` condition
 *     (used verbatim; may reference builtins like `get()`).
 *   - `wrapArgs`      — else, argument identifiers: `fn(a, b)`. These
 *     must be bound by `wrapMatch` wildcards.
 *   - neither         — zero-arg call `fn()`.
 *   - `wrapMatch`     — match path (default `/test/{docId}`).
 *   - `wrapOperation` — the `allow` verb (create/update/read/...).
 *   - `"REQUEST_TIME"` string values in `data`/`resource` become the
 *     serverTimestamp sentinel, which the simulator resolves to
 *     `request.time` (how `isServerTimestamp` cases stay deterministic).
 *
 * UNSUPPORTED is a hard FAILURE here, deliberately: the stdlib is the
 * vocabulary we hand agents for the local verification loop, so every
 * stdlib function must stay inside the simulator's supported surface.
 * If a future module genuinely needs the live Rules Test API, give it
 * a v1 validation script and record it in the canonical stdlib reference — don't relax this.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveModules } from '../../../src/rules/modules/resolver.js';
import {
  SERVER_TIMESTAMP,
  SimulateFirestoreRulesHandler,
} from '../../../src/rules/simulator/handler.js';
import { Timestamp } from '../../../src/rules/simulator/wrappers/timestamp.js';
import type { TestCase } from '../../../src/rules/test/spec.js';

const STDLIB_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../src/rules/modules/stdlib',
);

interface WrapCase {
  description: string;
  expectation: 'ALLOW' | 'DENY';
  method: TestCase['method'];
  path: string;
  auth?: { uid: string; token?: Record<string, unknown> } | null;
  data?: Record<string, unknown>;
  resource?: Record<string, unknown>;
  functionMocks?: TestCase['functionMocks'];
  requestTime?: string;
  wrapFunction: string;
  wrapOperation: string;
  wrapCallExpr?: string;
  wrapArgs?: string[];
  wrapMatch?: string;
}

/**
 * Fixture-value sentinels, resolved recursively:
 *   - `"REQUEST_TIME"` string → serverTimestamp sentinel (the
 *     handler resolves it to `request.time`).
 *   - `{"__type": "timestamp", "iso": "..."}` → a real Timestamp
 *     wrapper instance. JSON has no Timestamp type, but the simulator
 *     evaluates wrapper INSTANCES in resource/data verbatim — this is
 *     how fixtures express stored Timestamp fields (needed by the
 *     `timing` module's cooldown cases).
 */
function bindSentinels(
  value: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!value) return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    if (v === 'REQUEST_TIME') out[k] = SERVER_TIMESTAMP;
    else if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      const o = v as Record<string, unknown>;
      if (o.__type === 'timestamp' && typeof o.iso === 'string') {
        out[k] = Timestamp.fromIsoString(o.iso);
      } else {
        out[k] = bindSentinels(o);
      }
    } else out[k] = v;
  }
  return out;
}

function wrapperSource(moduleName: string, c: WrapCase): string {
  const condition =
    c.wrapCallExpr ?? `${c.wrapFunction}(${(c.wrapArgs ?? []).join(', ')})`;
  const matchPath = c.wrapMatch ?? '/test/{docId}';
  return [
    `rules_version = '2+modules';`,
    `import { ${c.wrapFunction} } from '${moduleName}';`,
    `service cloud.firestore {`,
    `  match /databases/{database}/documents {`,
    `    match ${matchPath} {`,
    `      allow ${c.wrapOperation}: if ${condition};`,
    `    }`,
    `  }`,
    `}`,
  ].join('\n');
}

const fixtureFiles = readdirSync(STDLIB_DIR)
  .filter((f) => f.endsWith('.test.json'))
  .sort();

// The runner only means something if it actually finds the fixtures.
test('stdlib fixture discovery', () => {
  expect(fixtureFiles.length).toBeGreaterThanOrEqual(9);
});

const handler = new SimulateFirestoreRulesHandler();

for (const file of fixtureFiles) {
  const moduleName = file.replace(/\.test\.json$/, '');
  const cases = JSON.parse(
    readFileSync(join(STDLIB_DIR, file), 'utf8'),
  ) as WrapCase[];

  describe(`stdlib semantics: ${moduleName}`, () => {
    for (const c of cases) {
      test(c.description, () => {
        const source = wrapperSource(moduleName, c);
        const resolved = resolveModules(source);
        if (!resolved.success) {
          throw new Error(
            `resolveModules failed for '${c.wrapFunction}' (${moduleName}): ` +
              `${resolved.error.code} ${resolved.error.message}`,
          );
        }

        const tc: TestCase = {
          description: c.description,
          expectation: c.expectation,
          method: c.method,
          path: c.path,
          auth: c.auth ?? null,
          ...(c.data ? { data: bindSentinels(c.data) } : {}),
          ...(c.resource ? { resource: bindSentinels(c.resource) } : {}),
          ...(c.functionMocks ? { functionMocks: c.functionMocks } : {}),
          ...(c.requestTime ? { requestTime: c.requestTime } : {}),
        } as TestCase;

        const run = handler.simulate(resolved.data.resolved, [tc]);
        if (!run.success || !run.data || run.data.results.length !== 1) {
          throw new Error(
            `simulate failed: ${JSON.stringify(run.error ?? run).slice(0, 400)}`,
          );
        }
        const result = run.data.results[0]!;
        if (result.state === 'UNSUPPORTED') {
          throw new Error(
            `simulator abstained (UNSUPPORTED) on '${c.description}' — ` +
              `stdlib functions must stay inside the simulator's surface. ` +
              `Notes: ${result.notes.join(' | ')}`,
          );
        }
        if (result.state !== 'PASSED') {
          const trace = result.trace
            .map((t) => JSON.stringify(t))
            .join('\n  ');
          throw new Error(
            `expected ${c.expectation}, got ${result.decision}.\n` +
              `Notes: ${result.notes.join(' | ')}\n  ${trace}\nRules:\n${resolved.data.resolved}`,
          );
        }
        expect(result.state).toBe('PASSED');
      });
    }
  });
}
