/**
 * THE ROUND-TRIP PIN for the rules compiler (plans/epic-scaffold-and-fill.md
 * §S3, step 3) — the headline proof:
 *
 *   spec → compileRules → deriveTests(spec) replayed through the REAL
 *   workspace runner (hermetic pyric sandbox, real data plane, deploy-once)
 *   → ALL derived cases pass.
 *
 * This proves COMPILER ⇔ DERIVER agreement: both descend from the same
 * access matrix, so if the compiled rules failed even one derived case, one
 * of the two would be wrong. The deriver is already pinned against a
 * HAND-WRITTEN faithful ruleset (derive.roundtrip.test.ts); this pins the
 * COMPILED ruleset against the SAME derived suite. Green here ⇔ the host can
 * own rule generation for the enumerable majority.
 *
 * Each spec here has ONLY enumerable conditions, so:
 *   - `compileRules` MUST emit ZERO holes;
 *   - the derived suite MUST be fully green against the compiled output.
 *
 * If this pin can't be written cleanly, the compiler doesn't work — stop and
 * report (build-order pin).
 */
import { describe, expect, test } from 'bun:test';
import { runWorkspaceTests } from '~/lib/workspace-tests/runner';
import { lintFirestoreRules } from 'pyric/rules';
import { compileRules } from './compile-rules';
import { deriveTests } from './derive';
import { COFFEE_SHOP_SPEC } from './coffee-shop.fixture';
import { DOC_REVIEW_SPEC, TEAM_TASKS_SPEC } from './compile-rules.fixtures';
import type { AppSpecV1 } from './schema';

function asRunnerFiles(spec: AppSpecV1) {
  return deriveTests(spec).map((file, i) => ({
    name: `spec-derived-${i}.test.json`,
    content: JSON.stringify(file),
  }));
}

/** The shared assertion: compile → no holes → lint-clean → every derived
 *  case green against the compiled rules through the real runner. */
async function pin(spec: AppSpecV1, minTotal: number) {
  const { rules, holes } = compileRules(spec);

  // Enumerable-only spec ⇒ no holes.
  expect(holes).toEqual([]);

  // Lint-clean output (the compiler's own product, run through the real linter).
  const lint = lintFirestoreRules(rules);
  expect(lint.parseError).toBeUndefined();
  expect(lint.warnings.filter((w) => w.severity === 'error')).toEqual([]);

  // The headline: every derived case passes against the COMPILED rules.
  const report = await runWorkspaceTests(asRunnerFiles(spec), rules);
  const failures = report.files.flatMap((f) =>
    f.failures.map(
      (x) =>
        `${f.file} :: ${x.name ?? `${x.method} ${x.path}`} expected ${x.expect} got ${x.got}${x.detail ? ` — ${x.detail}` : ''}`,
    ),
  );
  expect(failures).toEqual([]);
  expect(report.files.every((f) => !f.error)).toBe(true);
  expect(report.ok).toBe(true);
  expect(report.total).toBeGreaterThanOrEqual(minTotal);
  return report;
}

describe('round-trip pin: spec → compileRules → deriveTests → real runner', () => {
  test('coffee-shop (crossDoc + enumTransition + claim) — every derived case green', async () => {
    // The hardest fixture: crossDoc price-match ALLOW runs against the
    // compiler-emitted get(); the deny-by-default + drift + claim-bypass
    // cases all hold.
    await pin(COFFEE_SHOP_SPEC, 30);
  });

  test('team-tasks (custom claims + path-uid + public-read) — every derived case green', async () => {
    await pin(TEAM_TASKS_SPEC, 25);
  });

  test('doc-review (branching enumTransition + immutable field) — every derived case green', async () => {
    await pin(DOC_REVIEW_SPEC, 12);
  });

  // Agreement edge (sec #770): a read op gated ONLY by a field-shaped
  // condition. On get/delete `fieldEquals` IS evaluable (resource.data), so
  // the compiler emits a real filtering predicate and the deriver derives a
  // satisfying ALLOW + a wrong-value DENY — both must hold. The old behavior
  // (drop the predicate → `if true`, a public read) was the fail-open bug.
  test('degenerate cell: field-only read compiles to a filtering predicate (not public)', async () => {
    const fieldOnly: AppSpecV1 = {
      meta: { title: 'edge', assumptions: [] },
      identities: [{ uid: 'a' }],
      collections: [{ path: 'c/{id}', fields: [{ name: 'f', type: 'string' }] }],
      access: [{ collection: 'c/{id}', op: 'get', grant: [{ kind: 'fieldEquals', field: 'f', value: 'x' }] }],
    };
    const authPlusField: AppSpecV1 = {
      ...fieldOnly,
      access: [
        {
          collection: 'c/{id}',
          op: 'get',
          grant: [{ kind: 'authenticated' }, { kind: 'fieldEquals', field: 'f', value: 'x' }],
        },
      ],
    };
    // The compiled get predicate must actually filter (never `if true`).
    expect(compileRules(fieldOnly).rules).not.toContain('allow get: if true;');
    await pin(fieldOnly, 2); // satisfying ALLOW + wrong-value DENY
    await pin(authPlusField, 2);
  });

  // A `list` gated only by a field-shaped condition is NOT evaluable
  // (no single resource), so the compiler fails CLOSED (`if false`) and the
  // deriver deny-routes the cell — the compiled deny and the derived all-deny
  // probes must agree.
  test('degenerate cell: field-only LIST fails closed and the deriver agrees', async () => {
    const listFieldOnly: AppSpecV1 = {
      meta: { title: 'edge', assumptions: [] },
      identities: [{ uid: 'a' }],
      collections: [{ path: 'c/{id}', fields: [{ name: 'f', type: 'string' }] }],
      access: [{ collection: 'c/{id}', op: 'list', grant: [{ kind: 'fieldEquals', field: 'f', value: 'x' }] }],
    };
    expect(compileRules(listFieldOnly).rules).toContain('allow list: if false;');
    await pin(listFieldOnly, 1); // deny-by-default probes, all DENY
  });
});
