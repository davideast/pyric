/**
 * Deriver unit tests — the enumeration policy as executable spec.
 * Pure: no sandbox here (the runner round-trip lives in
 * derive.roundtrip.test.ts).
 */
import { describe, expect, test } from 'bun:test';
import type { WorkspaceTestCase, WorkspaceTestFile } from '~/lib/workspace-tests/runner';
import {
  caseIdentity,
  customConditions,
  deriveIdentities,
  deriveTests,
  findRuleForCase,
} from './derive';
import type { AppSpecV1 } from './schema';
import { COFFEE_SHOP_SPEC } from './coffee-shop.fixture';

const files = deriveTests(COFFEE_SHOP_SPEC);
const all: Array<{ file: WorkspaceTestFile; c: WorkspaceTestCase }> = files.flatMap((file) =>
  file.cases.map((c) => ({ file, c })),
);
const named = (frag: string) => all.filter(({ c }) => (c.name ?? '').includes(frag));

describe('deriveIdentities', () => {
  test('maps IdentitySpec → SeedUser with deterministic defaults', () => {
    const users = deriveIdentities(COFFEE_SHOP_SPEC);
    expect(users.map((u) => u.uid)).toEqual(['alice', 'bob', 'cara']);
    expect(users[0]).toMatchObject({ email: 'alice@example.test', password: 'pw-alice' });
    expect(users[2]!.customClaims).toEqual({ admin: true });
  });

  test('caseIdentity carries claims as token', () => {
    expect(caseIdentity(COFFEE_SHOP_SPEC.identities[2]!)).toEqual({
      uid: 'cara',
      token: { admin: true },
    });
    expect(caseIdentity(COFFEE_SHOP_SPEC.identities[0]!)).toEqual({ uid: 'alice' });
  });
});

describe('deriveTests — enumeration policy', () => {
  test('one file per collection; every case is derived-provenance and named', () => {
    expect(files).toHaveLength(2);
    for (const { c } of all) {
      expect(c.source).toBe('derived');
      expect(c.name).toStartWith('spec: ');
    }
  });

  test('satisfying ALLOW per granted cell', () => {
    // public menu read: anon allowed
    const menuGet = named('menuItems get — granted')[0]!.c;
    expect(menuGet.as).toBeNull();
    expect(menuGet.expect).toBe('ALLOW');
    // claim-gated create: cara with admin token
    const menuCreate = named('menuItems create — granted')[0]!.c;
    expect(menuCreate.as).toEqual({ uid: 'cara', token: { admin: true } });
    expect(menuCreate.expect).toBe('ALLOW');
    // owner create: alice, ownerField stamped, crossDoc-consistent
    const orderCreate = named('orders create — granted')[0]!.c;
    expect(orderCreate.as).toEqual({ uid: 'alice' });
    const data = orderCreate.do.data!;
    expect(data.userId).toBe('alice');
    expect(data.itemId).toBe('menuItems-x1');
    expect(data.price).toBe(1.5);
  });

  test('crossDoc seeds the remote doc and derives the drift DENY', () => {
    const ordersFile = files[1]!;
    const remote = ordersFile.seed?.find((s) => s.path === 'menuItems/menuItems-x1');
    expect(remote?.data.price).toBe(1.5);
    const drift = named('drifting from menuItems.price')[0]!.c;
    expect(drift.expect).toBe('DENY');
    expect(drift.do.data!.price).not.toBe(1.5);
  });

  test('anon DENY on every auth-requiring cell', () => {
    expect(named('orders create — unauthenticated denied')).toHaveLength(1);
    expect(named('orders get — unauthenticated denied')).toHaveLength(1);
    expect(named('orders list — unauthenticated denied')).toHaveLength(1);
    expect(named('menuItems create — unauthenticated denied')).toHaveLength(1);
    // public cells derive no anon DENY
    expect(named('menuItems get — unauthenticated denied')).toHaveLength(0);
  });

  test('owner violations: non-owner get/update DENY, create-spoof DENY, but list degrades to authenticated', () => {
    expect(named('orders get — non-owner')[0]!.c.expect).toBe('DENY');
    expect(named('orders update — non-owner')[0]!.c.expect).toBe('DENY');
    const spoof = named('owned by someone else')[0]!.c;
    expect(spoof.do.data!.userId).toBe('bob');
    expect(spoof.expect).toBe('DENY');
    expect(named('orders list — non-owner')).toHaveLength(0);
  });

  test('claim violations: each non-admin identity denied, otherwise satisfying', () => {
    const violators = named('without required claim denied').filter(({ c }) =>
      (c.name ?? '').includes('menuItems create'),
    );
    expect(violators.map(({ c }) => c.as?.uid).sort()).toEqual(['alice', 'bob']);
    for (const { c } of violators) {
      expect(c.expect).toBe('DENY');
      expect(c.do.data).toMatchObject({ name: expect.anything(), price: expect.anything() });
    }
  });

  test('required-field-missing DENY × field, create only', () => {
    const missing = named('missing required field').filter(({ c }) =>
      (c.name ?? '').includes('orders create'),
    );
    expect(missing).toHaveLength(4); // userId, itemId, price, qty
    for (const { c } of missing) expect(c.expect).toBe('DENY');
    const missingUserId = missing.find(({ c }) => c.name!.includes('"userId"'))!.c;
    expect('userId' in missingUserId.do.data!).toBe(false);
    // never derived for update (merged-write semantics)
    expect(named('orders update — missing required')).toHaveLength(0);
  });

  test('immutable-change DENY and enum transitions (legal ALLOW / illegal DENY)', () => {
    const imm = named('changing immutable "itemId"')[0]!.c;
    expect(imm.do.method).toBe('update');
    expect(imm.expect).toBe('DENY');
    const legal = named('legal "status" transition placed→ready')[0]!.c;
    expect(legal.expect).toBe('ALLOW');
    const illegal = named('illegal "status" transition')[0]!.c;
    expect(illegal.expect).toBe('DENY');
  });

  test('deny-by-default: anon + EVERY identity probe the ungranted op', () => {
    const dbd = named('orders delete — deny-by-default');
    expect(dbd).toHaveLength(4); // anon, alice, bob, cara
    const uids = dbd.map(({ c }) => c.as?.uid ?? 'anon').sort();
    expect(uids).toEqual(['alice', 'anon', 'bob', 'cara']);
    for (const { c } of dbd) expect(c.expect).toBe('DENY');
    // the probe doc exists so delete reaches the rules, not NOT_FOUND
    const probePath = dbd[0]!.c.do.path;
    expect(files[1]!.seed?.some((s) => s.path === probePath)).toBe(true);
  });

  test('case isolation contract: per-case target docs are seeded per file', () => {
    for (const file of files) {
      const seeded = new Set((file.seed ?? []).map((s) => s.path));
      for (const c of file.cases) {
        if (c.do.method === 'get' || c.do.method === 'update' || c.do.method === 'delete') {
          expect(seeded.has(c.do.path)).toBe(true);
        }
      }
    }
  });
});

