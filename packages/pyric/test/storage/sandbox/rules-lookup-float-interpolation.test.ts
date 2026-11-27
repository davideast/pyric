/**
 * Regression tests for Storage vs Firestore float path interpolation (#1815).
 *
 * Production Storage Rules format interpolated floats via Java Double.toString
 * (verified in rules-storage-h1-lookup-float-interpolation.json and
 * rules-storage-h1-lookup-float-edge-forms.json), while Firestore Rules
 * pathLiteral rejects floats and accepts only strings, ints, and paths.
 */
import { describe, expect, test } from 'bun:test';
import { SimulateFirestoreRulesHandler } from '@pyric/rules/internal';
import { evaluateStorageRules, parseStorageRules } from '../../../src/storage/rules.js';

describe('Storage vs Firestore float path interpolation (#1815)', () => {
  test('Storage formats bare and literal floats via Java Double.toString without confusing 2.0 vs 2 or -0.0 vs 0', () => {
    const rules = parseStorageRules(`rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /claim/{file} {
      allow create: if firestore.exists(/databases/(default)/documents/items/$(request.auth.token.v));
    }
    match /lit20/{file} {
      allow create: if firestore.exists(/databases/(default)/documents/items/$(2.0));
    }
    match /negzero/{file} {
      allow create: if firestore.exists(/databases/(default)/documents/items/$(-0.0));
    }
    match /nan/{file} {
      allow create: if firestore.exists(/databases/(default)/documents/items/$(float('NaN')));
    }
  }
}`);

    const check = (path: string, mocked: string[], token?: Record<string, unknown>) =>
      evaluateStorageRules(
        rules,
        {
          request: {
            auth: token === undefined ? { uid: 'alice' } : { uid: 'alice', token },
            method: 'create',
            path: `b/pyric-default/o/${path}`,
            resource: { size: 1 },
          },
          resource: null,
        },
        undefined,
        {
          get: () => null,
          exists: (docPath) => mocked.includes(docPath),
        },
      ).allowed;

    expect(check('claim/a.bin', ['items/1.5'], { v: 1.5 })).toBe(true);
    expect(check('claim/a.bin', ['items/5.0E-4'], { v: 0.0005 })).toBe(true);
    expect(check('claim/a.bin', ['items/0.0005'], { v: 0.0005 })).toBe(false);
    expect(check('claim/a.bin', ['items/1.00000005E7'], { v: 10000000.5 })).toBe(true);
    expect(check('claim/a.bin', ['items/10000000.5'], { v: 10000000.5 })).toBe(false);
    expect(check('lit20/a.bin', ['items/2.0'])).toBe(true);
    expect(check('lit20/a.bin', ['items/2'])).toBe(false);
    expect(check('negzero/a.bin', ['items/-0.0'])).toBe(true);
    expect(check('negzero/a.bin', ['items/0', 'items/0.0'])).toBe(false);
    expect(check('nan/a.bin', ['items/NaN'])).toBe(true);
  });

  test('Firestore pathLiteral continues to reject floats (bare claim and literal) while accepting ints and strings', () => {
    const sim = new SimulateFirestoreRulesHandler();
    const rules = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /claim/{id} {
      allow get: if exists(/databases/$(database)/documents/items/$(request.auth.token.v));
    }
    match /lit/{id} {
      allow get: if exists(/databases/$(database)/documents/items/$(1.5));
    }
    match /lit20/{id} {
      allow get: if exists(/databases/$(database)/documents/items/$(2.0));
    }
  }
}`;
    const res = sim.simulate(rules, [
      {
        description: 'Firestore int claim allows',
        expectation: 'ALLOW',
        method: 'get',
        path: 'claim/1',
        auth: { uid: 'alice', token: { v: 7 } },
        functionMocks: [{ function: 'exists', path: 'items/7', result: true }],
      },
      {
        description: 'Firestore bare float claim denies',
        expectation: 'DENY',
        method: 'get',
        path: 'claim/1',
        auth: { uid: 'alice', token: { v: 1.5 } },
        functionMocks: [{ function: 'exists', path: 'items/1.5', result: true }],
      },
      {
        description: 'Firestore float literal 1.5 denies',
        expectation: 'DENY',
        method: 'get',
        path: 'lit/1',
        functionMocks: [{ function: 'exists', path: 'items/1.5', result: true }],
      },
      {
        description: 'Firestore integral float literal 2.0 denies',
        expectation: 'DENY',
        method: 'get',
        path: 'lit20/1',
        functionMocks: [
          { function: 'exists', path: 'items/2.0', result: true },
          { function: 'exists', path: 'items/2', result: true },
        ],
      },
    ]);
    expect(res.success).toBe(true);
    if (!res.success) return;
    expect(res.data.results.map((r) => r.decision)).toEqual(['ALLOW', 'DENY', 'DENY', 'DENY']);
  });
});
