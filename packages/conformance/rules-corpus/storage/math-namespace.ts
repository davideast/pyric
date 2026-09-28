/**
 * ─── Scenario: math-namespace ────────────────────────────────────────────────
 * The `math` namespace in Storage rules: `abs`, `ceil`, `floor`, `round`,
 * `sqrt`, `pow`, and `isNaN`, and the `isInfinite` the rules reference lists
 * but production does not define. Each case is one `allow read` condition on
 * its own path. The cases are the Firestore scenario `time-math-and-casts`
 * math cases (packages/conformance/src/rules-math-cases.ts); production
 * evaluates them the same way in both services.
 *
 * `math.abs()` keeps an int an int and a float a float. `math.ceil()` and
 * `math.floor()` return a float. `math.round()` rounds half up and returns an
 * int. `math.sqrt()` and `math.pow()` return a float and accept ints. Any
 * other argument type is "Unsupported operation error", a wrong argument
 * count is "Incorrect number of arguments", and `math.isInfinite()` is
 * "Function not found error". Each is an error value: it denies through `!`,
 * and `|| true` absorbs it.
 */
import { MATH_CASES } from '../../src/rules-math-cases.ts';
import type { StorageScenarioRecord } from './types.ts';

export const scenario: StorageScenarioRecord = {
  fm: 'STORAGE-MATH-NAMESPACE',
  rationale:
    'Storage rules define the math namespace as Firestore does: abs keeps its type, ceil and floor return a float, round rounds half up to an int, sqrt and pow return a float, and a wrong argument type, a wrong argument count, or math.isInfinite() is an error value that || true absorbs.',
  rules: `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
${MATH_CASES.map(({ key, condition }) => `    match /${key}/{fileId} {
      allow read: if ${condition};
    }`).join('\n')}
  }
}`,
  cases: MATH_CASES.map(({ key, condition, expectation }) => ({
    description: `${condition} → ${expectation}`,
    expectation,
    method: 'get' as const,
    path: `${key}/a.txt`,
    auth: { uid: 'alice' },
    existingResource: { size: 1 },
  })),
};
