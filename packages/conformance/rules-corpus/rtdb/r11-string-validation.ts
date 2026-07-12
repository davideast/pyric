/**
 * ─── r11-string-validation ────────────────────────────────────────────────
 * A public handle registry whose every field is checked by a STRING method:
 *   - `display` — 3..32 characters (`.length`);
 *   - `email`   — contains `@`, ends with `.com`, and is already lower-cased
 *                 (`contains` / `endsWith` / `toLowerCase`);
 *   - `slug`    — begins with `u-`, matches the regex literal
 *                 `/^u-[a-z0-9]+$/`, and strips back to the handle key
 *                 (`beginsWith` / `matches` / `replace`);
 *   - `shout`   — the display name upper-cased, the denormalized copy a
 *                 case-insensitive search index needs (`toUpperCase`).
 *
 * SIMULATOR FINDING (`toUpperCase`). Production ACCEPTS this ruleset and
 * ALLOWS the valid handle. The pyric expression validator's STRING_METHODS
 * allow-list omitted `toUpperCase` (and the evaluator's string dispatch had no
 * arm for it), so the simulator could not evaluate the `shout` rule and
 * abstained — an `unsupported` `.validate`, read as DENY, against production's
 * ALLOW. `toUpperCase` is documented RTDB rules surface and production proves
 * it: the allow-list and the evaluator were corrected rather than the scenario
 * weakened (see packages/pyric/src/database/grammar/validator.ts and
 * .../simulator.ts).
 *
 * Expectations are the PRODUCTION verdicts recorded by the deploy-observe-
 * restore capture (observations/rtdb-rules/rules-rtdb-r11-string-validation.json).
 */
import type { RtdbScenarioRecord } from './types.ts';

export const scenario: RtdbScenarioRecord = {
  fm: 'rtdb#71',
  rationale:
    'every string method the RTDB rules language exposes decides one field of a handle record — length, contains, endsWith, toLowerCase, beginsWith, matches against a regex literal, replace and toUpperCase — so a per-field deny pins each method against production.',
  provenance:
    'Authored to exercise the rtdb string methods and the regex-literal semantic, then captured against the live oracle database; expectations are the captured production verdicts. The valid-handle case is what proved production supports `toUpperCase` where the simulator did not.',
  rules: JSON.stringify({
    $handle: {
      '.read': 'auth != null',
      '.write': 'auth != null',
      '.validate': "newData.hasChildren(['display', 'email', 'slug', 'shout'])",
      display: {
        '.validate': 'newData.isString() && newData.val().length >= 3 && newData.val().length <= 32',
      },
      email: {
        '.validate':
          "newData.val().contains('@') && newData.val().endsWith('.com') && newData.val() === newData.val().toLowerCase()",
      },
      slug: {
        '.validate':
          "newData.val().beginsWith('u-') && newData.val().matches(/^u-[a-z0-9]+$/) && newData.val().replace('u-', '') === $handle",
      },
      shout: {
        '.validate': "newData.val() === newData.parent().child('display').val().toUpperCase()",
      },
    },
  }),
  cases: [
    {
      description: 'valid handle allowed',
      expectation: 'ALLOW',
      operation: 'write',
      opPath: '/alice',
      authPresent: true,
      newData: { display: 'Alice', email: 'alice@example.com', slug: 'u-alice', shout: 'ALICE' },
    },
    {
      description: 'display shorter than three characters denied (length)',
      expectation: 'DENY',
      operation: 'write',
      opPath: '/alice',
      authPresent: true,
      newData: { display: 'Al', email: 'alice@example.com', slug: 'u-alice', shout: 'AL' },
    },
    {
      description: 'email without an at-sign denied (contains)',
      expectation: 'DENY',
      operation: 'write',
      opPath: '/alice',
      authPresent: true,
      newData: { display: 'Alice', email: 'alice.example.com', slug: 'u-alice', shout: 'ALICE' },
    },
    {
      description: 'email not ending in .com denied (endsWith)',
      expectation: 'DENY',
      operation: 'write',
      opPath: '/alice',
      authPresent: true,
      newData: { display: 'Alice', email: 'alice@example.org', slug: 'u-alice', shout: 'ALICE' },
    },
    {
      description: 'email not already lower-cased denied (toLowerCase)',
      expectation: 'DENY',
      operation: 'write',
      opPath: '/alice',
      authPresent: true,
      newData: { display: 'Alice', email: 'Alice@example.com', slug: 'u-alice', shout: 'ALICE' },
    },
    {
      description: 'slug without the u- prefix denied (beginsWith)',
      expectation: 'DENY',
      operation: 'write',
      opPath: '/alice',
      authPresent: true,
      newData: { display: 'Alice', email: 'alice@example.com', slug: 'alice', shout: 'ALICE' },
    },
    {
      description: 'slug with an illegal character denied (regex literal)',
      expectation: 'DENY',
      operation: 'write',
      opPath: '/alice',
      authPresent: true,
      newData: { display: 'Alice', email: 'alice@example.com', slug: 'u-alice!', shout: 'ALICE' },
    },
    {
      description: 'slug stripping to a different handle denied (replace)',
      expectation: 'DENY',
      operation: 'write',
      opPath: '/alice',
      authPresent: true,
      newData: { display: 'Alice', email: 'alice@example.com', slug: 'u-bob', shout: 'ALICE' },
    },
    {
      description: 'shout not the upper-cased display denied (toUpperCase)',
      expectation: 'DENY',
      operation: 'write',
      opPath: '/alice',
      authPresent: true,
      newData: { display: 'Alice', email: 'alice@example.com', slug: 'u-alice', shout: 'Alice' },
    },
    {
      description: 'missing shout denied (hasChildren)',
      expectation: 'DENY',
      operation: 'write',
      opPath: '/alice',
      authPresent: true,
      newData: { display: 'Alice', email: 'alice@example.com', slug: 'u-alice' },
    },
    { description: 'signed-in read of a handle', expectation: 'ALLOW', operation: 'read', opPath: '/alice', authPresent: true },
    { description: 'anonymous read of a handle denied', expectation: 'DENY', operation: 'read', opPath: '/alice', authPresent: false },
  ],
};
