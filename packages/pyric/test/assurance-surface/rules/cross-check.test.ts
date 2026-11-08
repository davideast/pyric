import { describe, expect, test } from 'bun:test';
import { inferOwnerBindings } from '../../../src/assurance-surface/rules/cross-check.js';
import type { AccessSite } from '../../../src/assurance-surface/code/types.js';
import type { OwnerCondition } from '../../../src/assurance-surface/rules/types.js';

const uid = [{ source: 'auth.uid' as const, certainty: 'exact' as const }];

function site(partial: Partial<AccessSite> & Pick<AccessSite, 'path' | 'service' | 'op'>): AccessSite {
  return { source: 'app.ts:1', resolution: 'resolved', ...partial };
}

function cond(partial: Partial<OwnerCondition> & Pick<OwnerCondition, 'path' | 'service' | 'kind' | 'field'>): OwnerCondition {
  return { ops: ['write'], relation: 'equals', required: true, source: 'rules:1', expression: 'x', ...partial };
}

describe('inferOwnerBindings', () => {
  test('rules and code agree on a path variable: strong, with the map depth recorded', () => {
    const out = inferOwnerBindings(
      [cond({ service: 'rtdb', path: 'tokens/$uid', kind: 'pathVar', field: '$uid', varIndex: 1 })],
      [site({ service: 'rtdb', op: 'set', path: 'tokens/$u/$device', pathVariables: [{ name: 'u', auth: uid }, { name: 'device' }] })],
    );
    expect(out).toEqual([
      expect.objectContaining({
        path: 'tokens/$uid',
        kind: 'pathVar',
        strength: 'strong',
        evidence: 'rules+code',
        depth: { decidedAt: 'tokens/$uid', writtenAt: ['tokens/$u/$device'], keyedMap: true },
        codeSources: ['app.ts:1'],
      }),
    ]);
  });

  test('a field the rules check and the client writes from the user is strong (Firestore)', () => {
    const out = inferOwnerBindings(
      [cond({ service: 'firestore', path: 'posts/{p}', kind: 'incomingField', field: 'author', location: 'posts/{p}#author', ops: ['create'] })],
      [site({ service: 'firestore', op: 'setDoc', path: 'posts/{id}', payload: { kind: 'object', open: false, fields: [{ name: 'author', kind: 'string', auth: uid }] } })],
    );
    expect(out.map((b) => [b.kind, b.field, b.strength])).toEqual([['incomingField', 'author', 'strong']]);
  });

  test('a field only the rules check is tentative rules-only', () => {
    const out = inferOwnerBindings(
      [cond({ service: 'firestore', path: 'todos/{t}', kind: 'incomingField', field: 'ownerId', location: 'todos/{t}#ownerId', ops: ['create'] })],
      [site({ service: 'firestore', op: 'setDoc', path: 'todos/{id}', payload: { kind: 'object', open: false, fields: [{ name: 'owner', kind: 'string', auth: uid }] } })],
    );
    expect(out.map((b) => [b.path, b.field, b.strength, b.evidence])).toEqual([
      ['todos/{id}', 'owner', 'tentative', 'code-only'],
      ['todos/{t}', 'ownerId', 'tentative', 'rules-only'],
    ]);
  });

  test('an owner only the code shows (a rule that forgot the check) is tentative code-only', () => {
    const out = inferOwnerBindings([], [
      site({ service: 'rtdb', op: 'set', path: 'presence/$uid', pathVariables: [{ name: 'uid', auth: uid }] }),
      site({ service: 'rtdb', op: 'update', path: 'shared/latest', multiPath: true, payload: { kind: 'object', open: false, fields: [{ name: 'by', kind: 'string', auth: uid }] } }),
    ]);
    expect(out.map((b) => [b.path, b.kind, b.field, b.evidence])).toEqual([
      ['presence/$uid', 'pathVar', '$uid', 'code-only'],
      ['shared/latest', 'incomingField', 'by', 'code-only'],
    ]);
  });

  test('a lookup keyed by auth.uid is strong when the client writes that record from the user', () => {
    const out = inferOwnerBindings(
      [cond({ service: 'rtdb', path: 'rooms/$r', kind: 'lookup', field: 'rooms/$r/members/{auth.uid}', relation: 'exists', ops: ['read'] })],
      [site({ service: 'rtdb', op: 'update', path: 'rooms/$id/members/$uid', pathVariables: [{ name: 'id' }, { name: 'uid', auth: uid }] })],
    );
    expect(out.map((b) => [b.kind, b.strength])).toEqual([['lookup', 'strong']]);
  });

  test('conditions on the same template merge their operations and sources', () => {
    const out = inferOwnerBindings(
      [
        cond({ service: 'rtdb', path: 'a/$u', kind: 'pathVar', field: '$u', varIndex: 1, ops: ['read'], source: 'r#1' }),
        cond({ service: 'rtdb', path: 'a/$x', kind: 'pathVar', field: '$u', varIndex: 1, ops: ['write'], source: 'r#2' }),
      ],
      [],
    );
    expect(out).toHaveLength(1);
    expect(out[0].ops).toEqual(['read', 'write']);
    expect(out[0].ruleSources).toEqual(['r#1', 'r#2']);
  });

  test('a field mixing the uid with other identities is attribution, not an owner', () => {
    const mixed = [{ source: 'auth.displayName' as const, certainty: 'partial' as const }, { source: 'auth.uid' as const, certainty: 'partial' as const }];
    const out = inferOwnerBindings([], [
      site({ service: 'rtdb', op: 'set', path: 'feed/$id', payload: { kind: 'object', open: false, fields: [{ name: 'user', kind: 'string', auth: mixed }] } }),
    ]);
    expect(out).toEqual([]);
  });

  test('normalizes service headers on matching default resources while isolating named databases and instances', () => {
    const matchingDefault = inferOwnerBindings(
      [
        cond({
          service: 'firestore',
          path: '/databases/(default)/documents/posts/{p}',
          kind: 'incomingField',
          field: 'author',
          location: '/databases/(default)/documents/posts/{p}#author',
          ops: ['create'],
        }),
      ],
      [
        site({
          service: 'firestore',
          op: 'setDoc',
          path: 'posts/{id}',
          payload: { kind: 'object', open: false, fields: [{ name: 'author', kind: 'string', auth: uid }] },
        }),
      ],
    );
    expect(matchingDefault.map((b) => [b.kind, b.field, b.strength, b.evidence])).toEqual([
      ['incomingField', 'author', 'strong', 'rules+code'],
    ]);

    const isolatedNamedDb = inferOwnerBindings(
      [
        cond({
          service: 'firestore',
          path: '/databases/analytics-db/documents/posts/{p}',
          kind: 'incomingField',
          field: 'author',
          location: '/databases/analytics-db/documents/posts/{p}#author',
          ops: ['create'],
        }),
      ],
      [
        site({
          service: 'firestore',
          op: 'setDoc',
          path: 'posts/{id}',
          payload: { kind: 'object', open: false, fields: [{ name: 'author', kind: 'string', auth: uid }] },
        }),
      ],
    );
    expect(isolatedNamedDb.map((b) => [b.evidence])).toEqual([['rules-only'], ['code-only']]);

    const isolatedPathVar = inferOwnerBindings(
      [
        cond({
          service: 'firestore',
          path: 'users/{uid}',
          kind: 'pathVar',
          field: '{uid}',
          varIndex: 0,
        }),
      ],
      [
        site({
          service: 'firestore',
          op: 'setDoc',
          path: '/databases/analytics-db/documents/users/{uid}',
          pathVariables: [{ name: 'uid', auth: uid }],
          payload: { kind: 'object', open: false, fields: [] },
        }),
      ],
    );
    expect(isolatedPathVar.map((b) => [b.path, b.evidence])).toEqual([
      ['/databases/analytics-db/documents/users/{uid}', 'code-only'],
      ['users/{uid}', 'rules-only'],
    ]);
  });
});
