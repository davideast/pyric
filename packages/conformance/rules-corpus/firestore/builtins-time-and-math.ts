/**
 * ─── Scenario 1: builtins-time-and-math ────────────────────────────────────────
 * Targets FM3 (missing builtins). Rules only use built-in functions on
 * literal arguments (no request.time), so production should evaluate them
 * deterministically. The simulator's evaluator (evaluator.ts:256-273) has
 * no entries for math.* / timestamp.* / duration.* — they parse as method
 * calls on a namespace identifier that resolves to `undefined` and throws.
 * The throw is caught at handler.ts:126 and counted as deny, so every
 * ALLOW-expectation case in this scenario should be reported as SIM_BUG.
 */
import type { ScenarioRecord } from './types.ts';

export const scenario: ScenarioRecord = {
  fm: 'FM3',
  rationale: 'Simulator throws on math.*, timestamp.*, duration.* — agent rules using these silently deny in the simulator while production evaluates them.',
  rules: `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    // 1. math.abs() — bounded delta validation.
    match /scoresAllow/{id} {
      allow create: if request.auth != null
        && math.abs(request.resource.data.delta) <= 100;
    }
    match /scoresDeny/{id} {
      allow create: if request.auth != null
        && math.abs(request.resource.data.delta) <= 100;
    }

    // 2. math.ceil() — round-up bound check.
    match /pricingAllow/{id} {
      allow create: if request.auth != null
        && math.ceil(request.resource.data.price) <= 100;
    }
    match /pricingDeny/{id} {
      allow create: if request.auth != null
        && math.ceil(request.resource.data.price) <= 100;
    }

    // 3. timestamp.date() — pure literal comparison, no request.time.
    match /datesAllow/{id} {
      allow create: if request.auth != null
        && timestamp.date(2099, 1, 1) > timestamp.date(2025, 1, 1);
    }
    match /datesDeny/{id} {
      allow create: if request.auth != null
        && timestamp.date(2025, 1, 1) > timestamp.date(2099, 1, 1);
    }

    // 4. duration.value() — pure duration comparison, no request.time.
    match /durAllow/{id} {
      allow create: if request.auth != null
        && duration.value(2, 'h') > duration.value(1, 'h');
    }
    match /durDeny/{id} {
      allow create: if request.auth != null
        && duration.value(1, 'h') > duration.value(2, 'h');
    }
  }
}`,
  cases: [
    // math.abs
    {
      description: 'math.abs(-75) <= 100 → ALLOW',
      expectation: 'ALLOW',
      method: 'create',
      path: 'scoresAllow/s1',
      auth: { uid: 'alice' },
      data: { delta: -75 },
    },
    {
      description: 'math.abs(200) <= 100 → DENY',
      expectation: 'DENY',
      method: 'create',
      path: 'scoresDeny/s2',
      auth: { uid: 'alice' },
      data: { delta: 200 },
    },

    // math.ceil
    {
      description: 'math.ceil(99.3) = 100 <= 100 → ALLOW',
      expectation: 'ALLOW',
      method: 'create',
      path: 'pricingAllow/p1',
      auth: { uid: 'alice' },
      data: { price: 99.3 },
    },
    {
      description: 'math.ceil(100.1) = 101 <= 100 → DENY',
      expectation: 'DENY',
      method: 'create',
      path: 'pricingDeny/p2',
      auth: { uid: 'alice' },
      data: { price: 100.1 },
    },

    // timestamp.date — pure literal comparison
    {
      description: 'timestamp.date(2099,1,1) > timestamp.date(2025,1,1) → ALLOW',
      expectation: 'ALLOW',
      method: 'create',
      path: 'datesAllow/d1',
      auth: { uid: 'alice' },
      data: { _: 1 },
    },
    {
      description: 'timestamp.date(2025,1,1) > timestamp.date(2099,1,1) → DENY',
      expectation: 'DENY',
      method: 'create',
      path: 'datesDeny/d2',
      auth: { uid: 'alice' },
      data: { _: 1 },
    },

    // duration.value — pure duration comparison
    {
      description: "duration.value(2,'h') > duration.value(1,'h') → ALLOW",
      expectation: 'ALLOW',
      method: 'create',
      path: 'durAllow/u1',
      auth: { uid: 'alice' },
      data: { _: 1 },
    },
    {
      description: "duration.value(1,'h') > duration.value(2,'h') → DENY",
      expectation: 'DENY',
      method: 'create',
      path: 'durDeny/u2',
      auth: { uid: 'alice' },
      data: { _: 1 },
    },
  ],
  group: 'stress',
};
