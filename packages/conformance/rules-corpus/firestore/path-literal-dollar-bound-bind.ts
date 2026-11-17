/**
 * Isolated Firestore Rules compile-or-eval probe for `(/a/$(x)).bind({'x': '1'})`
 * when `x` is bound as a wildcard in the enclosing `match` path.
 */
import type { ScenarioRecord } from './types.ts';

export const scenario: ScenarioRecord = {
  group: 'fix-class',
  pendingRowLink: true,
  allowCompileError: true,
  fm: 'Path literal bound $(x) interpolation with bind()',
  rationale:
    'Pins whether (/a/$(x)).bind({\'x\': \'1\'}) substitutes the match wildcard x (\'orig\') at literal evaluation or rebinds $(x) to \'1\'.',
  rules: `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /items/{x} {
      allow get: if (/a/$(x)).bind({'x': '1'}) == path('/a/1');
    }
  }
}`,
  cases: [
    {
      description: "(/a/$(x)).bind({'x': '1'}) == path('/a/1') with wildcard x='orig'",
      expectation: 'DENY',
      method: 'get',
      path: 'items/orig',
    },
  ],
};
