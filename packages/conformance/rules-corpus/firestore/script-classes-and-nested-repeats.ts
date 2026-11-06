/**
 * ─── Scenario: script-classes-and-nested-repeats ─────────────────────────────
 * RE2 script classes in `matches()`. Production reads `\p{Cyrillic}`,
 * `\p{Han}`, `\p{Latin}` and `\P{Greek}` as RE2 script classes, so a
 * deny-list guard on request data refuses a Cyrillic name (`sg0`) and `'中'`
 * matches `\p{Han}` (`sg3`); pyric reads a bare script name as the letters
 * `p{...}` and gets both wrong (#1889). The two `(a+)+b` cases record
 * production's answer for a nested repeat in `split()` and `replace()` on a
 * 27-character subject.
 *
 * Captured by the 2026-11-03 rules engine defect hunt as `c10-script-classes-and-redos`;
 * the rules and case descriptions are the ones sent to production.
 */
import type { ScenarioRecord } from './types.ts';

export const scenario: ScenarioRecord = {
  group: 'fix-class',
  fm: "Coverage: RE2 script classes in matches()",
  rationale: "A guard on a Unicode script (`\\p{Cyrillic}`, `\\p{Han}`) reads RE2's script class in matches(), and a nested repeat in split() and replace() on a 27-character subject answers as production does.",
  cases: [
    {
      "description": "sg0: !request.resource.data.name.matches('.*\\\\p{Cyrillic}.*')",
      "expectation": "DENY",
      "method": "create",
      "path": "sg0/1",
      "data": {
        "name": "Пётр"
      }
    },
    {
      "description": "sg1: !request.resource.data.name.matches('.*\\\\p{Cyrillic}.*')",
      "expectation": "ALLOW",
      "method": "create",
      "path": "sg1/1",
      "data": {
        "name": "Peter"
      }
    },
    {
      "description": "sg2: !'p{Greek}'.matches('\\\\p{Greek}')",
      "expectation": "ALLOW",
      "method": "get",
      "path": "sg2/1"
    },
    {
      "description": "sg3: '中'.matches('\\\\p{Han}')",
      "expectation": "ALLOW",
      "method": "get",
      "path": "sg3/1"
    },
    {
      "description": "sg4: 'a'.matches('[\\\\p{Latin}]')",
      "expectation": "ALLOW",
      "method": "get",
      "path": "sg4/1"
    },
    {
      "description": "sg5: !'α'.matches('\\\\P{Greek}')",
      "expectation": "ALLOW",
      "method": "get",
      "path": "sg5/1"
    },
    {
      "description": "rd0: request.resource.data.s.split('(a+)+b').size() == 1",
      "expectation": "ALLOW",
      "method": "create",
      "path": "rd0/1",
      "data": {
        "s": "aaaaaaaaaaaaaaaaaaaaaaaaaa!"
      }
    },
    {
      "description": "rd1: request.resource.data.s.replace('(a+)+b', '') == request.resource.data.s",
      "expectation": "ALLOW",
      "method": "create",
      "path": "rd1/1",
      "data": {
        "s": "aaaaaaaaaaaaaaaaaaaaaaaaaa!"
      }
    }
  ],
  rules: "rules_version = '2';\nservice cloud.firestore {\n  match /databases/{database}/documents {\n    match /sg0/{id} {\n      allow create: if !request.resource.data.name.matches('.*\\\\p{Cyrillic}.*');\n    }\n    match /sg1/{id} {\n      allow create: if !request.resource.data.name.matches('.*\\\\p{Cyrillic}.*');\n    }\n    match /sg2/{id} {\n      allow get: if !'p{Greek}'.matches('\\\\p{Greek}');\n    }\n    match /sg3/{id} {\n      allow get: if '中'.matches('\\\\p{Han}');\n    }\n    match /sg4/{id} {\n      allow get: if 'a'.matches('[\\\\p{Latin}]');\n    }\n    match /sg5/{id} {\n      allow get: if !'α'.matches('\\\\P{Greek}');\n    }\n    match /rd0/{id} {\n      allow create: if request.resource.data.s.split('(a+)+b').size() == 1;\n    }\n    match /rd1/{id} {\n      allow create: if request.resource.data.s.replace('(a+)+b', '') == request.resource.data.s;\n    }\n  }\n}\n",
};
