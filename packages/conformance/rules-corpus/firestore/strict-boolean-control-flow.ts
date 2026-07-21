/** Production evidence for strict boolean operands in Rules control flow. */
import type { ScenarioRecord } from './types.ts';

export const scenario: ScenarioRecord = {
  fm: 'RULES-B6',
  rationale:
    'Firestore Rules requires boolean operands for &&, ||, and ternary conditions; non-booleans error and deny.',
  rules: `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /nonBoolAndDeny/{id} {
      allow create: if 1 && true;
    }
    match /nonBoolOrDeny/{id} {
      allow create: if false || 1;
    }
    match /nonBoolTernaryDeny/{id} {
      allow create: if 1 ? true : false;
    }
    match /booleanControlAllow/{id} {
      allow create: if true && (false || true) && (true ? true : false);
    }
  }
}`,
  cases: [
    {
      description: 'non-boolean && operand errors → DENY',
      expectation: 'DENY',
      method: 'create',
      path: 'nonBoolAndDeny/d1',
      auth: { uid: 'alice' },
      data: {},
    },
    {
      description: 'non-boolean || operand errors → DENY',
      expectation: 'DENY',
      method: 'create',
      path: 'nonBoolOrDeny/d2',
      auth: { uid: 'alice' },
      data: {},
    },
    {
      description: 'non-boolean ternary condition errors → DENY',
      expectation: 'DENY',
      method: 'create',
      path: 'nonBoolTernaryDeny/d3',
      auth: { uid: 'alice' },
      data: {},
    },
    {
      description: 'boolean control-flow operands evaluate normally → ALLOW',
      expectation: 'ALLOW',
      method: 'create',
      path: 'booleanControlAllow/d4',
      auth: { uid: 'alice' },
      data: {},
    },
  ],
  group: 'fix-class',
};
