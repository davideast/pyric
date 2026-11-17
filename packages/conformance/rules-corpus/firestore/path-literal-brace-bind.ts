/**
 * Isolated Firestore Rules compile-or-eval probe for `(/a/{x}).bind({'x': '1'})`.
 */
import type { ScenarioRecord } from './types.ts';

export const scenario: ScenarioRecord = {
  group: 'fix-class',
  pendingRowLink: true,
  allowCompileError: true,
  fm: 'Path literal brace placeholder with bind()',
  rationale:
    'Pins whether Firestore Rules compiles or rejects (/a/{x}).bind({\'x\': \'1\'}) in an expression path literal, and records the runtime verdict if compiled.',
  rules: `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
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
