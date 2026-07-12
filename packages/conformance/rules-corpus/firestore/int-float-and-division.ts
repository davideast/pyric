/**
 * ─── Scenario 3: int-float-and-division (RULES-B5) ────────────────────────────
 * Production distinguishes int and float as separate types; `/` on two ints
 * is INTEGER division (truncating toward zero) and division by zero is a
 * runtime error (→ deny), not Infinity. Pre-fix the simulator used JS
 * float division for everything.
 */
import type { ScenarioRecord } from './types.ts';

export const scenario: ScenarioRecord = {
  fm: 'RULES-B5',
  rationale: 'int ÷ int truncates toward zero, float division stays float, div-by-zero errors (deny); `is int` / `is float` are distinct types.',
  rules: `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    // int ÷ int truncates: 10 / 4 == 2
    match /intDivTruncAllow/{id} {
      allow create: if 10 / 4 == 2;
    }
    // int ÷ int is NOT float division
    match /intDivNotFloatDeny/{id} {
      allow create: if 10 / 4 == 2.5;
    }
    // truncation is toward zero for negatives: -7 / 2 == -3
    match /negIntDivAllow/{id} {
      allow create: if -7 / 2 == -3;
    }
    // float division: 10.0 / 4.0 == 2.5
    match /floatDivAllow/{id} {
      allow create: if 10.0 / 4.0 == 2.5;
    }
    // mixed int/float promotes to float: 10 / 4.0 == 2.5
    match /mixedDivAllow/{id} {
      allow create: if 10 / 4.0 == 2.5;
    }
    // integer modulo: 10 % 3 == 1
    match /modAllow/{id} {
      allow create: if 10 % 3 == 1;
    }
    // division by zero is an error → DENY (not Infinity)
    match /divByZeroDeny/{id} {
      allow create: if 10 / 0 == 0;
    }
    // div-by-zero error absorbed by || true (RULES-B3 interplay) → ALLOW
    match /divByZeroAbsorbAllow/{id} {
      allow create: if 10 / 0 == 0 || true;
    }
    // wire int payload satisfies "is int", not float
    match /isIntAllow/{id} {
      allow create: if request.resource.data.n is int
        && !(request.resource.data.n is float);
    }
    // wire float payload satisfies "is float", not int
    match /isFloatAllow/{id} {
      allow create: if request.resource.data.x is float
        && !(request.resource.data.x is int);
    }
  }
}`,
  cases: [
    {
      description: '10 / 4 == 2 (integer truncation) ALLOW',
      expectation: 'ALLOW',
      method: 'create',
      path: 'intDivTruncAllow/d1',
      auth: { uid: 'alice' },
      data: { _: 1 },
    },
    {
      description: '10 / 4 == 2.5 (float result from int operands) DENY',
      expectation: 'DENY',
      method: 'create',
      path: 'intDivNotFloatDeny/d2',
      auth: { uid: 'alice' },
      data: { _: 1 },
    },
    {
      description: '-7 / 2 == -3 (truncation toward zero) ALLOW',
      expectation: 'ALLOW',
      method: 'create',
      path: 'negIntDivAllow/d3',
      auth: { uid: 'alice' },
      data: { _: 1 },
    },
    {
      description: '10.0 / 4.0 == 2.5 (float division) ALLOW',
      expectation: 'ALLOW',
      method: 'create',
      path: 'floatDivAllow/d4',
      auth: { uid: 'alice' },
      data: { _: 1 },
    },
    {
      description: '10 / 4.0 == 2.5 (mixed promotes to float) ALLOW',
      expectation: 'ALLOW',
      method: 'create',
      path: 'mixedDivAllow/d5',
      auth: { uid: 'alice' },
      data: { _: 1 },
    },
    {
      description: '10 % 3 == 1 ALLOW',
      expectation: 'ALLOW',
      method: 'create',
      path: 'modAllow/d6',
      auth: { uid: 'alice' },
      data: { _: 1 },
    },
    {
      description: '10 / 0 errors → DENY (not Infinity)',
      expectation: 'DENY',
      method: 'create',
      path: 'divByZeroDeny/d7',
      auth: { uid: 'alice' },
      data: { _: 1 },
    },
    {
      description: '10 / 0 error || true → ALLOW (absorption)',
      expectation: 'ALLOW',
      method: 'create',
      path: 'divByZeroAbsorbAllow/d8',
      auth: { uid: 'alice' },
      data: { _: 1 },
    },
    {
      description: 'integer payload is int / not float ALLOW',
      expectation: 'ALLOW',
      method: 'create',
      path: 'isIntAllow/d9',
      auth: { uid: 'alice' },
      data: { n: 5 },
    },
    {
      description: 'float payload is float / not int ALLOW',
      expectation: 'ALLOW',
      method: 'create',
      path: 'isFloatAllow/d10',
      auth: { uid: 'alice' },
      data: { x: 5.5 },
    },
  ],
  group: 'fix-class',
};
