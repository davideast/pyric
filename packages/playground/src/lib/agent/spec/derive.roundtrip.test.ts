/**
 * THE ROUND-TRIP PIN (plans/app-spec.md section 5) — the functional tripwire
 * for the whole spec-as-validator idea:
 *
 *   coffee-shop spec → deriveTests → the REAL workspace-tests runner
 *   (hermetic pyric sandbox, real data plane, deploy-once rules)
 *
 *   1. against a known-good ruleset: EVERY derived case holds — the
 *      deriver only ever emits cases a faithful ruleset satisfies
 *      (incl. the crossDoc price-match ALLOW with its seeded menu doc).
 *   2. against a deliberately over-permissive ruleset ("any signed-in
 *      user can do anything" — a ruleset that passes most model-style
 *      ALLOW tests): the derived deny-by-default and violation cases
 *      catch it.
 *
 * If this test can't be written cleanly, the feature doesn't work —
 * stop and report rather than forcing it (build-order pin).
 */
import { describe, expect, test } from 'bun:test';
import { runWorkspaceTests } from '~/lib/workspace-tests/runner';
import { deriveTests } from './derive';
import {
  COFFEE_SHOP_GOOD_RULES,
  COFFEE_SHOP_OVERPERMISSIVE_RULES,
  COFFEE_SHOP_SPEC,
} from './coffee-shop.fixture';

function asRunnerFiles() {
  return deriveTests(COFFEE_SHOP_SPEC).map((file, i) => ({
    name: `spec-derived-${i}.test.json`,
    content: JSON.stringify(file),
  }));
}

describe('round-trip pin: spec → deriveTests → real runner', () => {
  test('against the known-good ruleset every derived case holds', async () => {
    const report = await runWorkspaceTests(asRunnerFiles(), COFFEE_SHOP_GOOD_RULES);
    const failures = report.files.flatMap((f) =>
      f.failures.map((x) => `${f.file} :: ${x.name ?? `${x.method} ${x.path}`} expected ${x.expect} got ${x.got}${x.detail ? ` — ${x.detail}` : ''}`),
    );
    expect(failures).toEqual([]);
    expect(report.files.every((f) => !f.error)).toBe(true);
    expect(report.ok).toBe(true);
    // the matrix actually enumerated — this is a real suite, not a stub
    expect(report.total).toBeGreaterThanOrEqual(30);
    // …and the crossDoc ALLOW ran against a seeded remote doc
    const derived = deriveTests(COFFEE_SHOP_SPEC);
    expect(
      derived.some((f) =>
        f.cases.some(
          (c) => c.expect === 'ALLOW' && (c.name ?? '').includes('orders create — granted'),
        ),
      ),
    ).toBe(true);
  });

  test('against an over-permissive ruleset the deny-by-default cases catch it', async () => {
    const report = await runWorkspaceTests(asRunnerFiles(), COFFEE_SHOP_OVERPERMISSIVE_RULES);
    expect(report.ok).toBe(false);
    const failureNames = report.files.flatMap((f) => f.failures.map((x) => x.name ?? ''));
    // the ungranted op (orders delete) was allowed for signed-in users —
    // exactly the check class models never write
    const dbd = failureNames.filter((n) => n.includes('orders delete — deny-by-default'));
    expect(dbd.length).toBeGreaterThanOrEqual(3); // alice, bob, cara (anon still denies)
    // violation classes fire too: non-owner reads, claim bypass, drift
    expect(failureNames.some((n) => n.includes('orders get — non-owner'))).toBe(true);
    expect(failureNames.some((n) => n.includes('without required claim'))).toBe(true);
    expect(failureNames.some((n) => n.includes('drifting from menuItems.price'))).toBe(true);
    // every failure is DENY-expected-but-ALLOWED — over-permissiveness,
    // not test breakage
    for (const f of report.files.flatMap((x) => x.failures)) {
      expect(f.expect).toBe('DENY');
      expect(f.got).toBe('ALLOW');
      expect(f.source).toBe('derived');
    }
  });
});
