/**
 * ─── Scenario: re2-pattern-semantics ────────────────────────────────────────
 * The string methods that take a pattern compile it as RE2, not as a
 * JavaScript regex: `\s` is `[\t\n\f\r ]` (no NBSP, em space or vertical
 * tab), `.` matches a carriage return, `\pL` and `[[:alpha:]]` are character
 * classes, `\Q...\E` quotes, `split()` never returns capture-group text, and
 * `(?i)` and RE2 escapes apply in `split()` and `replace()` as in `matches()`.
 * The `ctl` cases are controls: `\u` escapes produce the code point, and a
 * real NBSP from request data behaves the same.
 */
import type { ScenarioRecord } from './types.ts';

export const scenario: ScenarioRecord = {
  group: 'fix-class',
  fm: "Coverage: RE2 pattern semantics",
  rationale: "matches(), split() and replace() use RE2: \\s is ASCII whitespace only, . matches \\r, \\pL, [[:alpha:]] and \\Q..\\E are classes and quoting, split() does not return capture groups, and (?i) applies in split() and replace().",
  rules: "rules_version = '2';\nservice cloud.firestore {\n  match /databases/{database}/documents {\n    match /splitgrp0/{id} {\n      allow get: if 'a1b'.split('(1)') == ['a', 'b'];\n    }\n    match /splitgrp1/{id} {\n      allow get: if 'a1b'.split('(1)').size() == 2;\n    }\n    match /splitgrp2/{id} {\n      allow get: if 'a-b'.split('(-)').hasOnly(['a', 'b']);\n    }\n    match /splitgrp3/{id} {\n      allow get: if 'a1b'.split('(?:1)') == ['a', 'b'];\n    }\n    match /space0/{id} {\n      allow get: if !'\\u00a0'.matches('\\\\s');\n    }\n    match /space1/{id} {\n      allow get: if !'\\u2003'.matches('\\\\s');\n    }\n    match /space2/{id} {\n      allow get: if !'\\u000b'.matches('\\\\s');\n    }\n    match /space3/{id} {\n      allow get: if 'a b\\u00a0c'.matches('[^\\\\s]+ [^\\\\s]+');\n    }\n    match /space4/{id} {\n      allow get: if 'a\\rb'.matches('a.b');\n    }\n    match /space5/{id} {\n      allow get: if 'a b'.matches('a\\\\sb');\n    }\n    match /pl0/{id} {\n      allow get: if 'a'.matches('\\\\pL');\n    }\n    match /pl1/{id} {\n      allow get: if !'pL'.matches('\\\\pL');\n    }\n    match /posix0/{id} {\n      allow get: if 'a'.matches('[[:alpha:]]');\n    }\n    match /posix1/{id} {\n      allow get: if !'a]'.matches('[[:alpha:]]');\n    }\n    match /quote0/{id} {\n      allow get: if 'a.b'.matches('\\\\Qa.b\\\\E');\n    }\n    match /quote1/{id} {\n      allow get: if !'axb'.matches('\\\\Qa.b\\\\E');\n    }\n    match /flags0/{id} {\n      allow get: if 'aXbxc'.split('(?i)x') == ['a', 'b', 'c'];\n    }\n    match /flags1/{id} {\n      allow get: if 'aXb'.replace('(?i)x', '_') == 'a_b';\n    }\n    match /flags2/{id} {\n      allow get: if 'a\\u00a0b'.replace('\\\\s', '_') == 'a\\u00a0b';\n    }\n    match /flags3/{id} {\n      allow get: if 'X'.matches('(?i)x');\n    }\n    match /ctl0/{id} {\n      allow get: if '\\u00a0'.size() == 1;\n    }\n    match /ctl1/{id} {\n      allow get: if '\\u00a0' != 'u00a0' && '\\u00a0' != '\\\\u00a0';\n    }\n    match /ctl2/{id} {\n      allow get: if '\\u00a0' == request.resource.data.nbsp;\n    }\n    match /ctl3/{id} {\n      allow get: if '\\u2003'.size() == 1 && '\\u000b'.size() == 1 && '\\u3000'.size() == 1 && '\\ufeff'.size() == 1;\n    }\n    match /ctl4/{id} {\n      allow get: if 'a\\rb'.size() == 3;\n    }\n    match /ctl5/{id} {\n      allow get: if '\\u0001'.size() == 1;\n    }\n    match /ctl6/{id} {\n      allow get: if !request.resource.data.nbsp.matches('\\\\s');\n    }\n    match /ctl7/{id} {\n      allow get: if request.resource.data.nbsp.size() == 1;\n    }\n    match /dot0/{id} {\n      allow get: if 'xa\\rbx'.split('a.b') == ['x', 'x'];\n    }\n    match /dot1/{id} {\n      allow get: if 'a\\rb'.replace('a.b', '_') == '_';\n    }\n    match /dot2/{id} {\n      allow get: if 'a\\nb'.replace('a.b', '_') == 'a\\nb';\n    }\n    match /dot3/{id} {\n      allow get: if 'a\\nb'.replace('(?s)a.b', '_') == '_';\n    }\n    match /kelvin0/{id} {\n      allow get: if 'a\\u212ab'.split('(?i)k') == ['a', 'b'];\n    }\n    match /kelvin1/{id} {\n      allow get: if '\\u212a'.replace('(?i)k', '_') == '_';\n    }\n  }\n}\n",
  cases: [
  {
    "description": "split on a capturing group returns two pieces",
    "expectation": "ALLOW",
    "method": "get",
    "path": "splitgrp0/1",
    "requestTime": "2026-01-01T00:00:00Z"
  },
  {
    "description": "split on a capturing group has size two",
    "expectation": "ALLOW",
    "method": "get",
    "path": "splitgrp1/1",
    "requestTime": "2026-01-01T00:00:00Z"
  },
  {
    "description": "split on a capturing dash hasOnly the pieces",
    "expectation": "ALLOW",
    "method": "get",
    "path": "splitgrp2/1",
    "requestTime": "2026-01-01T00:00:00Z"
  },
  {
    "description": "split on a non-capturing group (control)",
    "expectation": "ALLOW",
    "method": "get",
    "path": "splitgrp3/1",
    "requestTime": "2026-01-01T00:00:00Z"
  },
  {
    "description": "NBSP is not \\s",
    "expectation": "ALLOW",
    "method": "get",
    "path": "space0/1",
    "requestTime": "2026-01-01T00:00:00Z"
  },
  {
    "description": "em space is not \\s",
    "expectation": "ALLOW",
    "method": "get",
    "path": "space1/1",
    "requestTime": "2026-01-01T00:00:00Z"
  },
  {
    "description": "vertical tab is not \\s",
    "expectation": "ALLOW",
    "method": "get",
    "path": "space2/1",
    "requestTime": "2026-01-01T00:00:00Z"
  },
  {
    "description": "NBSP counts as a non-space char",
    "expectation": "ALLOW",
    "method": "get",
    "path": "space3/1",
    "requestTime": "2026-01-01T00:00:00Z"
  },
  {
    "description": "dot matches carriage return",
    "expectation": "ALLOW",
    "method": "get",
    "path": "space4/1",
    "requestTime": "2026-01-01T00:00:00Z"
  },
  {
    "description": "space is \\s (control)",
    "expectation": "ALLOW",
    "method": "get",
    "path": "space5/1",
    "requestTime": "2026-01-01T00:00:00Z"
  },
  {
    "description": "a is \\pL",
    "expectation": "ALLOW",
    "method": "get",
    "path": "pl0/1",
    "requestTime": "2026-01-01T00:00:00Z"
  },
  {
    "description": "literal pL is not \\pL",
    "expectation": "ALLOW",
    "method": "get",
    "path": "pl1/1",
    "requestTime": "2026-01-01T00:00:00Z"
  },
  {
    "description": "a is [[:alpha:]]",
    "expectation": "ALLOW",
    "method": "get",
    "path": "posix0/1",
    "requestTime": "2026-01-01T00:00:00Z"
  },
  {
    "description": "a] is not [[:alpha:]]",
    "expectation": "ALLOW",
    "method": "get",
    "path": "posix1/1",
    "requestTime": "2026-01-01T00:00:00Z"
  },
  {
    "description": "quoted a.b matches a.b",
    "expectation": "ALLOW",
    "method": "get",
    "path": "quote0/1",
    "requestTime": "2026-01-01T00:00:00Z"
  },
  {
    "description": "quoted a.b does not match axb",
    "expectation": "ALLOW",
    "method": "get",
    "path": "quote1/1",
    "requestTime": "2026-01-01T00:00:00Z"
  },
  {
    "description": "split with (?i) splits both cases",
    "expectation": "ALLOW",
    "method": "get",
    "path": "flags0/1",
    "requestTime": "2026-01-01T00:00:00Z"
  },
  {
    "description": "replace with (?i) replaces uppercase",
    "expectation": "ALLOW",
    "method": "get",
    "path": "flags1/1",
    "requestTime": "2026-01-01T00:00:00Z"
  },
  {
    "description": "replace \\s leaves NBSP",
    "expectation": "ALLOW",
    "method": "get",
    "path": "flags2/1",
    "requestTime": "2026-01-01T00:00:00Z"
  },
  {
    "description": "matches with (?i) (control)",
    "expectation": "ALLOW",
    "method": "get",
    "path": "flags3/1",
    "requestTime": "2026-01-01T00:00:00Z"
  },
  {
    "description": "nbsp escape has size one",
    "expectation": "ALLOW",
    "method": "get",
    "path": "ctl0/1"
  },
  {
    "description": "nbsp escape is not literal text",
    "expectation": "ALLOW",
    "method": "get",
    "path": "ctl1/1"
  },
  {
    "description": "nbsp escape equals a real nbsp from data",
    "expectation": "ALLOW",
    "method": "get",
    "path": "ctl2/1",
    "data": {
      "nbsp": "\u00a0"
    }
  },
  {
    "description": "other escapes have size one",
    "expectation": "ALLOW",
    "method": "get",
    "path": "ctl3/1"
  },
  {
    "description": "carriage return escape has size one",
    "expectation": "ALLOW",
    "method": "get",
    "path": "ctl4/1"
  },
  {
    "description": "C0 escape has size one",
    "expectation": "ALLOW",
    "method": "get",
    "path": "ctl5/1"
  },
  {
    "description": "real nbsp from data is not \\s",
    "expectation": "ALLOW",
    "method": "get",
    "path": "ctl6/1",
    "data": {
      "nbsp": "\u00a0"
    }
  },
  {
    "description": "real nbsp from data has size one",
    "expectation": "ALLOW",
    "method": "get",
    "path": "ctl7/1",
    "data": {
      "nbsp": "\u00a0"
    }
  },
  {
    "description": "split dot matches carriage return",
    "expectation": "ALLOW",
    "method": "get",
    "path": "dot0/1",
    "requestTime": "2026-01-01T00:00:00Z"
  },
  {
    "description": "replace dot matches carriage return",
    "expectation": "ALLOW",
    "method": "get",
    "path": "dot1/1",
    "requestTime": "2026-01-01T00:00:00Z"
  },
  {
    "description": "replace dot does not match newline (control)",
    "expectation": "ALLOW",
    "method": "get",
    "path": "dot2/1",
    "requestTime": "2026-01-01T00:00:00Z"
  },
  {
    "description": "replace (?s) dot matches newline",
    "expectation": "ALLOW",
    "method": "get",
    "path": "dot3/1",
    "requestTime": "2026-01-01T00:00:00Z"
  },
  {
    "description": "split (?i)k splits on the Kelvin sign",
    "expectation": "ALLOW",
    "method": "get",
    "path": "kelvin0/1",
    "requestTime": "2026-01-01T00:00:00Z"
  },
  {
    "description": "replace (?i)k replaces the Kelvin sign",
    "expectation": "ALLOW",
    "method": "get",
    "path": "kelvin1/1",
    "requestTime": "2026-01-01T00:00:00Z"
  }
],
};
