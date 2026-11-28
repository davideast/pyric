import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from '../../src/cli/parse-args.js';
import {
  POLICY_EXIT_OK,
  POLICY_EXIT_PLACEMENT,
  POLICY_EXIT_PROOF,
  POLICY_EXIT_STATIC,
  runPolicy,
  type PolicyCliDeps,
  type PolicyProveReport,
} from '../../src/cli/policy/index.js';
import { loadPolicyExperimentalApi } from '../../src/cli/policy/loader.js';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pyric-policy-prove-'));
  tempDirs.push(dir);
  return dir;
}

async function runProve(argv: string[], extra: Partial<PolicyCliDeps> = {}) {
  let out = '';
  let err = '';
  const code = await runPolicy(parseArgs(['policy', 'prove', ...argv]), {
    stdout: { write(s: string) { out += s; } },
    stderr: { write(s: string) { err += s; } },
    ...extra,
  });
  return { code, out, err };
}

const ORDER_POLICY = `use extension derive;
use extension bounded;

transition checkout {
  derive {
    let itemTotal = bounded.fold(input.items, 0, (acc, item) => acc + item.price, 4);
    let tax = itemTotal / 10;
    return {'subtotal': itemTotal, 'total': itemTotal + tax};
  }
  require positiveItems {
    let allPos = bounded.all(input.items, item => item.price > 0, 4);
    return allPos;
  }
  require totalMatches {
    let expected = derived.total;
    return after.total == expected && after.owner == before.owner;
  }
}
`;

const COUNTER_POLICY = `transition nextStep {
  require increment {
    return before.count is int
      && before.count >= 0
      && before.count <= 9007199254740991
      && after.count is int
      && after.count >= 0
      && after.count <= 9007199254740991
      && after.count == before.count + 1;
  }
}
`;

