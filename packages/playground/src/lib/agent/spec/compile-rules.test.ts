/**
 * Unit pins for the rules compiler (compile-rules.ts) — the per-kind
 * encoding and the structural invariants. The FUNCTIONAL agreement with the
 * deriver is proven separately by compile-rules.roundtrip.test.ts (the real
 * runner); these are the cheap, fast structural pins.
 */
import { describe, expect, test } from 'bun:test';
import { lintFirestoreRules } from 'pyric/rules';
import { compileRules, unfilledHoles } from './compile-rules';
import { COFFEE_SHOP_SPEC } from './coffee-shop.fixture';
import type { AppSpecV1 } from './schema';

function lint(rules: string) {
  const res = lintFirestoreRules(rules);
  return {
    parseError: res.parseError,
    errors: res.warnings.filter((w) => w.severity === 'error'),
  };
}

/** Extract the `allow <op>` line text inside a named match block. */
function blockAllow(rules: string, matchPath: string, op: string): string {
  const lines = rules.split('\n');
  const startIdx = lines.findIndex((l) => l.trim() === `match /${matchPath} {`);
  if (startIdx < 0) return '';
  for (let i = startIdx + 1; i < lines.length; i++) {
    if (lines[i]!.trim() === '}') break; // end of this match block
    if (lines[i]!.trim().startsWith(`allow ${op}:`)) return lines[i]!;
  }
  return '';
}

const ordersAllow = (rules: string, op: string): string => blockAllow(rules, 'orders/{orderId}', op);

describe('compileRules — structure', () => {
  test('emits rules_version 2 + canonical service/match scaffolding', () => {
    const { rules } = compileRules(COFFEE_SHOP_SPEC);
    expect(rules).toContain("rules_version = '2';");
    expect(rules).toContain('service cloud.firestore {');
    expect(rules).toContain('match /databases/{database}/documents {');
    expect(rules).toContain('match /menuItems/{itemId} {');
    expect(rules).toContain('match /orders/{orderId} {');
  });

  test('compiled coffee-shop output is lint-clean (parses, no error warnings)', () => {
    const { rules } = compileRules(COFFEE_SHOP_SPEC);
    const { parseError, errors } = lint(rules);
    expect(parseError).toBeUndefined();
    expect(errors).toEqual([]);
  });

  test('no custom holes for the all-enumerable coffee-shop spec', () => {
    const { holes } = compileRules(COFFEE_SHOP_SPEC);
    expect(holes).toEqual([]);
  });
});

describe('compileRules — per-kind encoding', () => {
  test('empty grant ([]) → allow … if true (public)', () => {
    const { rules } = compileRules(COFFEE_SHOP_SPEC);
    expect(blockAllow(rules, 'menuItems/{itemId}', 'get')).toContain('if true');
    expect(blockAllow(rules, 'menuItems/{itemId}', 'list')).toContain('if true');
  });

  test("'deny' grant emits NO allow line for that op (deny-by-default)", () => {
    const { rules } = compileRules(COFFEE_SHOP_SPEC);
    expect(ordersAllow(rules, 'delete')).toBe(''); // orders delete grant: 'deny'
  });

  test('ungranted op emits no allow line (deny-by-default)', () => {
    const { rules } = compileRules(COFFEE_SHOP_SPEC);
    const lines = rules.split('\n');
    const startIdx = lines.findIndex((l) => l.trim() === 'match /orders/{orderId} {');
    let allows = 0;
    for (let i = startIdx + 1; i < lines.length && lines[i]!.trim() !== '}'; i++) {
      if (lines[i]!.trim().startsWith('allow ')) allows++;
    }
    expect(allows).toBe(4); // get, list, create, update (delete is deny)
  });

  test('authenticated → request.auth != null', () => {
    const { rules } = compileRules(COFFEE_SHOP_SPEC);
    expect(rules).toContain('request.auth != null');
  });

  test('claim → request.auth.token.<name> == <value>', () => {
    const { rules } = compileRules(COFFEE_SHOP_SPEC);
    expect(rules).toContain('request.auth.token.admin == true');
  });

  test('owner (ownerField) on READ → resource.data.<ownerField>', () => {
    const { rules } = compileRules(COFFEE_SHOP_SPEC);
    expect(ordersAllow(rules, 'get')).toContain('request.auth.uid == resource.data.userId');
  });

  test('owner (ownerField) on CREATE → request.resource.data.<ownerField>', () => {
    const { rules } = compileRules(COFFEE_SHOP_SPEC);
    expect(ordersAllow(rules, 'create')).toContain('request.auth.uid == request.resource.data.userId');
  });

  test('owner degrades to authenticated on LIST (never resource.data)', () => {
    const { rules } = compileRules(COFFEE_SHOP_SPEC);
    const ordersList = ordersAllow(rules, 'list');
    expect(ordersList).toContain('request.auth != null');
    expect(ordersList).not.toContain('resource.data');
  });

  test('requiredFields → keys().hasAll([...]) on CREATE only', () => {
    const { rules } = compileRules(COFFEE_SHOP_SPEC);
    expect(rules).toContain("request.resource.data.keys().hasAll(['name', 'price'])");
    expect(rules).toContain("request.resource.data.keys().hasAll(['userId', 'itemId', 'price', 'qty'])");
    // requiredFields is create-only — orders update must not carry hasAll.
    expect(ordersAllow(rules, 'update')).not.toContain('hasAll');
  });

  test('fieldImmutable → request.resource.data.<f> == resource.data.<f> on UPDATE', () => {
    const { rules } = compileRules(COFFEE_SHOP_SPEC);
    expect(ordersAllow(rules, 'update')).toContain('request.resource.data.itemId == resource.data.itemId');
  });

  test('enumTransition → no-op disjunct OR per-transition disjunction', () => {
    const { rules } = compileRules(COFFEE_SHOP_SPEC);
    const upd = ordersAllow(rules, 'update');
    expect(upd).toContain('request.resource.data.status == resource.data.status');
    expect(upd).toContain("resource.data.status == 'placed' && request.resource.data.status == 'ready'");
    expect(upd).toContain("resource.data.status == 'ready' && request.resource.data.status == 'pickedUp'");
  });

  test('crossDoc → get(/databases/$(database)/documents/<coll>/$(...)).data.<remote>', () => {
    const { rules } = compileRules(COFFEE_SHOP_SPEC);
    expect(ordersAllow(rules, 'create')).toContain(
      'request.resource.data.price == get(/databases/$(database)/documents/menuItems/$(request.resource.data.itemId)).data.price',
    );
  });
});

