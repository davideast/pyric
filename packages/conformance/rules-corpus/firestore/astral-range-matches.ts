/**
 * ─── Scenario: astral-range-matches ──────────────────────────────────────────
 * A class range over characters outside the Basic Multilingual Plane in
 * `matches()`. Production compiles `[😀-😂]` as a range of three code points
 * and `'😀'` matches it (`ar2`). Before #1901 pyric refused the ruleset at
 * load, because it checked the literal as UTF-16 code units, where the range
 * runs backwards; pyric now compiles it and agrees.
 *
 * Found by the 2026-11-03 rules engine defect hunt and captured on
 * 2026-11-04 as `c9b-astral-range-matches`; the rules and case description
 * are the ones sent to production.
 */
import type { ScenarioRecord } from './types.ts';

export const scenario: ScenarioRecord = {
  group: 'fix-class',
  fm: "Coverage: astral class ranges in matches()",
  rationale: "A class range over emoji (`[😀-😂]`) compiles and matches by code point in matches(), as production does.",
  cases: [
    {
      "description": "ar2: '😀'.matches('[😀-😂]')",
      "expectation": "ALLOW",
      "method": "get",
      "path": "ar2/1"
    }
  ],
  rules: "rules_version = '2';\nservice cloud.firestore {\n  match /databases/{database}/documents {\n    match /ar2/{id} {\n      allow get: if '😀'.matches('[😀-😂]');\n    }\n  }\n}\n",
};
