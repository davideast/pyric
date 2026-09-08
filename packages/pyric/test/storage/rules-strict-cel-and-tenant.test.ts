import { describe, expect, it } from 'bun:test';
import { evaluateStorageRules } from '../../src/storage/sandbox/rules-evaluator.js';
import { parseStorageRules } from '../../src/storage/sandbox/rules.js';

describe('Cloud Storage Rules Soundness & Tenant Normalization (R2 & R3)', () => {
  it('R2: strictly enforces boolean types on allow conditions and ternary predicates (fails closed on non-boolean)', () => {
    const ruleset = parseStorageRules(`
      rules_version = '2';
      service firebase.storage {
        match /b/{bucket}/o {
          match /{allPaths=**} {
            allow read: if request.auth.uid;
            allow write: if ('non-empty-string' ? true : false);
          }
        }
      }
    `);

    const readResult = evaluateStorageRules(ruleset, {
      request: {
        auth: { uid: 'user-123', token: {} },
        method: 'get',
        path: 'b/my-bucket/o/secret.txt',
      },
      resource: null,
    });

    const writeResult = evaluateStorageRules(ruleset, {
      request: {
        auth: { uid: 'user-123', token: {} },
        method: 'write',
        path: 'b/my-bucket/o/secret.txt',
      },
      resource: null,
    });

    expect(readResult.allowed).toBe(false);
    expect(writeResult.allowed).toBe(false);
  });

  it('R3: normalizes top-level tenant into request.auth.token.firebase.tenant while preserving custom claims', () => {
    const ruleset = parseStorageRules(`
      rules_version = '2';
      service firebase.storage {
        match /b/{bucket}/o {
          match /{allPaths=**} {
            allow read: if request.auth.token.firebase.tenant == 'acme-corp'
                        && request.auth.token.role == 'editor';
          }
        }
      }
    `);

    const result = evaluateStorageRules(ruleset, {
      request: {
        auth: { uid: 'user-123', tenant: 'acme-corp', token: { role: 'editor' } },
        method: 'get',
        path: 'b/my-bucket/o/tenant-doc.txt',
      },
      resource: null,
    });

    expect(result.allowed).toBe(true);
  });
});