describe('compileRules — read/delete fail-closed (sec #770)', () => {
  const readGrant = (op: 'get' | 'list' | 'delete', grant: AppSpecV1['access'][number]['grant']): AppSpecV1 => ({
    meta: { title: 'edge', assumptions: [] },
    identities: [{ uid: 'a' }],
    collections: [{ path: 'c/{id}', fields: [{ name: 'f', type: 'string' }] }],
    access: [{ collection: 'c/{id}', op, grant }],
  });

  test('get gated ONLY by fieldEquals → resource.data predicate, never `if true`', () => {
    const { rules } = compileRules(readGrant('get', [{ kind: 'fieldEquals', field: 'f', value: 'x' }]));
    const line = blockAllow(rules, 'c/{id}', 'get');
    expect(line).toContain("resource.data.f == 'x'");
    expect(line).not.toContain('if true');
  });

  test('delete gated ONLY by fieldEquals → resource.data predicate, never `if true`', () => {
    const { rules } = compileRules(readGrant('delete', [{ kind: 'fieldEquals', field: 'f', value: 'x' }]));
    const line = blockAllow(rules, 'c/{id}', 'delete');
    expect(line).toContain("resource.data.f == 'x'");
    expect(line).not.toContain('if true');
  });

  test('list gated ONLY by fieldEquals (not evaluable) → fails CLOSED (`if false`)', () => {
    const { rules } = compileRules(readGrant('list', [{ kind: 'fieldEquals', field: 'f', value: 'x' }]));
    const line = blockAllow(rules, 'c/{id}', 'list');
    expect(line).toContain('if false');
    expect(line).not.toContain('if true');
  });

  test('get gated ONLY by a write-shaped condition (requiredFields) → fails CLOSED', () => {
    const { rules } = compileRules(readGrant('get', [{ kind: 'requiredFields', fields: ['f'] }]));
    const line = blockAllow(rules, 'c/{id}', 'get');
    expect(line).toContain('if false');
    expect(line).not.toContain('if true');
  });

  test('explicit empty grant ([]) is still public (`if true`) — reserved for []', () => {
    const { rules } = compileRules(readGrant('get', []));
    expect(blockAllow(rules, 'c/{id}', 'get')).toContain('if true');
  });
});

describe('compileRules — custom holes', () => {
  const customSpec: AppSpecV1 = {
    meta: { title: 'Custom', assumptions: [] },
    identities: [{ uid: 'alice' }],
    collections: [{ path: 'widgets/{id}', fields: [{ name: 'owner', type: 'string' }] }],
    access: [
      {
        collection: 'widgets/{id}',
        op: 'update',
        grant: [
          { kind: 'authenticated' },
          { kind: 'custom', rulesExpr: '', rationale: 'time-window only weekdays' },
        ],
      },
      {
        collection: 'widgets/{id}',
        op: 'create',
        grant: [
          { kind: 'authenticated' },
          { kind: 'custom', rulesExpr: 'request.time.toMillis() > 0', rationale: 'after epoch' },
        ],
      },
    ],
  };

  test('an UNFILLED custom hole is collected (rulesExpr null), no expr spliced', () => {
    const { rules, holes } = compileRules(customSpec);
    const unfilled = unfilledHoles(holes);
    expect(unfilled).toHaveLength(1);
    expect(unfilled[0]).toMatchObject({ collection: 'widgets/{id}', op: 'update', rulesExpr: null });
    // The update allow still emits (authenticated) but carries no custom expr.
    expect(blockAllow(rules, 'widgets/{id}', 'update')).toContain('request.auth != null');
  });

  test('a FILLED custom hole is spliced verbatim into the allow', () => {
    const { rules, holes } = compileRules(customSpec);
    expect(holes).toHaveLength(2);
    expect(blockAllow(rules, 'widgets/{id}', 'create')).toContain('(request.time.toMillis() > 0)');
  });

  test('compiled output with a filled hole still lints clean', () => {
    const { rules } = compileRules(customSpec);
    const { parseError, errors } = lint(rules);
    expect(parseError).toBeUndefined();
    expect(errors).toEqual([]);
  });
});
