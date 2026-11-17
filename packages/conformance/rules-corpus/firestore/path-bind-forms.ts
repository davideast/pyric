/**
 * Cross-engine `Path.bind()` string-path placeholder syntax and value-type
 * probe for Firestore Security Rules (`service cloud.firestore`).
 *
 * Paired 1:1 with `rules-corpus/storage/storage-path-bind-forms.ts`. Path
 * literal `(/a/...).bind(...)` forms live in isolated `allowCompileError: true`
 * sibling scenarios (`path-literal-*-bind.ts`) so a compile-time rejection on
 * any path literal never shadows runtime verdicts on `path(...)` strings.
 */
import type { ScenarioRecord } from './types.ts';

export const scenario: ScenarioRecord = {
  group: 'fix-class',
  pendingRowLink: true,
  fm: 'Path.bind placeholder syntax and value types',
  rationale:
    'Pins how Firestore Rules evaluates Path.bind() on path() strings across {x} and $(x) placeholders plus integer and float map values.',
  rules: `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /stringBrace/{id} {
      allow get: if path('/a/{x}').bind({'x': '1'}) == path('/a/1');
    }
    match /stringDollar/{id} {
      allow get: if path('/a/$(x)').bind({'x': '1'}) == path('/a/1');
    }
    match /floatValue/{id} {
      allow get: if path('/a/{x}').bind({'x': 1.5}) == path('/a/1.5');
    }
    match /intValue/{id} {
      allow get: if path('/a/{x}').bind({'x': 1}) == path('/a/1');
    }
  }
}`,
  cases: [
    {
      description: "path('/a/{x}').bind({'x': '1'}) == path('/a/1')",
      expectation: 'ALLOW',
      method: 'get',
      path: 'stringBrace/d1',
    },
    {
      description: "path('/a/$(x)').bind({'x': '1'}) == path('/a/1')",
      expectation: 'DENY',
      method: 'get',
      path: 'stringDollar/d1',
    },
    {
      description: "path('/a/{x}').bind({'x': 1.5}) == path('/a/1.5')",
      expectation: 'DENY',
      method: 'get',
      path: 'floatValue/d1',
    },
    {
      description: "path('/a/{x}').bind({'x': 1}) == path('/a/1')",
      expectation: 'ALLOW',
      method: 'get',
      path: 'intValue/d1',
    },
  ],
};
