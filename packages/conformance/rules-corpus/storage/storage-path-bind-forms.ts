/**
 * Cross-engine `Path.bind()` placeholder syntax and value-type probe for
 * Firebase Storage Security Rules (`service firebase.storage`).
 *
 * Paired 1:1 with `rules-corpus/firestore/path-bind-forms.ts` so production's
 * treatment of `{x}` vs `$(x)` placeholders, `path(...)` strings vs path
 * literals `(/a/...)`, and non-string map values (`1.5`, `1`) is pinned across
 * both engines.
 */
import type { StorageScenarioRecord } from './types.ts';

export const scenario: StorageScenarioRecord = {
  pendingRowLink: true,
  fm: 'Path.bind placeholder syntax and value types',
  rationale:
    'Pins how Storage Rules evaluates Path.bind() across {x} and $(x) segments in path() strings and path literals, plus integer and float map values.',
  rules: `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /stringBrace/{id} {
      allow get: if path('/a/{x}').bind({'x': '1'}) == path('/a/1');
    }
    match /stringDollar/{id} {
      allow get: if path('/a/$(x)').bind({'x': '1'}) == path('/a/1');
    }
    match /literalBrace/{id} {
      allow get: if (/a/{x}).bind({'x': '1'}) == path('/a/1');
    }
    match /literalDollarUnbound/{id} {
      allow get: if (/a/$(x)).bind({'x': '1'}) == path('/a/1');
    }
    match /literalDollarBound/{x} {
      allow get: if (/a/$(x)).bind({'x': '1'}) == path('/a/1');
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
      description: "(/a/{x}).bind({'x': '1'}) == path('/a/1')",
      expectation: 'ALLOW',
      method: 'get',
      path: 'literalBrace/d1',
    },
    {
      description: "(/a/$(x)).bind({'x': '1'}) == path('/a/1') with unbound x",
      expectation: 'DENY',
      method: 'get',
      path: 'literalDollarUnbound/d1',
    },
    {
      description: "(/a/$(x)).bind({'x': '1'}) == path('/a/1') with wildcard x='orig'",
      expectation: 'DENY',
      method: 'get',
      path: 'literalDollarBound/orig',
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
