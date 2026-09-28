/**
 * Drift checks for the standard library's measured costs.
 *
 * Every exported function carries a production-measured cost in three
 * places: its module test file's `costs` record, the cost line in the comment
 * above it, and its catalog entry in `stdlib-modules.ts`. The records come
 * from `packages/conformance/src/measure-stdlib-cost.ts`, whose last run is
 * `fixtures/stdlib-cost-capture.json`. These tests fail when any of the three
 * disagree, when a record no longer matches the capture, and when the
 * linter's static estimate of a function moves away from its record, which is
 * what an edit that changes a function's cost without a new measurement does.
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { FunctionDef } from '../../../src/rules/grammar/FirestoreAST.js';
import { parseToAST } from '../../../src/rules/grammar/FirestoreParser.js';
import { countDocumentAccessCalls } from '../../../src/rules/grammar/document-access-count.js';
import { estimateExpressionCosts } from '../../../src/rules/linter/expression-cost.js';
import { resolveModulesBrowser } from '../../../src/rules/modules/resolver-browser.js';
import {
  PER_CALL_NOTE,
  applyCostLines,
  costDrift,
  formatCostLine,
  parseStdlibTestFile,
  type StdlibCostRecord,
} from '../../../src/rules/modules/stdlib-cost.js';
import { findModuleByKey } from '../../../src/rules/stdlib-modules.js';

const STDLIB_DIR = join(import.meta.dir, '..', '..', '..', 'src', 'rules', 'modules', 'stdlib');
const CAPTURE = JSON.parse(readFileSync(join(import.meta.dir, 'fixtures', 'stdlib-cost-capture.json'), 'utf8')) as {
  functions: { module: string; function: string; cost: { min: number; max: number }; reads: number }[];
};

/**
 * Upper limit on estimate / measured max. The estimator is an upper bound and
 * matches production exactly on most functions; the largest ratio in the
 * capture is 1.1 (11 against 10), from `duration.value(...)`, where the
 * estimator counts the namespace identifier and production does not. Any
 * other edit that makes a function more expensive than 10 percent over its
 * record fails here until it is measured again.
 */
const ESTIMATE_MULTIPLE = 1.1;

interface ModuleFile {
  name: string;
  service: 'firestore' | 'storage';
  source: string;
  costs: StdlibCostRecord[];
}

const modules: ModuleFile[] = [
  ...readdirSync(STDLIB_DIR).filter((f) => f.endsWith('.rules')).map((f) => ({ file: f, name: f.replace(/\.rules$/, ''), dir: STDLIB_DIR, service: 'firestore' as const })),
  ...readdirSync(join(STDLIB_DIR, 'storage')).filter((f) => f.endsWith('.rules')).map((f) => ({ file: f, name: `storage/${f.replace(/\.rules$/, '')}`, dir: join(STDLIB_DIR, 'storage'), service: 'storage' as const })),
].sort((a, b) => a.name.localeCompare(b.name)).map(({ file, name, dir, service }) => ({
  name,
  service,
  source: readFileSync(join(dir, file), 'utf8'),
  costs: parseStdlibTestFile(readFileSync(join(dir, file.replace(/\.rules$/, '.test.json')), 'utf8'), file).costs,
}));

function serviceBlock(service: ModuleFile['service'], body: string): string {
  return service === 'storage'
    ? `service firebase.storage {\n  match /b/{bucket}/o {\n${body}\n  }\n}`
    : `service cloud.firestore {\n  match /databases/{database}/documents {\n${body}\n  }\n}`;
}

function resolvedFunctions(mod: ModuleFile): Map<string, FunctionDef> {
  const names = mod.costs.map((c) => c.function);
  const resolved = resolveModulesBrowser(`rules_version = '2+modules';\nimport { ${names.join(', ')} } from '${mod.name}';\n${serviceBlock(mod.service, '')}\n`);
  if (!resolved.success) throw new Error(`${mod.name}: ${resolved.error.message}`);
  const ast = parseToAST(resolved.data.resolved)!;
  return new Map([...(ast.functions ?? []), ...(ast.service.functions ?? [])].map((fn) => [fn.name, fn]));
}

