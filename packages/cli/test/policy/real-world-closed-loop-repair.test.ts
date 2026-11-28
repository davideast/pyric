import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  compilePolicy,
  provePolicy,
  type PolicyFailureTrace,
  type PolicyProofReport,
  type Verdict,
} from '../../../rules/dist/policy/index.js';

const REPO_ROOT = resolve(import.meta.dir, '../../../..');
const REAL_WORLD = join(REPO_ROOT, 'experiments/policy-oracle/suites/real-world');

const tempDirs: string[] = [];
afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

interface SerializedDeniedVerdict {
  ok: false;
  requirement: string;
  location: string;
  reason: string;
  trace?: PolicyFailureTrace;
}

function proveJson(source: string, options: Parameters<typeof provePolicy>[1]): PolicyProofReport {
  // Strictly round-trip through JSON to mirror the machine-readable CLI `--json` contract.
  return JSON.parse(JSON.stringify(provePolicy(source, options))) as PolicyProofReport;
}

async function verifyStandaloneFile(
  source: string,
  transition: { before: unknown; after: unknown; input: unknown },
): Promise<Verdict> {
  const dir = mkdtempSync(join(tmpdir(), 'pyric-repair-'));
  tempDirs.push(dir);
  const filePath = join(dir, 'repaired.mjs');
  writeFileSync(filePath, compilePolicy(source).standaloneModule().moduleSource, 'utf8');
  const mod = (await import(pathToFileURL(filePath).href)) as {
    judge: (t: { before: unknown; after: unknown; input: unknown }) => Verdict;
  };
  return mod.judge(transition);
}

