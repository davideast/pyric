/**
 * ─── Scenario: split-and-trim-edges ─────────────────────────────────────────
 * `'a,b,'.split(',')` has two pieces: trailing empty strings are dropped,
 * leading ones kept. `trim()` strips C0 controls and space and keeps NBSP,
 * ideographic space and the byte-order mark.
 */
import type { ScenarioRecord } from './types.ts';

export const scenario: ScenarioRecord = {
  group: 'fix-class',
  fm: "Coverage: split and trim edges",
  rationale: "split() drops trailing empty pieces, and trim() strips only characters at or below U+0020, keeping NBSP, U+3000 and BOM.",
  rules: "rules_version = '2';\nservice cloud.firestore {\n  match /databases/{database}/documents {\n    match /split0/{id} {\n      allow get: if 'a,b,'.split(',') == ['a', 'b'];\n    }\n    match /split1/{id} {\n      allow get: if 'a,b,'.split(',') == ['a', 'b', ''];\n    }\n    match /split2/{id} {\n      allow get: if 'a,b,,'.split(',').size() == 2;\n    }\n    match /split3/{id} {\n      allow get: if 'a.b.c'.split('.').size() == 0;\n    }\n    match /split4/{id} {\n      allow get: if ''.split(',') == [''];\n    }\n    match /split5/{id} {\n      allow get: if ',a'.split(',') == ['', 'a'];\n    }\n    match /trim0/{id} {\n      allow get: if '\\u00a0'.trim().size() == 1;\n    }\n    match /trim1/{id} {\n      allow get: if '\\u3000a'.trim() == '\\u3000a';\n    }\n    match /trim2/{id} {\n      allow get: if '\\u0001a\\u001f'.trim() == 'a';\n    }\n    match /trim3/{id} {\n      allow get: if '\\ufeffa'.trim() == '\\ufeffa';\n    }\n    match /trim4/{id} {\n      allow get: if ' \\ta\\n '.trim() == 'a';\n    }\n  }\n}\n",
  cases: [
  {
    "description": "trailing comma drops the empty piece",
    "expectation": "ALLOW",
    "method": "get",
    "path": "split0/1",
    "requestTime": "2026-01-01T00:00:00Z"
  },
  {
    "description": "trailing comma keeps the empty piece",
    "expectation": "DENY",
    "method": "get",
    "path": "split1/1",
    "requestTime": "2026-01-01T00:00:00Z"
  },
  {
    "description": "two trailing commas give size two",
    "expectation": "ALLOW",
    "method": "get",
    "path": "split2/1",
    "requestTime": "2026-01-01T00:00:00Z"
  },
  {
    "description": "split on dot of a.b.c is empty",
    "expectation": "ALLOW",
    "method": "get",
    "path": "split3/1",
    "requestTime": "2026-01-01T00:00:00Z"
  },
  {
    "description": "empty string splits to one empty piece",
    "expectation": "ALLOW",
    "method": "get",
    "path": "split4/1",
    "requestTime": "2026-01-01T00:00:00Z"
  },
  {
    "description": "leading comma keeps the empty piece (control)",
    "expectation": "ALLOW",
    "method": "get",
    "path": "split5/1",
    "requestTime": "2026-01-01T00:00:00Z"
  },
  {
    "description": "trim keeps NBSP",
    "expectation": "ALLOW",
    "method": "get",
    "path": "trim0/1",
    "requestTime": "2026-01-01T00:00:00Z"
  },
  {
    "description": "trim keeps ideographic space",
    "expectation": "ALLOW",
    "method": "get",
    "path": "trim1/1",
    "requestTime": "2026-01-01T00:00:00Z"
  },
  {
    "description": "trim strips C0 controls",
    "expectation": "ALLOW",
    "method": "get",
    "path": "trim2/1",
    "requestTime": "2026-01-01T00:00:00Z"
  },
  {
    "description": "trim keeps BOM",
    "expectation": "ALLOW",
    "method": "get",
    "path": "trim3/1",
    "requestTime": "2026-01-01T00:00:00Z"
  },
  {
    "description": "trim strips space tab newline (control)",
    "expectation": "ALLOW",
    "method": "get",
    "path": "trim4/1",
    "requestTime": "2026-01-01T00:00:00Z"
  }
],
};