describe('pyric policy prove', () => {
  it('proves transition policy across interpreter, standalone ESM, Firestore, and RTDB', async () => {
    const dir = makeTempDir();
    const pol = join(dir, 'counter.policy');
    const fsFile = join(dir, 'fs.json');
    const rtdbFile = join(dir, 'rtdb.json');
    const scenariosFile = join(dir, 'scenarios.json');
    writeFileSync(pol, COUNTER_POLICY);
    writeFileSync(
      fsFile,
      JSON.stringify({
        'before.count': 'resource.data.count',
        'after.count': 'request.resource.data.count',
      }),
    );
    writeFileSync(
      rtdbFile,
      JSON.stringify({
        'before.count': { snapshot: 'data', path: 'count', type: 'number' },
        'after.count': { snapshot: 'newData', path: 'count', type: 'number' },
      }),
    );
    writeFileSync(
      scenariosFile,
      JSON.stringify([
        {
          name: 'valid increment',
          transition: { before: { count: 1 }, after: { count: 2 }, input: {} },
          expectOk: true,
        },
        {
          name: 'reject skip',
          transition: { before: { count: 1 }, after: { count: 3 }, input: {} },
          expectOk: false,
          expectRequirement: 'increment',
        },
      ]),
    );

    const res = await runProve([
      pol,
      '--firestore-bindings',
      fsFile,
      '--rtdb-bindings',
      rtdbFile,
      '--scenarios',
      scenariosFile,
      '--mode',
      'complete',
      '--seed',
      '42',
      '--fuzz-cases',
      '20',
      '--json',
    ]);
    expect(res.code).toBe(POLICY_EXIT_OK);
    const report = JSON.parse(res.out) as PolicyProveReport;
    expect(report.schema).toBe('pyric.policy.prove.v1');
    expect(report.ok).toBe(true);
    expect(report.standalone.esmVerified).toBe(true);
    expect(report.scenarios.total).toBe(2);
    expect(report.scenarios.passed).toBe(2);
    expect(report.scenarios.failed).toBe(0);
    // Intentional denial still hoists failureTrace for auditing without creating a counterexample.
    expect(report.scenarios.results[1]?.failureTrace?.requirement).toBe('increment');
    expect(report.counterexamples).toEqual([]);
    expect(report.fuzz.enabled).toBe(true);
    expect(report.fuzz.seed).toBe(42);
    expect(report.fuzz.casesRun).toBe(20);
    expect(report.fuzz.passed).toBe(20);
    expect(report.fuzz.failed).toBe(0);
    expect(report.placement.firestore?.complete).toBe(true);
    expect(report.placement.rtdb?.complete).toBe(true);
  });

  it('hoists rich failure traces and counterexamples on scenario failure (exit 4)', async () => {
    const dir = makeTempDir();
    const pol = join(dir, 'order.policy');
    const scenariosFile = join(dir, 'scenarios.json');
    writeFileSync(pol, ORDER_POLICY);
    writeFileSync(
      scenariosFile,
      JSON.stringify({
        scenarios: [
          {
            name: 'understated total fails',
            transition: {
              before: { owner: 'u1' },
              after: { owner: 'u1', total: 99 },
              input: { items: [{ price: 50 }, { price: 50 }] },
            },
            expectOk: true,
          },
          {
            name: 'valid checkout expected deny (too permissive)',
            transition: {
              before: { owner: 'u1' },
              after: { owner: 'u1', total: 110 },
              input: { items: [{ price: 50 }, { price: 50 }] },
            },
            expectOk: false,
          },
          {
            name: 'bounded limit exceeded is fatal',
            transition: {
              before: { owner: 'u1' },
              after: { owner: 'u1', total: 5 },
              input: { items: [{ price: 1 }, { price: 1 }, { price: 1 }, { price: 1 }, { price: 1 }] },
            },
            expectOk: false,
          },
          {
            name: 'missing field is non-fatal eval-error',
            transition: {
              before: { owner: 'u1' },
              after: { owner: 'u1' },
              input: { items: [{ price: 20 }] },
            },
            expectOk: false,
          },
        ],
      }),
    );

    const res = await runProve([pol, '--scenarios', scenariosFile, '--no-fuzz', '--json']);
    expect(res.code).toBe(POLICY_EXIT_PROOF);
    const report = JSON.parse(res.out) as PolicyProveReport;
    expect(report.ok).toBe(false);
    expect(report.exitCode).toBe(4);
    expect(report.fuzz.enabled).toBe(false);
    expect(report.fuzz.casesRun).toBe(0);
    expect(report.scenarios.passed).toBe(2);
    expect(report.scenarios.failed).toBe(2);
    expect(report.counterexamples).toHaveLength(2);

    const ce0 = report.counterexamples[0]!;
    expect(ce0.source).toBe('scenario');
    expect(ce0.name).toBe('understated total fails');
    expect(ce0.requirement).toBe('totalMatches');
    expect(ce0.reason).toContain('99');
    expect(ce0.reason).toContain('110');
    expect(ce0.span?.line).toBe(14);
    expect(ce0.trace?.derived).toEqual({ subtotal: 100, total: 110 });
    expect(ce0.trace?.bindings.map((b) => [b.scope, b.name, b.value])).toEqual([
      ['derive', 'itemTotal', 100],
      ['derive', 'tax', 10],
      ['require', 'expected', 110],
    ]);
    expect(ce0.trace?.failingSubExpression?.operator).toBe('==');
    expect(ce0.trace?.failingSubExpression?.operands).toEqual([
      { source: 'after.total', value: 99 },
      { source: 'expected', value: 110 },
    ]);

    const ce1 = report.counterexamples[1]!;
    expect(ce1.name).toBe('valid checkout expected deny (too permissive)');
    expect(ce1.mismatch).toContain('Expected ok=false');

    expect(report.scenarios.results[2]?.failureTrace?.outcome).toBe('resource-limit');
    expect(report.scenarios.results[2]?.failureTrace?.fatal).toBe(true);
    expect(report.scenarios.results[3]?.failureTrace?.outcome).toBe('eval-error');
    expect(report.scenarios.results[3]?.failureTrace?.fatal).toBe(false);
  });

  it('proves function and module policies and fails with exit 4 on wrong expectValue', async () => {
    const dir = makeTempDir();
    const modFile = join(dir, 'math.policy');
    const scenariosFile = join(dir, 'mod-scenarios.json');
    writeFileSync(
      modFile,
      [
        'use extension bounded;',
        'export function total(xs) {',
        '  return bounded.fold(xs, 0, (acc, v) => acc + v, 8);',
        '}',
        '',
      ].join('\n'),
    );
    writeFileSync(
      scenariosFile,
      JSON.stringify([
        { name: 'sum ok', functionName: 'total', args: [[10, 20, 5]], expectValue: 35 },
      ]),
    );

    const okRes = await runProve([
      modFile,
      '--scenarios',
      scenariosFile,
      '--fuzz-cases',
      '10',
      '--no-adversarial',
      '--json',
    ]);
    expect(okRes.code).toBe(POLICY_EXIT_OK);
    expect(JSON.parse(okRes.out).standalone.esmVerified).toBe(true);

    writeFileSync(
      scenariosFile,
      JSON.stringify([
        { name: 'sum mismatch', functionName: 'total', args: [[10, 20]], expectValue: 99 },
      ]),
    );
    const badRes = await runProve([modFile, '--scenarios', scenariosFile, '--no-fuzz', '--no-esm-verify', '--json']);
    expect(badRes.code).toBe(POLICY_EXIT_PROOF);
    const badReport = JSON.parse(badRes.out) as PolicyProveReport;
    expect(badReport.standalone.esmVerified).toBe(false);
    expect(badReport.counterexamples[0]?.mismatch).toContain('Expected 99');
  });

  it('exits 3 on complete-mode residuals or ESM verification failure, and 2 on static error', async () => {
    const dir = makeTempDir();
    const orderFile = join(dir, 'order.policy');
    const fsFile = join(dir, 'fs.json');
    writeFileSync(orderFile, ORDER_POLICY);
    writeFileSync(fsFile, JSON.stringify({ 'before.owner': 'resource.data.owner' }));

    const residual = await runProve([
      orderFile,
      '--firestore-bindings',
      fsFile,
      '--mode',
      'complete',
      '--no-fuzz',
      '--json',
    ]);
    expect(residual.code).toBe(POLICY_EXIT_PLACEMENT);
    expect(JSON.parse(residual.out).diagnostics.some((d: { code: string }) => d.code === 'TARGET_LOWERING_ERROR')).toBe(
      true,
    );

    const esmFail = await runProve([orderFile, '--no-fuzz', '--json'], {
      verifyStandaloneEsm: async () => {
        throw new Error('broken export');
      },
    });
    expect(esmFail.code).toBe(POLICY_EXIT_PLACEMENT);
    const esmReport = JSON.parse(esmFail.out) as PolicyProveReport;
    expect(esmReport.standalone.ok).toBe(false);
    expect(esmReport.diagnostics[0]?.code).toBe('STANDALONE_EMIT_ERROR');

    const badSyntax = join(dir, 'bad.policy');
    writeFileSync(badSyntax, 'transition { }\n');
    const synRes = await runProve([badSyntax, '--json']);
    expect(synRes.code).toBe(POLICY_EXIT_STATIC);
    expect(JSON.parse(synRes.out).diagnostics[0].span).not.toBeNull();
  });

  it('surfaces fuzz divergences as PARITY_DIVERGENCE counterexamples with exit 4', async () => {
    const dir = makeTempDir();
    const pol = join(dir, 'counter.policy');
    writeFileSync(pol, COUNTER_POLICY);
    const realApi = await loadPolicyExperimentalApi();

    const res = await runProve([pol, '--fuzz-cases', '5', '--json'], {
      loadPolicyApi: async () => ({
        ...realApi,
        provePolicy(source, opts) {
          const base = realApi.provePolicy(source, opts);
          return {
            ...base,
            ok: false,
            fuzz: {
              ...base.fuzz,
              passed: base.fuzz.casesRun - 1,
              divergences: [
                {
                  caseIndex: 3,
                  input: { before: { count: 1 }, after: { count: 2 }, input: {} },
                  interpreter: { kind: 'verdict', ok: true, fatal: false },
                  standalone: { kind: 'verdict', ok: false, requirement: 'increment', fatal: false },
                },
              ],
            },
          };
        },
      }),
    });
    expect(res.code).toBe(POLICY_EXIT_PROOF);
    const report = JSON.parse(res.out) as PolicyProveReport;
    expect(report.fuzz.failed).toBe(1);
    expect(report.counterexamples[0]?.source).toBe('fuzz');
    expect(report.counterexamples[0]?.caseIndex).toBe(3);
    expect(report.diagnostics[0]?.code).toBe('PARITY_DIVERGENCE');
  });

  it('supports --storage-bindings placement reporting and ASCII human output', async () => {
    const dir = makeTempDir();
    const pol = join(dir, 'upload.policy');
    const storageFile = join(dir, 'storage.json');
    writeFileSync(pol, 'transition up { require small { return after.size <= 1024; } }\n');
    writeFileSync(storageFile, JSON.stringify({ 'after.size': 'request.resource.size' }));

    const res = await runProve([pol, '--storage-bindings', storageFile, '--no-fuzz']);
    expect(res.code).toBe(POLICY_EXIT_OK);
    expect(res.out).toContain('pyric policy prove: OK');
    expect(res.out).toContain('storage: 1/1 lowered (complete)');
    expect(/^[\x00-\x7f]*$/.test(res.out)).toBe(true);
  });
});
