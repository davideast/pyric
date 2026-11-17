/**
 * Isolated Storage Rules compile-or-eval probe for `(/a/$(x)).bind({'x': '1'})`
 * when `x` is not bound in the enclosing `match` scope.
 */
import type { StorageScenarioRecord } from './types.ts';

export const scenario: StorageScenarioRecord = {
  pendingRowLink: true,
  allowCompileError: true,
  fm: 'Path literal unbound $(x) interpolation with bind()',
  rationale:
    'Pins whether Storage Rules rejects unbound $(x) inside (/a/$(x)).bind({\'x\': \'1\'}) at compile time or evaluates bind() at runtime.',
  rules: `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
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
