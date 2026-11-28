/**
 * Automated closed-loop diagnostic repair tests proving that structured
 * `pyric policy <check|prove|emit> --json` output pinpoints exact repairable
 * defects across syntax, static extension, derived-formula, and permissive-guard
 * failures without inspecting free-form console formatting.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from '../../src/cli/parse-args.js';
import {
  POLICY_EXIT_OK,
  POLICY_EXIT_PROOF,
  POLICY_EXIT_STATIC,
  runPolicy,
  type PolicyEmitReport,
  type PolicyProveReport,
} from '../../src/cli/policy/index.js';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pyric-policy-repair-'));
  tempDirs.push(dir);
  return dir;
}

async function runJson<T>(argv: string[]): Promise<{ code: number; report: T }> {
  let out = '';
  let err = '';
  const code = await runPolicy(parseArgs(['policy', ...argv]), {
    stdout: { write(s: string) { out += s; } },
    stderr: { write(s: string) { err += s; } },
  });
  expect(err).toBe('');
  return { code, report: JSON.parse(out) as T };
}

describe('closed-loop policy repair driven by --json diagnostics', () => {
  it('repairs syntax, missing extension, wrong derive formula, and emits verified artifacts', async () => {
    const dir = makeTempDir();
    const policyPath = join(dir, 'invoice.policy');
    const scenariosPath = join(dir, 'scenarios.json');
    const fsBindingsPath = join(dir, 'fs.json');
    const outDir = join(dir, 'out');

    // Start with three layered defects: missing extension, missing semicolon, and
    // wrong tax divisor (itemTotal / 5 instead of itemTotal / 10).
    let source = [
      'use extension bounded;',
      'transition finalizeInvoice {',
      '  derive {',
      '    let subtotal = bounded.fold(input.lines, 0, (acc, row) => acc + row.cents, 8);',
      '    let tax = subtotal / 5;',
      "    return {'subtotal': subtotal, 'total': subtotal + tax};",
      '  }',
      '  require tenantLocked {',
      '    return after.tenantId == before.tenantId',
      '  }',
      '  require totalMatches {',
      '    let expected = derived.total;',
      '    return after.totalCents == expected;',
      '  }',
      '}',
      '',
    ].join('\n');

    writeFileSync(
      scenariosPath,
      JSON.stringify([
        {
          name: '10 percent tax invoice',
          transition: {
            before: { tenantId: 'acme' },
            after: { tenantId: 'acme', totalCents: 1100 },
            input: { lines: [{ cents: 600 }, { cents: 400 }] },
          },
          expectOk: true,
        },
        {
          name: 'reject tampered total',
          transition: {
            before: { tenantId: 'acme' },
            after: { tenantId: 'acme', totalCents: 999 },
            input: { lines: [{ cents: 600 }, { cents: 400 }] },
          },
          expectOk: false,
          expectRequirement: 'totalMatches',
        },
        {
          name: 'reject cross-tenant move',
          transition: {
            before: { tenantId: 'acme' },
            after: { tenantId: 'other', totalCents: 1100 },
            input: { lines: [{ cents: 600 }, { cents: 400 }] },
          },
          expectOk: false,
          expectRequirement: 'tenantLocked',
        },
      ]),
    );
    writeFileSync(
      fsBindingsPath,
      JSON.stringify({
        'before.tenantId': 'resource.data.tenantId',
        'after.tenantId': 'request.resource.data.tenantId',
        'after.totalCents': 'request.resource.data.totalCents',
      }),
    );

    // Step 1: prove detects SYNTAX_ERROR with exact span near the missing semicolon.
    writeFileSync(policyPath, source);
    const step1 = await runJson<PolicyProveReport>([
      'prove',
      policyPath,
      '--scenarios',
      scenariosPath,
      '--no-fuzz',
      '--json',
    ]);
    expect(step1.code).toBe(POLICY_EXIT_STATIC);
    const d1 = step1.report.diagnostics[0]!;
    expect(d1.code).toBe('SYNTAX_ERROR');
    expect(d1.span?.line).toBeGreaterThanOrEqual(9);
    const lines1 = source.split('\n');
    const fixLineIdx = d1.span!.line - 2; // line right before closing brace
    expect(lines1[fixLineIdx]).toContain('after.tenantId == before.tenantId');
    lines1[fixLineIdx] = `${lines1[fixLineIdx]};`;
    source = lines1.join('\n');

    // Step 2: prove detects MISSING_EXTENSION for derive with inferred span.
    writeFileSync(policyPath, source);
    const step2 = await runJson<PolicyProveReport>([
      'prove',
      policyPath,
      '--scenarios',
      scenariosPath,
      '--no-fuzz',
      '--json',
    ]);
    expect(step2.code).toBe(POLICY_EXIT_STATIC);
    const d2 = step2.report.diagnostics[0]!;
    expect(d2.code).toBe('MISSING_EXTENSION');
    expect(d2.span?.line).toBe(3);
    const extMatch = /use extension ([a-z]+);/.exec(d2.message);
    expect(extMatch?.[1]).toBe('derive');
    source = `use extension ${extMatch![1]};\n${source}`;

    // Step 3: prove detects arithmetic bug via structured failureTrace bindings and operands.
    writeFileSync(policyPath, source);
    const step3 = await runJson<PolicyProveReport>([
      'prove',
      policyPath,
      '--scenarios',
      scenariosPath,
      '--no-fuzz',
      '--json',
    ]);
    expect(step3.code).toBe(POLICY_EXIT_PROOF);
    expect(step3.report.counterexamples).toHaveLength(1);
    const ce = step3.report.counterexamples[0]!;
    expect(ce.requirement).toBe('totalMatches');
    expect(ce.trace?.derived).toEqual({ subtotal: 1000, total: 1200 });
    const taxBinding = ce.trace?.bindings.find((b) => b.scope === 'derive' && b.name === 'tax');
    expect(taxBinding?.value).toBe(200);
    expect(taxBinding?.span?.line).toBe(6);
    const operands = ce.trace?.failingSubExpression?.operands ?? [];
    expect(operands).toEqual([
      { source: 'after.totalCents', value: 1100 },
      { source: 'expected', value: 1200 },
    ]);

    // Automated repair computes required divisor from trace subtotal (1000) and gap (1100 - 1000 = 100).
    const subtotal = (ce.trace!.derived as { subtotal: number }).subtotal;
    const desiredTotal = operands[0]!.value as number;
    const desiredTax = desiredTotal - subtotal;
    const divisor = subtotal / desiredTax;
    expect(divisor).toBe(10);
    const lines3 = source.split('\n');
    const taxIdx = taxBinding!.span!.line - 1;
    lines3[taxIdx] = lines3[taxIdx]!.replace(/subtotal \/ \d+/, `subtotal / ${divisor}`);
    source = lines3.join('\n');

    // Step 4: prove now passes with fuzzing + real temp .mjs ESM verification.
    writeFileSync(policyPath, source);
    const step4 = await runJson<PolicyProveReport>([
      'prove',
      policyPath,
      '--firestore-bindings',
      fsBindingsPath,
      '--scenarios',
      scenariosPath,
      '--seed',
      '2026',
      '--fuzz-cases',
      '24',
      '--json',
    ]);
    expect(step4.code).toBe(POLICY_EXIT_OK);
    expect(step4.report.ok).toBe(true);
    expect(step4.report.counterexamples).toEqual([]);
    expect(step4.report.standalone.esmVerified).toBe(true);
    expect(step4.report.fuzz.casesRun).toBe(24);
    expect(step4.report.placement.firestore?.summary).toEqual({
      total: 2,
      lowered: 1,
      residual: 1,
      loweredRequirements: ['tenantLocked'],
      residualRequirements: ['totalMatches'],
    });

    // Step 5: emit split-enforcement artifacts and import emitted .mjs via pathToFileURL.
    const step5 = await runJson<PolicyEmitReport>([
      'emit',
      policyPath,
      '--out-dir',
      outDir,
      '--mode',
      'mixed',
      '--firestore-bindings',
      fsBindingsPath,
      '--json',
    ]);
    expect(step5.code).toBe(POLICY_EXIT_OK);
    const mod = (await import(pathToFileURL(join(outDir, 'finalizeInvoice.mjs')).href)) as {
      judge(t: { before: unknown; after: unknown; input: unknown }): { ok: boolean };
    };
    expect(
      mod.judge({
        before: { tenantId: 'acme' },
        after: { tenantId: 'acme', totalCents: 1100 },
        input: { lines: [{ cents: 600 }, { cents: 400 }] },
      }).ok,
    ).toBe(true);
  });

  it('pinpoints an overly permissive missing separation-of-duties guard and verifies repair', async () => {
    const dir = makeTempDir();
    const policyPath = join(dir, 'approve.policy');
    const scenariosPath = join(dir, 'scenarios.json');

    const broken = [
      'transition approveDoc {',
      '  require validApprover {',
      "    return input.actor != '' && after.status == 'approved';",
      '  }',
      '}',
      '',
    ].join('\n');

    writeFileSync(policyPath, broken);
    writeFileSync(
      scenariosPath,
      JSON.stringify([
        {
          name: 'peer can approve',
          transition: {
            before: { author: 'alice', status: 'review' },
            after: { author: 'alice', status: 'approved' },
            input: { actor: 'bob' },
          },
          expectOk: true,
        },
        {
          name: 'author cannot self-approve',
          transition: {
            before: { author: 'alice', status: 'review' },
            after: { author: 'alice', status: 'approved' },
            input: { actor: 'alice' },
          },
          expectOk: false,
        },
      ]),
    );

    const beforeFix = await runJson<PolicyProveReport>([
      'prove',
      policyPath,
      '--scenarios',
      scenariosPath,
      '--no-fuzz',
      '--json',
    ]);
    expect(beforeFix.code).toBe(POLICY_EXIT_PROOF);
    expect(beforeFix.report.counterexamples).toHaveLength(1);
    const ce = beforeFix.report.counterexamples[0]!;
    expect(ce.name).toBe('author cannot self-approve');
    expect(ce.mismatch).toContain('Expected ok=false, got ok=true');
    const inputRec = ce.input as { before: { author: string }; input: { actor: string } };
    expect(inputRec.before.author).toBe(inputRec.input.actor);

    const repaired = broken.replace(
      "return input.actor != '' && after.status == 'approved';",
      "return input.actor != '' && input.actor != before.author && after.status == 'approved';",
    );
    writeFileSync(policyPath, repaired);

    const afterFix = await runJson<PolicyProveReport>([
      'prove',
      policyPath,
      '--scenarios',
      scenariosPath,
      '--fuzz-cases',
      '16',
      '--json',
    ]);
    expect(afterFix.code).toBe(POLICY_EXIT_OK);
    expect(afterFix.report.counterexamples).toEqual([]);
  });
});
