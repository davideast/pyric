/**
 * Isolated Storage Rules compile-or-eval probe for `(/a/{x}).bind({'x': '1'})`.
 */
import type { StorageScenarioRecord } from './types.ts';

export const scenario: StorageScenarioRecord = {
  pendingRowLink: true,
  allowCompileError: true,
  fm: 'Path literal brace placeholder with bind()',
  rationale:
    'Pins whether Storage Rules compiles or rejects (/a/{x}).bind({\'x\': \'1\'}) in an expression path literal, and records the runtime verdict if compiled.',
  rules: `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /items/{id} {
      allow get: if (/a/{x}).bind({'x': '1'}) == path('/a/1');
    }
  }
}`,
  cases: [
    {
      description: "(/a/{x}).bind({'x': '1'}) == path('/a/1')",
      expectation: 'ALLOW',
      method: 'get',
      path: 'items/d1',
    },
  ],
};
