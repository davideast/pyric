/** Production evidence for strict boolean operands and create-time resources. */
import type { ScenarioRecord } from './types.ts';

export const scenario: ScenarioRecord = {
  fm: 'RULES-B6',
  rationale:
    'Firestore Rules requires boolean operands for &&, ||, and ternary conditions, and a boolean allow condition; non-booleans error and deny. On create, resource == null denies while request.resource carries the incoming document.',
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
    match /nonBoolAndErrorDiscriminator/{id} {
      allow create: if (1 && true) || !(1 && true);
    }
    match /nonBoolOrErrorDiscriminator/{id} {
      allow create: if (false || 1) || !(false || 1);
    }
    match /nonBoolTernaryErrorDiscriminator/{id} {
      allow create: if (1 ? true : false) || !(1 ? true : false);
    }
    match /booleanControlAllow/{id} {
      allow create: if true && (false || true) && (true ? true : false);
    }
    match /resourceNullComparison/{id} {
      allow create: if resource == null;
    }
    match /requestResourceData/{id} {
      allow create: if request.resource.data.owner == 'alice';
    }
    // The allow condition itself must be a bool.
    match /allowString/{id} {
      allow create: if 'ab';
    }
    match /allowIntOne/{id} {
      allow create: if 1;
    }
    match /allowIntZero/{id} {
      allow create: if 0;
    }
    match /allowFloat/{id} {
      allow create: if 1.0;
    }
    match /allowNull/{id} {
      allow create: if null;
    }
    match /allowEmptyList/{id} {
      allow create: if [];
    }
    match /allowMap/{id} {
      allow create: if request.resource.data;
    }
    match /allowStringField/{id} {
      allow create: if request.resource.data.owner;
    }
    match /allowTrue/{id} {
      allow create: if true;
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
    {
      description: 'non-boolean && error discriminator → DENY',
      expectation: 'DENY',
      method: 'create',
      path: 'nonBoolAndErrorDiscriminator/d7',
      auth: { uid: 'alice' },
      data: {},
    },
    {
      description: 'non-boolean || error discriminator → DENY',
      expectation: 'DENY',
      method: 'create',
      path: 'nonBoolOrErrorDiscriminator/d8',
      auth: { uid: 'alice' },
      data: {},
    },
    {
      description: 'non-boolean ternary error discriminator → DENY',
      expectation: 'DENY',
      method: 'create',
      path: 'nonBoolTernaryErrorDiscriminator/d9',
      auth: { uid: 'alice' },
      data: {},
    },
    {
      description: 'resource == null on create → DENY',
      expectation: 'DENY',
      method: 'create',
      path: 'resourceNullComparison/d5',
      auth: { uid: 'alice' },
      data: { owner: 'alice' },
    },
    {
      description: 'request.resource has incoming data on create → ALLOW',
      expectation: 'ALLOW',
      method: 'create',
      path: 'requestResourceData/d6',
      auth: { uid: 'alice' },
      data: { owner: 'alice' },
    },
    ...([
      ["allow condition 'ab' (string) is a type error → DENY", 'DENY', 'allowString'],
      ['allow condition 1 (int) is a type error → DENY', 'DENY', 'allowIntOne'],
      ['allow condition 0 (int) is a type error → DENY', 'DENY', 'allowIntZero'],
      ['allow condition 1.0 (float) is a type error → DENY', 'DENY', 'allowFloat'],
      ['allow condition null is a type error → DENY', 'DENY', 'allowNull'],
      ['allow condition [] (list) is a type error → DENY', 'DENY', 'allowEmptyList'],
      ['allow condition request.resource.data (map) is a type error → DENY', 'DENY', 'allowMap'],
      ['allow condition on a string field is a type error → DENY', 'DENY', 'allowStringField'],
      ['allow condition true → ALLOW', 'ALLOW', 'allowTrue'],
    ] as const).map(([description, expectation, match], i) => ({
      description, expectation, method: 'create' as const,
      path: `${match}/d${10 + i}`, auth: { uid: 'alice' },
      data: { owner: 'alice' },
    })),
  ],
  group: 'fix-class',
};
