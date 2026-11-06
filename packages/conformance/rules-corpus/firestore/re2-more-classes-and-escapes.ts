/**
 * ─── Scenario: re2-more-classes-and-escapes ──────────────────────────────────
 * More RE2 constructs on the `split()` and `replace()` path, with
 * `matches()` twins. Production reads `\p{Greek}` as the Greek script in
 * `matches()` (`pg1`, #1889); reads an emoji class range `[😀-😂]` as one
 * code point in `replace()` and `split()` (`ar0`, `ar1`, #1890); and
 * reads `\pN`, `\p{Greek}`, `[[:punct:]]` and `\Q.\E` as RE2 classes and
 * quoting in `replace()` and `split()` (`pn0`, `pg0`, `px2`, `qs0`,
 * #2211). pyric gets those seven wrong; the other eight agree.
 *
 * Captured by the 2026-11-03 rules engine defect hunt as `c9-re2-more`;
 * the rules and case descriptions are the ones sent to production.
 */
import type { ScenarioRecord } from './types.ts';

export const scenario: ScenarioRecord = {
  group: 'fix-class',
  fm: "Coverage: RE2 classes and escapes in matches(), split() and replace()",
  rationale: "RE2's Unicode classes (`\\pN`, `\\p{Greek}`), POSIX classes, `\\Q..\\E`, `(?i)`, `\\x61`, `\\b`, `\\d` and a class range over emoji give production's result in matches(), split() and replace().",
  cases: [
    {
      "description": "ar0: '😀'.replace('[😀-😂]', 'x') == 'x'",
      "expectation": "ALLOW",
      "method": "get",
      "path": "ar0/1"
    },
    {
      "description": "ar1: 'a😀'.split('[😀-😂]') == ['a']",
      "expectation": "ALLOW",
      "method": "get",
      "path": "ar1/1"
    },
    {
      "description": "ci0: 'É'.replace('(?i)é', 'x') == 'x'",
      "expectation": "ALLOW",
      "method": "get",
      "path": "ci0/1"
    },
    {
      "description": "ci1: 'É'.matches('(?i)é')",
      "expectation": "ALLOW",
      "method": "get",
      "path": "ci1/1"
    },
    {
      "description": "pn0: 'a1'.replace('\\\\pN', 'x') == 'ax'",
      "expectation": "ALLOW",
      "method": "get",
      "path": "pn0/1"
    },
    {
      "description": "pg0: 'α'.replace('\\\\p{Greek}', 'x') == 'x'",
      "expectation": "ALLOW",
      "method": "get",
      "path": "pg0/1"
    },
    {
      "description": "pg1: 'α'.matches('\\\\p{Greek}')",
      "expectation": "ALLOW",
      "method": "get",
      "path": "pg1/1"
    },
    {
      "description": "px1: 'a'.replace('[[:^alpha:]]', 'x') == 'a'",
      "expectation": "ALLOW",
      "method": "get",
      "path": "px1/1"
    },
    {
      "description": "px2: 'a.b'.split('[[:punct:]]') == ['a', 'b']",
      "expectation": "ALLOW",
      "method": "get",
      "path": "px2/1"
    },
    {
      "description": "ls0: '\\u2028'.replace('.', 'x') == 'x'",
      "expectation": "ALLOW",
      "method": "get",
      "path": "ls0/1"
    },
    {
      "description": "hx0: 'a'.replace('\\\\x61', 'b') == 'b'",
      "expectation": "ALLOW",
      "method": "get",
      "path": "hx0/1"
    },
    {
      "description": "qs0: 'a.b'.split('\\\\Q.\\\\E') == ['a', 'b']",
      "expectation": "ALLOW",
      "method": "get",
      "path": "qs0/1"
    },
    {
      "description": "wb0: 'é a'.replace('\\\\b', '|') == 'é |a|'",
      "expectation": "ALLOW",
      "method": "get",
      "path": "wb0/1"
    },
    {
      "description": "dg0: '٣'.replace('\\\\d', 'x') == '٣'",
      "expectation": "ALLOW",
      "method": "get",
      "path": "dg0/1"
    },
    {
      "description": "dg1: !'٣'.matches('\\\\d')",
      "expectation": "ALLOW",
      "method": "get",
      "path": "dg1/1"
    }
  ],
  rules: "rules_version = '2';\nservice cloud.firestore {\n  match /databases/{database}/documents {\n    match /ar0/{id} {\n      allow get: if '😀'.replace('[😀-😂]', 'x') == 'x';\n    }\n    match /ar1/{id} {\n      allow get: if 'a😀'.split('[😀-😂]') == ['a'];\n    }\n    match /ci0/{id} {\n      allow get: if 'É'.replace('(?i)é', 'x') == 'x';\n    }\n    match /ci1/{id} {\n      allow get: if 'É'.matches('(?i)é');\n    }\n    match /pn0/{id} {\n      allow get: if 'a1'.replace('\\\\pN', 'x') == 'ax';\n    }\n    match /pg0/{id} {\n      allow get: if 'α'.replace('\\\\p{Greek}', 'x') == 'x';\n    }\n    match /pg1/{id} {\n      allow get: if 'α'.matches('\\\\p{Greek}');\n    }\n    match /px1/{id} {\n      allow get: if 'a'.replace('[[:^alpha:]]', 'x') == 'a';\n    }\n    match /px2/{id} {\n      allow get: if 'a.b'.split('[[:punct:]]') == ['a', 'b'];\n    }\n    match /ls0/{id} {\n      allow get: if '\\u2028'.replace('.', 'x') == 'x';\n    }\n    match /hx0/{id} {\n      allow get: if 'a'.replace('\\\\x61', 'b') == 'b';\n    }\n    match /qs0/{id} {\n      allow get: if 'a.b'.split('\\\\Q.\\\\E') == ['a', 'b'];\n    }\n    match /wb0/{id} {\n      allow get: if 'é a'.replace('\\\\b', '|') == 'é |a|';\n    }\n    match /dg0/{id} {\n      allow get: if '٣'.replace('\\\\d', 'x') == '٣';\n    }\n    match /dg1/{id} {\n      allow get: if !'٣'.matches('\\\\d');\n    }\n  }\n}\n",
};
