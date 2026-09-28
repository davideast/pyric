/**
 * ─── Scenario 3: int-float-and-division (RULES-B5) ────────────────────────────
 * Production distinguishes int and float as separate types; `/` on two ints
 * is INTEGER division (truncating toward zero) and division by zero is a
 * runtime error (→ deny), not Infinity. Pre-fix the simulator used JS
 * float division for everything.
 *
 * The `isNumber` and `intFloatOrder` matches show `is number` holds for an
 * int and a float and not for a string or null, and `>` orders an int and a
 * float by value, with a string beside an int as an error.
 */
import type { ScenarioRecord } from './types.ts';

export const scenario: ScenarioRecord = {
  fm: 'RULES-B5',
  rationale: 'int ÷ int truncates toward zero, float division stays float, div-by-zero errors (deny); `is int` / `is float` are distinct types; `is number` holds for both; `>` orders an int and a float by value.',
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
    // "is number" holds for an int and a float payload, not a string or null
    match /isNumber/{id} {
      allow create: if request.resource.data.v is number;
    }
    // ordering compares an int and a float by value, in both directions
    match /intFloatOrder/{id} {
      allow update: if request.resource.data.v > resource.data.v;
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
    ...([
      ['int payload is number ALLOW', 'ALLOW', 5],
      ['float payload is number ALLOW', 'ALLOW', 5.5],
      ['string payload is not number DENY', 'DENY', '5'],
      ['null payload is not number DENY', 'DENY', null],
    ] as const).map(([description, expectation, v], i) => ({
      description, expectation, method: 'create' as const,
      path: `isNumber/n${i + 1}`, auth: { uid: 'alice' },
      data: { v },
    })),
    ...([
      ['float 10.5 > int 10 ALLOW', 'ALLOW', 10, 10.5],
      ['int 10 > float 9.5 ALLOW', 'ALLOW', 9.5, 10],
      ['float 9.5 > int 10 is false DENY', 'DENY', 10, 9.5],
      ['string > int is an error DENY', 'DENY', 10, '11'],
    ] as const).map(([description, expectation, before, after], i) => ({
      description, expectation, method: 'update' as const,
      path: `intFloatOrder/o${i + 1}`, auth: { uid: 'alice' },
      resource: { v: before },
      data: { v: after },
    })),
  ],
  group: 'fix-class',
};