/** The estimator's cost of one call, from the function wrapped in a single rule. */
function estimatePerCall(mod: ModuleFile, fn: string, arity: number): number {
  const args = Array.from({ length: arity }, (_, i) => `a${i}`);
  const source = `rules_version = '2+modules';\nimport { ${fn} } from '${mod.name}';\n${serviceBlock(mod.service, `    match /test/{docId} {\n      allow get: if ${fn}(${args.join(', ')});\n    }`)}\n`;
  const resolved = resolveModulesBrowser(source);
  if (!resolved.success) throw new Error(`${mod.name}.${fn}: ${resolved.error.message}`);
  const estimates = estimateExpressionCosts(parseToAST(resolved.data.resolved)!);
  const grant = estimates.rules[0]!.grantCost ?? 0;
  const deny = estimates.blocks.find((b) => b.method === 'get')!.denyCost;
  // Each argument is one identifier, one expression, paid by the caller.
  return Math.max(grant, deny) - arity;
}

describe('costDrift', () => {
  const source = [
    '// @pyric-services cloud.firestore',
    ...PER_CALL_NOTE.match(/.{1,70}(\s|$)/g)!.map((l) => `// ${l.trim()}`),
    '',
    '// Signed in.',
    '// cost 5 to 5 expressions per call',
    'export function signedIn() {',
    '  return request.auth != null;',
    '}',
  ].join('\n');
  const right: StdlibCostRecord[] = [{ function: 'signedIn', cost: { min: 5, max: 5 }, reads: 0 }];

  it('passes when the comment and the record agree', () => {
    expect(costDrift('m', source, right)).toEqual([]);
  });

  it('fails a record whose range differs from the comment', () => {
    const wrong = [{ function: 'signedIn', cost: { min: 5, max: 6 }, reads: 0 }];
    expect(costDrift('m', source, wrong)).toEqual([
      'm.signedIn: comment says "// cost 5 to 5 expressions per call" but the record says "// cost 5 to 6 expressions per call"',
    ]);
  });

  it('fails a record with reads the comment does not state', () => {
    expect(costDrift('m', source, [{ ...right[0]!, reads: 1 }])).toHaveLength(1);
  });

  it('fails a missing record, a missing cost line and a missing per-call note', () => {
    expect(costDrift('m', source, [])[0]).toContain('do not list the exports [signedIn]');
    expect(costDrift('m', source.replace('// cost 5 to 5 expressions per call\n', ''), right)[0]).toContain('comment lacks');
    expect(costDrift('m', source.replace(/Calls are not memoized/, 'Calls are memoized'), right)[0]).toContain('per-call note');
  });

  it('writes cost lines the check accepts', () => {
    const bare = 'export function f() {\n  return true;\n}\n';
    const records = [{ function: 'f', cost: { min: 2, max: 3 }, reads: 1 }];
    const written = applyCostLines(bare, records);
    expect(written).toContain(formatCostLine(records[0]!));
    expect(written).toContain('// cost 2 to 3 expressions per call, reads 1');
    expect(costDrift('m', written, records)).toEqual([]);
  });
});

describe('stdlib cost records', () => {
  it('covers every module', () => {
    expect(modules.length).toBe(20);
  });

  for (const mod of modules) {
    describe(mod.name, () => {
      it('the comments above its functions state the recorded costs', () => {
        expect(costDrift(mod.name, mod.source, mod.costs)).toEqual([]);
      });

      it('its records are the last measurement', () => {
        const measured = CAPTURE.functions
          .filter((f) => f.module === mod.name)
          .map(({ function: fn, cost, reads }) => ({ function: fn, cost, reads }));
        expect(mod.costs).toEqual(measured);
      });

      it('its catalog entries carry the recorded costs', () => {
        const entry = findModuleByKey(mod.name)!;
        expect(entry.entries.map((e) => ({
          function: e.signature.slice(0, e.signature.indexOf('(')),
          cost: e.cost,
          reads: e.reads,
        }))).toEqual(mod.costs);
      });

      it('its read counts are the get() and exists() calls each function can make', () => {
        const fns = resolvedFunctions(mod);
        for (const record of mod.costs) {
          const fn = fns.get(record.function)!;
          const reads = [fn.body, ...fn.lets.map((l) => l.value)]
            .reduce((n, e) => n + countDocumentAccessCalls(e, fns), 0);
          expect(reads, `${mod.name}.${record.function}`).toBe(record.reads);
        }
      });

      it(`the estimator's per-call estimate is at or above the measured max and at most ${ESTIMATE_MULTIPLE} times it`, () => {
        const fns = resolvedFunctions(mod);
        for (const record of mod.costs) {
          const estimate = estimatePerCall(mod, record.function, fns.get(record.function)!.parameters.length);
          const label = `${mod.name}.${record.function}: estimate ${estimate}, measured max ${record.cost.max}`;
          expect(estimate, label).toBeGreaterThanOrEqual(record.cost.max);
          expect(estimate, label).toBeLessThanOrEqual(ESTIMATE_MULTIPLE * record.cost.max);
        }
      });
    });
  }
});
