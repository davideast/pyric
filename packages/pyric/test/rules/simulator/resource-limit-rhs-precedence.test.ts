import { describe, it, expect } from 'bun:test';
import { SimulateFirestoreRulesHandler } from '../../../src/rules/simulator/handler.js';

describe('Firestore Short-Circuit Unabsorbable ResourceLimitError Precedence', () => {
  it('halts request with DENY when 11th document lookup occurs on RHS of && or || with LHS EvalError', () => {
    const rules = `
      rules_version = '2';
      service cloud.firestore {
        match /databases/{database}/documents {
          function doTenLookups() {
            return exists(/databases/$(database)/documents/items/d1)
              && exists(/databases/$(database)/documents/items/d2)
              && exists(/databases/$(database)/documents/items/d3)
              && exists(/databases/$(database)/documents/items/d4)
              && exists(/databases/$(database)/documents/items/d5)
              && exists(/databases/$(database)/documents/items/d6)
              && exists(/databases/$(database)/documents/items/d7)
              && exists(/databases/$(database)/documents/items/d8)
              && exists(/databases/$(database)/documents/items/d9)
              && exists(/databases/$(database)/documents/items/d10);
          }

          match /test/{docId} {
            allow read: if doTenLookups()
              && (resource.data.missingField == true && exists(/databases/$(database)/documents/items/d11));
            allow read: if true;
          }

          match /testOr/{docId} {
            allow read: if doTenLookups()
              && (resource.data.missingField == true || exists(/databases/$(database)/documents/items/d11));
            allow read: if true;
          }
        }
      }
    `;

    const existingDocs: Record<string, Record<string, unknown>> = {
      '/test/doc1': { name: 'example' },
      '/testOr/doc1': { name: 'example' },
    };
    for (let i = 1; i <= 11; i++) {
      existingDocs[`/items/d${i}`] = { val: i };
    }

    const handler = new SimulateFirestoreRulesHandler();
    const res = handler.simulate(
      rules,
      [
        {
          description: '11th lookup on RHS of && with LHS EvalError',
          path: '/test/doc1',
          method: 'get',
          auth: { uid: 'user-1' },
          expectation: 'DENY',
        },
        {
          description: '11th lookup on RHS of || with LHS EvalError',
          path: '/testOr/doc1',
          method: 'get',
          auth: { uid: 'user-1' },
          expectation: 'DENY',
        },
      ],
      {
        getDoc: (path) => {
          if (Object.hasOwn(existingDocs, path)) return existingDocs[path] ?? null;
          const withLeadingSlash = `/${path}`;
          return existingDocs[withLeadingSlash] ?? null;
        },
      },
    );

    expect(res.success).toBe(true);
    if (res.success) {
      expect(res.data.results[0]?.decision).toBe('DENY');
      expect(res.data.results[1]?.decision).toBe('DENY');
    }
  });
});
