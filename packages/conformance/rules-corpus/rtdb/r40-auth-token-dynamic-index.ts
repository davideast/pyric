/**
 * ─── r40-auth-token-dynamic-index ─────────────────────────────────────────
 * Runtime indexing on `auth.token[expr]` when `expr` evaluates to `null`
 * (e.g. `data.child('k').val()` for a missing child) or a number.
 *
 * In JavaScript, `obj[String(null)]` looks up `obj["null"]`. If a token carries
 * a claim literally named `"null": true` (or if `auth.token[null]` is evaluated
 * under `|| true`), production must decide whether indexing by `null` fails the
 * rule or looks up `"null"`.
 */
import type { RtdbScenarioRecord } from './types.ts';

export const scenario: RtdbScenarioRecord = {
  fm: 'rtdb#71',
  rationale:
    'indexing auth.token with a missing child value (null) or a number must match production rather than coercing null to the claim key "null" via String(idx).',
  provenance:
    'Authored from 2026-10-15 bug hunt (FUZ-4) to pin runtime auth.token dynamic indexing with null and numeric keys against production. Captured by deploy-observe-restore on 2026-10-15 in observations/rtdb-rules/rules-rtdb-r40-auth-token-dynamic-index.json.',
  rules: JSON.stringify({
    byChild: { '.read': "auth.token[data.child('k').val()] == true" },
    byChildOrTrue: { '.read': "auth.token[data.child('k').val()] == true || true" },
  }),
  cases: [
    {
      description: 'FUZ-4: auth.token[data.child("k").val()] == true with claim "null": true and missing k',
      expectation: 'DENY',
      operation: 'read',
      opPath: '/byChild',
      authPresent: true,
      claims: { null: true },
    },
    {
      description: 'FUZ-4: auth.token[data.child("k").val()] == true || true with missing k',
      expectation: 'DENY',
      operation: 'read',
      opPath: '/byChildOrTrue',
      authPresent: true,
      claims: { ok: true },
    },
    {
      description: 'FUZ-4: auth.token[data.child("k").val()] == true with claim "5": true and numeric k = 5',
      expectation: 'ALLOW',
      operation: 'read',
      opPath: '/byChild',
      authPresent: true,
      claims: { '5': true },
      seed: { '/byChild/k': 5 },
    },
    {
      description: 'FUZ-4: control auth.token[data.child("k").val()] == true with claim "ok": true and string k = "ok"',
      expectation: 'ALLOW',
      operation: 'read',
      opPath: '/byChild',
      authPresent: true,
      claims: { ok: true },
      seed: { '/byChild/k': 'ok' },
    },
  ],
};
