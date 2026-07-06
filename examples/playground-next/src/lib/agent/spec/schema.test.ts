/**
 * AppSpecV1 schema + validator tests: structural parsing, the
 * referential-integrity checks (rules name real collections; condition
 * fields exist), and the one-declaration cohesion (JSON schema renders
 * from the same zod source; op union is pyric's canonical
 * FirestoreMethod).
 */
import { describe, expect, test } from 'bun:test';
import { FIRESTORE_METHODS } from 'pyric/rules';
import {
  appSpecJsonSchema,
  collectionPathOf,
  resolveCollection,
  validateAppSpec,
  type AppSpecV1,
} from './schema';
import { COFFEE_SHOP_SPEC } from './coffee-shop.fixture';

function clone(spec: AppSpecV1): AppSpecV1 {
  return JSON.parse(JSON.stringify(spec)) as AppSpecV1;
}

describe('validateAppSpec', () => {
  test('the coffee-shop worked example validates', () => {
    const v = validateAppSpec(COFFEE_SHOP_SPEC);
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.spec.collections).toHaveLength(2);
  });

  test('structural garbage reports zod issues, never throws', () => {
    for (const bad of [null, 42, 'spec', {}, { meta: { title: 'x' } }]) {
      const v = validateAppSpec(bad);
      expect(v.ok).toBe(false);
      if (!v.ok) expect(v.errors.length).toBeGreaterThan(0);
    }
  });

  test('an unknown op is a structural error (canonical method union)', () => {
    const spec = clone(COFFEE_SHOP_SPEC);
    (spec.access[0] as { op: string }).op = 'read';
    const v = validateAppSpec(spec);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.errors.join('\n')).toContain('access.0.op');
  });

  test('access rule naming an unknown collection is rejected, quoting the rule', () => {
    const spec = clone(COFFEE_SHOP_SPEC);
    spec.access.push({ collection: 'receipts/{id}', op: 'get', grant: [] });
    const v = validateAppSpec(spec);
    expect(v.ok).toBe(false);
    if (!v.ok) {
      const msg = v.errors.find((e) => e.includes('unknown collection "receipts/{id}"'));
      expect(msg).toBeTruthy();
      expect(msg).toContain('"op":"get"'); // the offending rule is quoted
    }
  });

  test('condition fields must exist on the collection', () => {
    const spec = clone(COFFEE_SHOP_SPEC);
    spec.access.push({
      collection: 'menuItems/{itemId}',
      op: 'delete',
      grant: [{ kind: 'fieldEquals', field: 'archived', value: true }],
    });
    // also makes a duplicate (collection, op) cell — both errors expected
    const v = validateAppSpec(spec);
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.errors.some((e) => e.includes('field "archived" not declared'))).toBe(true);
      expect(v.errors.some((e) => e.includes('duplicate access entry'))).toBe(true);
    }
  });

  test('enumTransition requires enum values + transitions on the field', () => {
    const spec = clone(COFFEE_SHOP_SPEC);
    const orders = spec.collections[1]!;
    const status = orders.fields.find((f) => f.name === 'status')!;
    delete (status as { transitions?: unknown }).transitions;
    const v = validateAppSpec(spec);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.errors.some((e) => e.includes('no transitions map'))).toBe(true);
  });

  test('crossDoc must resolve: remote collection + remoteField + local fields', () => {
    const spec = clone(COFFEE_SHOP_SPEC);
    const create = spec.access.find((r) => r.collection.startsWith('orders') && r.op === 'create')!;
    const grant = create.grant as Exclude<typeof create.grant, 'deny'>;
    const cross = grant.find((c) => c.kind === 'crossDoc') as Extract<
      (typeof grant)[number],
      { kind: 'crossDoc' }
    >;
    cross.collection = 'inventory';
    const v1 = validateAppSpec(spec);
    expect(v1.ok).toBe(false);
    if (!v1.ok) expect(v1.errors.some((e) => e.includes('unknown collection "inventory"'))).toBe(true);

    cross.collection = 'menuItems';
    cross.remoteField = 'cost';
    const v2 = validateAppSpec(spec);
    expect(v2.ok).toBe(false);
    if (!v2.ok) expect(v2.errors.some((e) => e.includes('remoteField "cost" not declared'))).toBe(true);
  });

  test('declared ownerField must be a real field', () => {
    const spec = clone(COFFEE_SHOP_SPEC);
    spec.collections[1]!.ownerField = 'ownerUid';
    const v = validateAppSpec(spec);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.errors.some((e) => e.includes('ownerField "ownerUid"'))).toBe(true);
  });
});

describe('one-declaration cohesion', () => {
  test('JSON schema renders from the same source and carries the nine condition kinds', () => {
    const js = JSON.stringify(appSpecJsonSchema());
    for (const kind of [
      'authenticated',
      'owner',
      'claim',
      'fieldEquals',
      'fieldImmutable',
      'requiredFields',
      'enumTransition',
      'crossDoc',
      'custom',
    ]) {
      expect(js).toContain(`"${kind}"`);
    }
    // op enum is the canonical union, verbatim
    for (const m of FIRESTORE_METHODS) expect(js).toContain(`"${m}"`);
  });
});

describe('path helpers', () => {
  test('collectionPathOf strips the trailing wildcard only', () => {
    expect(collectionPathOf('orders/{orderId}')).toBe('orders');
    expect(collectionPathOf('users/{uid}/items/{itemId}')).toBe('users/{uid}/items');
    expect(collectionPathOf('orders')).toBe('orders');
  });

  test('resolveCollection matches exact template or collection name', () => {
    expect(resolveCollection(COFFEE_SHOP_SPEC, 'menuItems')?.path).toBe('menuItems/{itemId}');
    expect(resolveCollection(COFFEE_SHOP_SPEC, 'orders/{orderId}')?.path).toBe('orders/{orderId}');
    expect(resolveCollection(COFFEE_SHOP_SPEC, 'nope')).toBeNull();
  });
});
