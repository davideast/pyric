/**
 * ─── Scenario: ordering-operand-types ────────────────────────────────────────
 * `<`, `>`, `<=`, and `>=` over operand pairs of different types in Storage
 * rules, and `==` and `!=` over the same pairs. Each ordering case is written
 * so that a `false` result and an error value produce different verdicts:
 * the comparison is negated with `!`, joined with `|| true`, or joined with
 * `&& false` under a negation. Operands come from path variables,
 * `resource.size`, `resource.metadata`, `request.time`, and `split()` as well
 * as literals, so the pair is evaluated at request time.
 */
import type { StorageScenarioRecord } from './types.ts';

const existing = { size: 3, contentType: 'text/plain', metadata: { k: 'v' } };
const requestTime = '2025-06-15T13:45:30.250Z';

export const scenario: StorageScenarioRecord = {
  fm: 'Coverage: ordering operand types',
  rationale:
    'Int and float order by value and strings order lexicographically; an ordering comparison of any other operand pair is either an ordering or an error value, and equality across types is either false or an error value. Negation, || true, and && false tell the outcomes apart.',
  rules: `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /intFloat/{fileId} {
      allow read: if resource.size < 3.5 && 2.5 <= resource.size && resource.size >= 3;
    }
    match /stringString/{fileId} {
      allow read: if fileId < 'b' && fileId >= 'a';
    }
    match /intString/{fileId} {
      allow read: if resource.size < fileId;
    }
    match /intStringNot/{fileId} {
      allow read: if !(resource.size < fileId);
    }
    match /stringIntNot/{fileId} {
      allow read: if !(fileId >= resource.size);
    }
    match /stringIntGtNot/{fileId} {
      allow read: if !(fileId > 2);
    }
    match /intStringOr/{fileId} {
      allow read: if (resource.size < fileId) || true;
    }
    match /intStringAndFalseNot/{fileId} {
      allow read: if !((resource.size < fileId) && false);
    }
    match /intStringAndTrue/{fileId} {
      allow read: if !((resource.size < fileId) && true);
    }
    match /literalIntStringNot/{fileId} {
      allow read: if !(1 < 'a');
    }
    match /literalStringIntNot/{fileId} {
      allow read: if !('a' >= 2);
    }
    match /boolLt/{fileId} {
      allow read: if false < (fileId == 'a.txt');
    }
    match /boolLtNot/{fileId} {
      allow read: if !((fileId == 'a.txt') < false);
    }
    match /boolIntNot/{fileId} {
      allow read: if !((fileId == 'a.txt') < resource.size);
    }
    match /timestampIntNot/{fileId} {
      allow read: if !(request.time > resource.size);
    }
    match /intTimestampNot/{fileId} {
      allow read: if !(resource.size <= request.time);
    }
    match /listList/{fileId} {
      allow read: if fileId.split('[.]') < ['z'];
    }
    match /listListNot/{fileId} {
      allow read: if !(fileId.split('[.]') < ['z']);
    }
    match /mapMapNot/{fileId} {
      allow read: if !(resource.metadata < {'k': 'w'});
    }
    match /nullIntNot/{fileId} {
      allow read: if !(resource.size < null);
    }
    match /intStringEq/{fileId} {
      allow read: if resource.size == fileId;
    }
    match /intStringNeq/{fileId} {
      allow read: if resource.size != fileId;
    }
    match /intStringEqNot/{fileId} {
      allow read: if !(resource.size == fileId);
    }
    match /literalIntStringNeq/{fileId} {
      allow read: if 1 != '1';
    }
    match /boolIntNeq/{fileId} {
      allow read: if (fileId == 'a.txt') != 1;
    }
    match /timestampIntNeq/{fileId} {
      allow read: if request.time != resource.size;
    }
    match /listMapNeq/{fileId} {
      allow read: if fileId.split('[.]') != resource.metadata;
    }
    match /nullIntNeq/{fileId} {
      allow read: if null != resource.size;
    }
  }
}`,
  cases: [
    {
      description: 'resource.size < 3.5 && 2.5 <= resource.size && resource.size >= 3 (int and float) → ALLOW',
      expectation: 'ALLOW',
      method: 'get',
      path: 'intFloat/a.txt',
      auth: { uid: 'alice' },
      existingResource: existing,
    },
    {
      description: "fileId < 'b' && fileId >= 'a' (string and string) → ALLOW",
      expectation: 'ALLOW',
      method: 'get',
      path: 'stringString/a.txt',
      auth: { uid: 'alice' },
      existingResource: existing,
    },
    {
      description: 'resource.size < fileId (int < string) → DENY',
      expectation: 'DENY',
      method: 'get',
      path: 'intString/a.txt',
      auth: { uid: 'alice' },
      existingResource: existing,
    },
    {
      description: '!(resource.size < fileId) (int < string) → DENY',
      expectation: 'DENY',
      method: 'get',
      path: 'intStringNot/a.txt',
      auth: { uid: 'alice' },
      existingResource: existing,
    },
    {
      description: '!(fileId >= resource.size) (string >= int) → DENY',
      expectation: 'DENY',
      method: 'get',
      path: 'stringIntNot/a.txt',
      auth: { uid: 'alice' },
      existingResource: existing,
    },
    {
      description: '!(fileId > 2) (string > int literal) → DENY',
      expectation: 'DENY',
      method: 'get',
      path: 'stringIntGtNot/a.txt',
      auth: { uid: 'alice' },
      existingResource: existing,
    },
    {
      description: '(resource.size < fileId) || true absorbs the error → ALLOW',
      expectation: 'ALLOW',
      method: 'get',
      path: 'intStringOr/a.txt',
      auth: { uid: 'alice' },
      existingResource: existing,
    },
    {
      description: '!((resource.size < fileId) && false) absorbs the error → ALLOW',
      expectation: 'ALLOW',
      method: 'get',
      path: 'intStringAndFalseNot/a.txt',
      auth: { uid: 'alice' },
      existingResource: existing,
    },
    {
      description: '!((resource.size < fileId) && true) keeps the error → DENY',
      expectation: 'DENY',
      method: 'get',
      path: 'intStringAndTrue/a.txt',
      auth: { uid: 'alice' },
      existingResource: existing,
    },
    {
      description: "!(1 < 'a') (int < string literals) → DENY",
      expectation: 'DENY',
      method: 'get',
      path: 'literalIntStringNot/a.txt',
      auth: { uid: 'alice' },
      existingResource: existing,
    },
    {
      description: "!('a' >= 2) (string >= int literals) → DENY",
      expectation: 'DENY',
      method: 'get',
      path: 'literalStringIntNot/a.txt',
      auth: { uid: 'alice' },
      existingResource: existing,
    },
    {
      description: "false < (fileId == 'a.txt') (bool < bool) → DENY",
      expectation: 'DENY',
      method: 'get',
      path: 'boolLt/a.txt',
      auth: { uid: 'alice' },
      existingResource: existing,
    },
    {
      description: "!((fileId == 'a.txt') < false) (bool < bool) → DENY",
      expectation: 'DENY',
      method: 'get',
      path: 'boolLtNot/a.txt',
      auth: { uid: 'alice' },
      existingResource: existing,
    },
    {
      description: "!((fileId == 'a.txt') < resource.size) (bool < int) → DENY",
      expectation: 'DENY',
      method: 'get',
      path: 'boolIntNot/a.txt',
      auth: { uid: 'alice' },
      existingResource: existing,
    },
    {
      description: '!(request.time > resource.size) (timestamp > int) → DENY',
      expectation: 'DENY',
      method: 'get',
      path: 'timestampIntNot/a.txt',
      auth: { uid: 'alice' },
      existingResource: existing,
      requestTime,
    },
    {
      description: '!(resource.size <= request.time) (int <= timestamp) → DENY',
      expectation: 'DENY',
      method: 'get',
      path: 'intTimestampNot/a.txt',
      auth: { uid: 'alice' },
      existingResource: existing,
      requestTime,
    },
    {
      description: "fileId.split('[.]') < ['z'] (list < list) → DENY",
      expectation: 'DENY',
      method: 'get',
      path: 'listList/a.txt',
      auth: { uid: 'alice' },
      existingResource: existing,
    },
    {
      description: "!(fileId.split('[.]') < ['z']) (list < list) → DENY",
      expectation: 'DENY',
      method: 'get',
      path: 'listListNot/a.txt',
      auth: { uid: 'alice' },
      existingResource: existing,
    },
    {
      description: "!(resource.metadata < {'k': 'w'}) (map < map) → DENY",
      expectation: 'DENY',
      method: 'get',
      path: 'mapMapNot/a.txt',
      auth: { uid: 'alice' },
      existingResource: existing,
    },
    {
      description: '!(resource.size < null) (int < null) → DENY',
      expectation: 'DENY',
      method: 'get',
      path: 'nullIntNot/a.txt',
      auth: { uid: 'alice' },
      existingResource: existing,
    },
    {
      description: 'resource.size == fileId (int == string) → DENY',
      expectation: 'DENY',
      method: 'get',
      path: 'intStringEq/a.txt',
      auth: { uid: 'alice' },
      existingResource: existing,
    },
    {
      description: 'resource.size != fileId (int != string) → ALLOW',
      expectation: 'ALLOW',
      method: 'get',
      path: 'intStringNeq/a.txt',
      auth: { uid: 'alice' },
      existingResource: existing,
    },
    {
      description: '!(resource.size == fileId) (int == string) → ALLOW',
      expectation: 'ALLOW',
      method: 'get',
      path: 'intStringEqNot/a.txt',
      auth: { uid: 'alice' },
      existingResource: existing,
    },
    {
      description: "1 != '1' (int != string literals) → ALLOW",
      expectation: 'ALLOW',
      method: 'get',
      path: 'literalIntStringNeq/a.txt',
      auth: { uid: 'alice' },
      existingResource: existing,
    },
    {
      description: "(fileId == 'a.txt') != 1 (bool != int) → ALLOW",
      expectation: 'ALLOW',
      method: 'get',
      path: 'boolIntNeq/a.txt',
      auth: { uid: 'alice' },
      existingResource: existing,
    },
    {
      description: 'request.time != resource.size (timestamp != int) → ALLOW',
      expectation: 'ALLOW',
      method: 'get',
      path: 'timestampIntNeq/a.txt',
      auth: { uid: 'alice' },
      existingResource: existing,
      requestTime,
    },
    {
      description: "fileId.split('[.]') != resource.metadata (list != map) → ALLOW",
      expectation: 'ALLOW',
      method: 'get',
      path: 'listMapNeq/a.txt',
      auth: { uid: 'alice' },
      existingResource: existing,
    },
    {
      description: 'null != resource.size (null != int) → ALLOW',
      expectation: 'ALLOW',
      method: 'get',
      path: 'nullIntNeq/a.txt',
      auth: { uid: 'alice' },
      existingResource: existing,
    },
  ],
};
