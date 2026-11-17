/**
 * Isolated Firestore Rules compile-or-eval probe for `(/a/$(x)).bind({'x': '1'})`
 * when `x` is not bound in the enclosing `match` scope.
 */
import type { ScenarioRecord } from './types.ts';

export const scenario: ScenarioRecord = {
  group: 'fix-class',
  allowCompileError: true,
  fm: 'Path literal unbound $(x) interpolation with bind()',
  rationale:
    'Pins whether Firestore Rules rejects unbound $(x) inside (/a/$(x)).bind({\'x\': \'1\'}) at compile time or evaluates bind() at runtime.',
  rules: `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /items/{id} {
      allow get: if (/a/$(x)).bind({'x': '1'}) == path('/a/1');
    }
  }
}`,
  cases: [
    {
      description: "(/a/$(x)).bind({'x': '1'}) == path('/a/1') with unbound x",
      expectation: 'DENY',
      method: 'get',
      path: 'items/d1',
    },
  ],
};
