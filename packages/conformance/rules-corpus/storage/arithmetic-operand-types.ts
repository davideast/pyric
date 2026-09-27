/**
 * ─── Scenario: arithmetic-operand-types ──────────────────────────────────────
 * `+` over every operand pair in Storage rules, plus `-`, `*`, `/`, and `%`
 * on operands that are not numbers. Production's `+` accepts int + int,
 * float + float (int + float promotes), string + string, and the duration and
 * timestamp pairs. Every other pair, list + list included, is "Unsupported
 * operation error. Received: <left> + <right>.", an error value: it denies
 * through `!=` and `!`, and `|| true` absorbs it. Operands come from path
 * variables, `resource.size`, and `split()` as well as literals, so the
 * ruleset compiles and the pair is evaluated at request time.
 */
import type { StorageScenarioRecord } from './types.ts';

const existing = { size: 3, contentType: 'text/plain', metadata: { k: 'v' } };

export const scenario: StorageScenarioRecord = {
  fm: 'Coverage: + and arithmetic operand types',
  rationale:
    'String + string concatenates and int + float promotes, while list + list, string + int, int + string, list + string, map + map, and non-numeric -, *, /, % are error values that deny through != and ! and absorb through || true.',
  rules: `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /users/{uid}/{file} {
      allow create: if 'users/' + uid + '/' + file == 'users/alice/a.txt';
    }
    match /stringEq/{fileId} {
      allow read: if fileId + '/x' == 'a.txt/x' && 'a' + 'b' == 'ab';
    }
    match /stringNeq/{fileId} {
      allow read: if 'users/' + request.auth.uid != 'users/alice';
    }
    match /intFloat/{fileId} {
      allow read: if resource.size + 1.5 == 4.5 && (resource.size + 1.5) is float
        && 1.5 + 1 == 2.5 && (resource.size + 1) is int;
    }
    match /listListEq/{fileId} {
      allow read: if [1] + [2] == [1, 2];
    }
    match /listListNeq/{fileId} {
      allow read: if fileId.split('[.]') + ['z'] != ['zzz'];
    }
    match /listListOr/{fileId} {
      allow read: if ([1] + [2] == [1, 2]) || true;
    }
    match /stringIntNeq/{fileId} {
      allow read: if fileId + resource.size != 'zzz';
    }
    match /stringIntNot/{fileId} {
      allow read: if !(fileId + resource.size == 'zzz');
    }
    match /stringIntOr/{fileId} {
      allow read: if (fileId + resource.size == 'zzz') || true;
    }
    match /stringIntLiteral/{fileId} {
      allow read: if 'a' + 1 != 'x';
    }
    match /intStringNeq/{fileId} {
      allow read: if resource.size + fileId != 'zzz';
    }
    match /intStringOr/{fileId} {
      allow read: if (resource.size + fileId == 'zzz') || true;
    }
    match /listStringNeq/{fileId} {
      allow read: if fileId.split('[.]') + fileId != ['zzz'];
    }
    match /stringListNeq/{fileId} {
      allow read: if fileId + fileId.split('[.]') != 'zzz';
    }
    match /mapMapNeq/{fileId} {
      allow read: if resource.metadata + {'b': 'c'} != {};
    }
    match /subStringNeq/{fileId} {
      allow read: if fileId - 'a' != 'zzz';
    }
    match /mulStringNeq/{fileId} {
      allow read: if fileId * 2 != 'zzz';
    }
    match /divStringNeq/{fileId} {
      allow read: if fileId / fileId != 1;
    }
    match /modStringNeq/{fileId} {
      allow read: if fileId % fileId != 1;
    }
  }
}`,
  cases: [
    {
      description: "'users/' + uid + '/' + file == 'users/alice/a.txt' on create → ALLOW",
      expectation: 'ALLOW',
      method: 'create',
      path: 'users/alice/a.txt',
      auth: { uid: 'alice' },
      resource: { size: 2, contentType: 'text/plain' },
    },
    {
      description: 'string + string concatenates (binding and literal) → ALLOW',
      expectation: 'ALLOW',
      method: 'get',
      path: 'stringEq/a.txt',
      auth: { uid: 'alice' },
      existingResource: existing,
    },
    {
      description: "'users/' + request.auth.uid != 'users/alice' → DENY",
      expectation: 'DENY',
      method: 'get',
      path: 'stringNeq/a.txt',
      auth: { uid: 'alice' },
      existingResource: existing,
    },
    {
      description: 'int + float promotes to float; int + int stays int → ALLOW',
      expectation: 'ALLOW',
      method: 'get',
      path: 'intFloat/a.txt',
      auth: { uid: 'alice' },
      existingResource: existing,
    },
    {
      description: '[1] + [2] == [1, 2] (list + list is an error) → DENY',
      expectation: 'DENY',
      method: 'get',
      path: 'listListEq/a.txt',
      auth: { uid: 'alice' },
      existingResource: existing,
    },
    {
      description: "split() + ['z'] != ['zzz'] (list + list is an error) → DENY",
      expectation: 'DENY',
      method: 'get',
      path: 'listListNeq/a.txt',
      auth: { uid: 'alice' },
      existingResource: existing,
    },
    {
      description: '([1] + [2] == [1, 2]) || true absorbs the error → ALLOW',
      expectation: 'ALLOW',
      method: 'get',
      path: 'listListOr/a.txt',
      auth: { uid: 'alice' },
      existingResource: existing,
    },
    {
      description: "fileId + resource.size != 'zzz' (string + int) → DENY",
      expectation: 'DENY',
      method: 'get',
      path: 'stringIntNeq/a.txt',
      auth: { uid: 'alice' },
      existingResource: existing,
    },
    {
      description: "!(fileId + resource.size == 'zzz') (string + int) → DENY",
      expectation: 'DENY',
      method: 'get',
      path: 'stringIntNot/a.txt',
      auth: { uid: 'alice' },
      existingResource: existing,
    },
    {
      description: "(fileId + resource.size == 'zzz') || true absorbs the error → ALLOW",
      expectation: 'ALLOW',
      method: 'get',
      path: 'stringIntOr/a.txt',
      auth: { uid: 'alice' },
      existingResource: existing,
    },
    {
      description: "'a' + 1 != 'x' (string + int literal compiles, errors) → DENY",
      expectation: 'DENY',
      method: 'get',
      path: 'stringIntLiteral/a.txt',
      auth: { uid: 'alice' },
      existingResource: existing,
    },
    {
      description: "resource.size + fileId != 'zzz' (int + string) → DENY",
      expectation: 'DENY',
      method: 'get',
      path: 'intStringNeq/a.txt',
      auth: { uid: 'alice' },
      existingResource: existing,
    },
    {
      description: "(resource.size + fileId == 'zzz') || true absorbs the error → ALLOW",
      expectation: 'ALLOW',
      method: 'get',
      path: 'intStringOr/a.txt',
      auth: { uid: 'alice' },
      existingResource: existing,
    },
    {
      description: "split() + fileId != ['zzz'] (list + string) → DENY",
      expectation: 'DENY',
      method: 'get',
      path: 'listStringNeq/a.txt',
      auth: { uid: 'alice' },
      existingResource: existing,
    },
    {
      description: "fileId + split() != 'zzz' (string + list) → DENY",
      expectation: 'DENY',
      method: 'get',
      path: 'stringListNeq/a.txt',
      auth: { uid: 'alice' },
      existingResource: existing,
    },
    {
      description: "resource.metadata + {'b': 'c'} != {} (map + map) → DENY",
      expectation: 'DENY',
      method: 'get',
      path: 'mapMapNeq/a.txt',
      auth: { uid: 'alice' },
      existingResource: existing,
    },
    {
      description: "fileId - 'a' != 'zzz' (string - string) → DENY",
      expectation: 'DENY',
      method: 'get',
      path: 'subStringNeq/a.txt',
      auth: { uid: 'alice' },
      existingResource: existing,
    },
    {
      description: "fileId * 2 != 'zzz' (string * int) → DENY",
      expectation: 'DENY',
      method: 'get',
      path: 'mulStringNeq/a.txt',
      auth: { uid: 'alice' },
      existingResource: existing,
    },
    {
      description: 'fileId / fileId != 1 (string / string) → DENY',
      expectation: 'DENY',
      method: 'get',
      path: 'divStringNeq/a.txt',
      auth: { uid: 'alice' },
      existingResource: existing,
    },
    {
      description: 'fileId % fileId != 1 (string % string) → DENY',
      expectation: 'DENY',
      method: 'get',
      path: 'modStringNeq/a.txt',
      auth: { uid: 'alice' },
      existingResource: existing,
    },
  ],
};