describe('custom conditions', () => {
  const specWithCustom: AppSpecV1 = JSON.parse(JSON.stringify(COFFEE_SHOP_SPEC)) as AppSpecV1;
  specWithCustom.access.find((r) => r.collection.startsWith('orders') && r.op === 'get')!.grant = [
    { kind: 'authenticated' },
    { kind: 'owner' },
    { kind: 'custom', rulesExpr: 'request.time < resource.data.expiresAt', rationale: 'orders expire' },
  ];

  test('counted and surfaced with their cell coordinates', () => {
    expect(customConditions(COFFEE_SHOP_SPEC)).toHaveLength(0);
    const refs = customConditions(specWithCustom);
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({ collection: 'orders/{orderId}', op: 'get' });
  });

  test('a custom condition suppresses the derived ALLOW but keeps the DENY classes', () => {
    const f = deriveTests(specWithCustom);
    const cases = f.flatMap((x) => x.cases).filter((c) => (c.name ?? '').includes('orders get'));
    expect(cases.some((c) => (c.name ?? '').includes('granted identity allowed'))).toBe(false);
    expect(cases.some((c) => (c.name ?? '').includes('unauthenticated denied'))).toBe(true);
    expect(cases.some((c) => (c.name ?? '').includes('non-owner'))).toBe(true);
  });
});

describe('findRuleForCase (repair-feedback quoting)', () => {
  test('maps a failing derived case back to its generating rule', () => {
    const create = named('orders create — granted')[0]!.c;
    const rule = findRuleForCase(COFFEE_SHOP_SPEC, 'create', create.do.path);
    expect(rule?.collection).toBe('orders/{orderId}');
    expect(rule?.op).toBe('create');
    const list = named('orders list — granted')[0]!.c;
    expect(findRuleForCase(COFFEE_SHOP_SPEC, 'list', list.do.path)?.op).toBe('list');
  });

  test('deny-by-default probes quote the explicit deny rule when one exists, null when ungranted', () => {
    const dbd = named('orders delete — deny-by-default')[0]!.c;
    // coffee-shop declares orders delete EXPLICITLY denied — quote that rule
    expect(findRuleForCase(COFFEE_SHOP_SPEC, 'delete', dbd.do.path)).toMatchObject({
      op: 'delete',
      grant: 'deny',
    });
    // an entirely absent cell resolves to no rule
    const noDeleteRule: AppSpecV1 = JSON.parse(JSON.stringify(COFFEE_SHOP_SPEC)) as AppSpecV1;
    noDeleteRule.access = noDeleteRule.access.filter((r) => r.op !== 'delete' || !r.collection.startsWith('orders'));
    expect(findRuleForCase(noDeleteRule, 'delete', dbd.do.path)).toBeNull();
  });
});
