import { describe, expect, test } from 'bun:test';
import { firestoreRules } from '../../../src/index.js';
import { evaluateStorageRules } from '../../../src/storage/rules-evaluator.js';
import { parseStorageRules } from '../../../src/storage/rules.js';

describe('StoragePath.equals segment-wise equality parity with Firestore Path', () => {
  test('rejects slashed segment injection against multi-segment path literals while matching identical slashed segments', () => {
    const fsDeny = firestoreRules(
      [
        "rules_version = '2';",
        'service cloud.firestore {',
        '  match /databases/{database}/documents {',
        '    match /items/{id} {',
        '      allow create: if /orgs/$(request.resource.data.seg)/u1 == /orgs/acme/admins/u1;',
        '    }',
        '  }',
        '}',
      ].join('\n'),
    ).simulate([
      {
        description: 'slashed segment must not equal multi-segment literal',
        expectation: 'DENY',
        method: 'create',
        path: 'items/i1',
        auth: { uid: 'u1' },
        data: { seg: 'acme/admins' },
      },
    ]);

    const stDenyParsed = parseStorageRules(
      [
        "rules_version = '2';",
        'service firebase.storage {',
        '  match /b/{bucket}/o {',
        '    match /items/{id} {',
        '      allow create: if /orgs/$(request.resource.metadata.seg)/u1 == /orgs/acme/admins/u1;',
        '    }',
        '  }',
        '}',
      ].join('\n'),
    );
    const stDeny = evaluateStorageRules(stDenyParsed, {
      request: {
        auth: { uid: 'u1', token: {} },
        method: 'create',
        path: '/b/default-bucket/o/items/i1',
        resource: {
          size: 4,
          contentType: 'text/plain',
          metadata: { seg: 'acme/admins' },
        },
      },
      resource: null,
    });

    expect(fsDeny.cases[0]?.decision).toBe('DENY');
    expect(stDeny.allowed).toBe(false);

    // Bind and same-segment slashed comparisons remain consistent with segment indexing.
    const stParityParsed = parseStorageRules(
      [
        "rules_version = '2';",
        'service firebase.storage {',
        '  match /b/{bucket}/o {',
        '    match /items/{rest=**} {',
        "      allow create: if path('/orgs/{seg}/u1').bind({'seg': 'acme/admins'}) != /orgs/acme/admins/u1",
        "        && path('/orgs/{seg}/u1').bind({'seg': 'acme/admins'}) == /orgs/$(request.resource.metadata.seg)/u1",
        '        && /orgs/$(rest) == /orgs/acme/admins/u1;',
        '    }',
        '  }',
        '}',
      ].join('\n'),
    );
    const stParity = evaluateStorageRules(stParityParsed, {
      request: {
        auth: { uid: 'u1', token: {} },
        method: 'create',
        path: '/b/default-bucket/o/items/acme/admins/u1',
        resource: {
          size: 4,
          contentType: 'text/plain',
          metadata: { seg: 'acme/admins' },
        },
      },
      resource: null,
    });
    expect(stParity.allowed).toBe(true);
  });
});