describe('Closed-loop automated policy repair from structured JSON proof traces', () => {
  test('1. repairs omitted taxCents in saas-billing using trace.derived and operand delta', async () => {
    const billingDir = join(
      REAL_WORLD,
      'saas-billing/claims/seat-quota-invoice/v1/probes/invoice-transitions/v1',
    );
    const validSource = readFileSync(join(billingDir, 'policy.rules'), 'utf8');
    const brokenSource = validSource.replace(
      "'totalCents': netCents + taxCents",
      "'totalCents': netCents",
    );
    expect(brokenSource).not.toBe(validSource);

    const cases = JSON.parse(readFileSync(join(billingDir, 'cases.json'), 'utf8')) as Array<{
      id: string;
      transition: { before: unknown; after: unknown; input: unknown };
    }>;
    const { decisions } = JSON.parse(readFileSync(join(billingDir, 'raw/expected.json'), 'utf8')) as {
      decisions: Record<string, 'ALLOW' | 'DENY'>;
    };
    const scenarios = cases.map((c) => ({
      name: c.id,
      transition: c.transition,
      expectOk: decisions[c.id] === 'ALLOW',
    }));

    const beforeReport = proveJson(brokenSource, { scenarios, fuzz: { seed: 11, cases: 40 } });
    expect(beforeReport.ok).toBe(false);
    expect(beforeReport.scenarios.failed).toBe(1);

    const failure = beforeReport.scenarios.results.find((r) => !r.ok);
    expect(failure?.name).toBe('valid-overage-discount-tax-floor');
    const verdict = failure?.interpreter as SerializedDeniedVerdict;
    expect(verdict.requirement).toBe('invoiceTotalsExact');
    const trace = verdict.trace!;
    expect(trace.outcome).toBe('false');
    expect(trace.span.line).toBeGreaterThan(1);
    expect(trace.failingSubExpression?.operator).toBe('==');

    const [actualOp, derivedOp] = trace.failingSubExpression!.operands!;
    expect(actualOp).toEqual({ source: 'after.totalCents', value: 15533 });
    expect(derivedOp).toEqual({ source: 'derived.totalCents', value: 14350 });

    // Automated repair driven purely by the JSON proof trace: delta equals derived.taxCents.
    const derived = trace.derived as Record<string, number>;
    const delta = (actualOp!.value as number) - (derivedOp!.value as number);
    expect(delta).toBe(derived.taxCents);
    const missingTerm = Object.keys(derived).find((key) => key !== 'totalCents' && derived[key] === delta);
    expect(missingTerm).toBe('taxCents');

    const repairedSource = brokenSource.replace(
      /('totalCents'\s*:\s*[^,\n}]+)/,
      `$1 + ${missingTerm}`,
    );
    const afterReport = proveJson(repairedSource, { scenarios, fuzz: { seed: 11, cases: 40 } });
    expect(afterReport.ok).toBe(true);
    expect(afterReport.scenarios.passed).toBe(cases.length);
    expect(afterReport.fuzz.divergences).toEqual([]);

    const validCase = cases.find((c) => c.id === 'valid-overage-discount-tax-floor')!;
    expect((await verifyStandaloneFile(repairedSource, validCase.transition)).ok).toBe(true);
  });

  test('2. repairs strict quorum operator (> vs >=) in approval-workflow from failingSubExpression', async () => {
    const approvalDir = join(
      REAL_WORLD,
      'approval-workflow/claims/quorum-separation-of-duties/v1/probes/review-transitions/v1',
    );
    const validSource = readFileSync(join(approvalDir, 'policy.rules'), 'utf8');
    const brokenSource = validSource.replace('yesCount >= before.quorum', 'yesCount > before.quorum');
    expect(brokenSource).not.toBe(validSource);

    const cases = JSON.parse(readFileSync(join(approvalDir, 'cases.json'), 'utf8')) as Array<{
      id: string;
      transition: { before: unknown; after: unknown; input: unknown };
    }>;
    const { decisions } = JSON.parse(readFileSync(join(approvalDir, 'raw/expected.json'), 'utf8')) as {
      decisions: Record<string, 'ALLOW' | 'DENY'>;
    };
    const scenarios = cases.map((c) => ({
      name: c.id,
      transition: c.transition,
      expectOk: decisions[c.id] === 'ALLOW',
    }));

    const beforeReport = proveJson(brokenSource, { scenarios, fuzz: { seed: 22, cases: 30 } });
    expect(beforeReport.ok).toBe(false);
    const failure = beforeReport.scenarios.results.find((r) => !r.ok);
    expect(failure?.name).toBe('valid-unsorted-two-of-three-approval');

    const verdict = failure?.interpreter as SerializedDeniedVerdict;
    expect(verdict.requirement).toBe('quorumAndVeto');
    const trace = verdict.trace!;
    expect(trace.bindings).toEqual(
      expect.arrayContaining([expect.objectContaining({ scope: 'require', name: 'yesCount', value: 2 })]),
    );
    const sub = trace.failingSubExpression!;
    expect(sub.source).toContain('yesCount > before.quorum');

    // Pinpoint the exact line band inside `require quorumAndVeto` using trace.span.line.
    const lines = brokenSource.split('\n');
    const reqStartIdx = trace.span.line - 1;
    let repaired = false;
    for (let i = reqStartIdx; i < lines.length; i++) {
      if (lines[i]!.includes('yesCount > before.quorum')) {
        lines[i] = lines[i]!.replace('yesCount > before.quorum', 'yesCount >= before.quorum');
        repaired = true;
        break;
      }
    }
    expect(repaired).toBe(true);

    const repairedSource = lines.join('\n');
    const afterReport = proveJson(repairedSource, { scenarios, fuzz: { seed: 22, cases: 30 } });
    expect(afterReport.ok).toBe(true);
    expect(afterReport.scenarios.passed).toBe(cases.length);
    expect(afterReport.fuzz.divergences).toEqual([]);

    const sample = cases.find((c) => c.id === 'valid-unsorted-two-of-three-approval')!;
    expect((await verifyStandaloneFile(repairedSource, sample.transition)).ok).toBe(true);
  });

  test('3. repairs wrong Firestore snapshot binding origin using structured PlacementReasonCode', () => {
    const rbacPolicy = readFileSync(
      join(REAL_WORLD, 'multi-tenant-rbac/claims/role-hierarchy-access/v1/probes/doc-updates/v1/policy.rules'),
      'utf8',
    );
    const brokenBindings: Record<string, string> = {
      'input.auth': 'request.auth',
      'input.uid': 'request.auth.uid',
      'input.tenant': 'request.auth.token.tenantId',
      'input.pathTenant': 'tenantId',
      'input.role': 'request.auth.token.role',
      'input.roleRank': 'request.auth.token.roleRank',
      'before.tenantId': 'resource.data.tenantId',
      // Deliberate defect: after.tenantId bound to pre-write resource.data instead of request.resource.data.
      'after.tenantId': 'resource.data.tenantId',
      'before.minWriteRank': 'resource.data.minWriteRank',
      'after.minWriteRank': 'request.resource.data.minWriteRank',
      'before.restricted': 'resource.data.restricted',
      'after.restricted': 'request.resource.data.restricted',
      'before.status': 'resource.data.status',
      'after.status': 'request.resource.data.status',
      'before.createdBy': 'resource.data.createdBy',
      'after.createdBy': 'request.resource.data.createdBy',
      'after.updatedBy': 'request.resource.data.updatedBy',
    };

    const beforeReport = proveJson(rbacPolicy, { firestore: brokenBindings, fuzz: { enabled: false } });
    const row = beforeReport.placement.firestore?.find((r) => r.requirement === 'authenticatedTenantMember');
    expect(row?.enforcement).toBe('standalone only');
    const originDiag = row?.diagnostics.find((d) => d.code === 'WRONG_SNAPSHOT_ORIGIN');
    expect(originDiag).toBeDefined();
    expect(originDiag?.message).toContain('after.tenantId requires after');

    // Automated repair reads the diagnostic message and moves the projection to request.resource.data.
    const match = /^(after\.[A-Za-z0-9_]+) requires after, bound to before$/.exec(originDiag!.message);
    expect(match).not.toBeNull();
    const fieldName = match![1]!;
    const fixedBindings = {
      ...brokenBindings,
      [fieldName]: brokenBindings[fieldName]!.replace(/^resource\.data\./, 'request.resource.data.'),
    };

    const afterReport = proveJson(rbacPolicy, { firestore: fixedBindings, fuzz: { seed: 33, cases: 40 } });
    expect(afterReport.ok).toBe(true);
    const fixedRow = afterReport.placement.firestore?.find((r) => r.requirement === 'authenticatedTenantMember');
    expect(fixedRow?.enforcement).toBe('standalone and database');
    expect(fixedRow?.diagnostics).toEqual([expect.objectContaining({ code: 'LOWERED' })]);
  });

  test('4. repairs missing bounded extension declaration from staticCheck error report', () => {
    const missingExt = [
      'transition seatLimit {',
      '  require activeCap {',
      '    let active = bounded.count(input.seats, s => s.active == true, 8);',
      '    return active <= before.maxSeats;',
      '  }',
      '}',
    ].join('\n');
    const scenarios = [
      {
        name: 'within-cap',
        transition: { before: { maxSeats: 2 }, after: {}, input: { seats: [{ active: true }, { active: false }] } },
        expectOk: true,
      },
      {
        name: 'over-cap',
        transition: { before: { maxSeats: 1 }, after: {}, input: { seats: [{ active: true }, { active: true }] } },
        expectOk: false,
      },
    ];

    const beforeReport = proveJson(missingExt, { scenarios, fuzz: { enabled: false } });
    expect(beforeReport.ok).toBe(false);
    expect(beforeReport.staticCheck.ok).toBe(false);
    expect(beforeReport.staticCheck.error).toMatch(/bounded/i);

    const repaired = beforeReport.staticCheck.error?.toLowerCase().includes('bounded')
      ? `use extension bounded;\n${missingExt}`
      : missingExt;
    const afterReport = proveJson(repaired, { scenarios, fuzz: { seed: 44, cases: 30 } });
    expect(afterReport.ok).toBe(true);
    expect(afterReport.staticCheck.ok).toBe(true);
    expect(afterReport.staticCheck.extensions).toContain('bounded');
    expect(afterReport.scenarios.passed).toBe(2);
    expect(afterReport.fuzz.divergences).toEqual([]);
  });
});
