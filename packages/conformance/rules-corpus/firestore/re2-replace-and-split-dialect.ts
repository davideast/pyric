/**
 * ─── Scenario: re2-replace-and-split-dialect ─────────────────────────────────
 * RE2 syntax on the `replace()` and `split()` path, with `matches()` and
 * `size()` twins. Production reads scoped and inline flags (`sf0` to `sf6`),
 * `(?U)` as ungreedy (`ug0`, `ug1`), `\pL` and `[[:alpha:]]` as classes
 * (`pl0` to `px0`), `\Q..\E` as quoting (`qe0`, `qe1`), an astral character
 * as one code point (`as0` to `as4`), and `\z` and `\A` as absolute under
 * `(?m)` (`za0` to `za2`). `size()` counts UTF-16 units (`as5`, `as6`), and
 * an empty `split()` pattern does not give three pieces of `'a😀b'` (`as7`).
 * The `split()` cases (`sf4`, `pl2`, `as2`, `as7`) agree since `split()`
 * moved onto the linear matcher (#1895); the `replace()` cases that differ
 * are pinned until `replace()` moves too.
 *
 * Found by the 2026-11-03 rules engine defect hunt and captured on
 * 2026-11-04 as `c1-re2-replace-split`; the rules and case descriptions are
 * the ones sent to production.
 */
import type { ScenarioRecord } from './types.ts';

export const scenario: ScenarioRecord = {
  group: 'fix-class',
  fm: "Coverage: RE2 flags, classes, quoting, astral characters and anchors in replace() and split()",
  rationale: "replace() and split() read RE2's scoped and inline flags, `(?U)`, `\\pL`, `[[:alpha:]]`, `\\Q..\\E`, an astral character as one code point, and `\\z` and `\\A` under `(?m)` as production does.",
  cases: [
    {
      "description": "sf0: 'Ab'.replace('a(?i:b)', 'x') == 'Ab'",
      "expectation": "ALLOW",
      "method": "get",
      "path": "sf0/1"
    },
    {
      "description": "sf1: 'aB'.replace('a(?i:b)', 'x') == 'x'",
      "expectation": "ALLOW",
      "method": "get",
      "path": "sf1/1"
    },
    {
      "description": "sf2: 'Ab'.replace('a(?i)b', 'x') == 'Ab'",
      "expectation": "ALLOW",
      "method": "get",
      "path": "sf2/1"
    },
    {
      "description": "sf3: 'aB'.replace('(?i)a(?-i)B', 'x') == 'x'",
      "expectation": "ALLOW",
      "method": "get",
      "path": "sf3/1"
    },
    {
      "description": "sf4: 'Ab'.split('a(?i:b)') == ['Ab']",
      "expectation": "ALLOW",
      "method": "get",
      "path": "sf4/1"
    },
    {
      "description": "sf5: !'Ab'.matches('a(?i:b)')",
      "expectation": "ALLOW",
      "method": "get",
      "path": "sf5/1"
    },
    {
      "description": "sf6: '\\n\\n'.replace('(?s:.).', 'y') == '\\n\\n'",
      "expectation": "ALLOW",
      "method": "get",
      "path": "sf6/1"
    },
    {
      "description": "ug0: 'aaa'.replace('(?U)a+', 'x') == 'xxx'",
      "expectation": "ALLOW",
      "method": "get",
      "path": "ug0/1"
    },
    {
      "description": "ug1: 'aaa'.replace('(?U)a+', 'x') == 'x'",
      "expectation": "ALLOW",
      "method": "get",
      "path": "ug1/1"
    },
    {
      "description": "pl0: 'a'.replace('\\\\p{L}', 'x') == 'x'",
      "expectation": "ALLOW",
      "method": "get",
      "path": "pl0/1"
    },
    {
      "description": "pl1: 'a'.replace('\\\\pL', 'x') == 'x'",
      "expectation": "ALLOW",
      "method": "get",
      "path": "pl1/1"
    },
    {
      "description": "pl2: '1a2'.split('\\\\pL') == ['1', '2']",
      "expectation": "ALLOW",
      "method": "get",
      "path": "pl2/1"
    },
    {
      "description": "px0: 'a'.replace('[[:alpha:]]', 'x') == 'x'",
      "expectation": "ALLOW",
      "method": "get",
      "path": "px0/1"
    },
    {
      "description": "qe0: 'a.b'.replace('\\\\Qa.b\\\\E', 'x') == 'x'",
      "expectation": "ALLOW",
      "method": "get",
      "path": "qe0/1"
    },
    {
      "description": "qe1: 'axb'.replace('\\\\Qa.b\\\\E', 'x') == 'axb'",
      "expectation": "ALLOW",
      "method": "get",
      "path": "qe1/1"
    },
    {
      "description": "as0: '😀'.replace('.', 'x') == 'x'",
      "expectation": "ALLOW",
      "method": "get",
      "path": "as0/1"
    },
    {
      "description": "as1: '😀'.replace('[^a]', 'x') == 'x'",
      "expectation": "ALLOW",
      "method": "get",
      "path": "as1/1"
    },
    {
      "description": "as2: 'a😀b'.split('[^ab]') == ['a', 'b']",
      "expectation": "ALLOW",
      "method": "get",
      "path": "as2/1"
    },
    {
      "description": "as3: '😀'.replace('[\\\\x{1F600}]', 'x') == 'x'",
      "expectation": "ALLOW",
      "method": "get",
      "path": "as3/1"
    },
    {
      "description": "as4: '😀'.matches('.')",
      "expectation": "ALLOW",
      "method": "get",
      "path": "as4/1"
    },
    {
      "description": "as5: '😀'.size() == 1",
      "expectation": "ALLOW",
      "method": "get",
      "path": "as5/1"
    },
    {
      "description": "as6: '😀'.size() == 2",
      "expectation": "ALLOW",
      "method": "get",
      "path": "as6/1"
    },
    {
      "description": "as7: 'a😀b'.split('').size() == 3",
      "expectation": "ALLOW",
      "method": "get",
      "path": "as7/1"
    },
    {
      "description": "za0: 'a\\nb'.replace('(?m)a\\\\z', 'x') == 'a\\nb'",
      "expectation": "ALLOW",
      "method": "get",
      "path": "za0/1"
    },
    {
      "description": "za1: 'a\\nb'.replace('(?m)\\\\Ab', 'x') == 'a\\nb'",
      "expectation": "ALLOW",
      "method": "get",
      "path": "za1/1"
    },
    {
      "description": "za2: !'a\\nb'.matches('(?m)a\\\\z.*')",
      "expectation": "ALLOW",
      "method": "get",
      "path": "za2/1"
    },
    {
      "description": "em0: 'abc'.replace('b*', '-') == '-a-c-'",
      "expectation": "ALLOW",
      "method": "get",
      "path": "em0/1"
    },
    {
      "description": "em1: 'abc'.replace('b*', '-') == '-a--c-'",
      "expectation": "ALLOW",
      "method": "get",
      "path": "em1/1"
    },
    {
      "description": "em2: 'abc'.replace('', '-') == '-a-b-c-'",
      "expectation": "ALLOW",
      "method": "get",
      "path": "em2/1"
    },
    {
      "description": "tp0: 'ab'.replace('(?P<n>a)', '${n}x') == 'axb'",
      "expectation": "ALLOW",
      "method": "get",
      "path": "tp0/1"
    },
    {
      "description": "tp1: 'ab'.replace('(a)', '$1$1') == 'aab'",
      "expectation": "ALLOW",
      "method": "get",
      "path": "tp1/1"
    },
    {
      "description": "tp2: 'a'.replace('a', '$0$0') == 'aa'",
      "expectation": "ALLOW",
      "method": "get",
      "path": "tp2/1"
    }
  ],
  rules: "rules_version = '2';\nservice cloud.firestore {\n  match /databases/{database}/documents {\n    match /sf0/{id} {\n      allow get: if 'Ab'.replace('a(?i:b)', 'x') == 'Ab';\n    }\n    match /sf1/{id} {\n      allow get: if 'aB'.replace('a(?i:b)', 'x') == 'x';\n    }\n    match /sf2/{id} {\n      allow get: if 'Ab'.replace('a(?i)b', 'x') == 'Ab';\n    }\n    match /sf3/{id} {\n      allow get: if 'aB'.replace('(?i)a(?-i)B', 'x') == 'x';\n    }\n    match /sf4/{id} {\n      allow get: if 'Ab'.split('a(?i:b)') == ['Ab'];\n    }\n    match /sf5/{id} {\n      allow get: if !'Ab'.matches('a(?i:b)');\n    }\n    match /sf6/{id} {\n      allow get: if '\\n\\n'.replace('(?s:.).', 'y') == '\\n\\n';\n    }\n    match /ug0/{id} {\n      allow get: if 'aaa'.replace('(?U)a+', 'x') == 'xxx';\n    }\n    match /ug1/{id} {\n      allow get: if 'aaa'.replace('(?U)a+', 'x') == 'x';\n    }\n    match /pl0/{id} {\n      allow get: if 'a'.replace('\\\\p{L}', 'x') == 'x';\n    }\n    match /pl1/{id} {\n      allow get: if 'a'.replace('\\\\pL', 'x') == 'x';\n    }\n    match /pl2/{id} {\n      allow get: if '1a2'.split('\\\\pL') == ['1', '2'];\n    }\n    match /px0/{id} {\n      allow get: if 'a'.replace('[[:alpha:]]', 'x') == 'x';\n    }\n    match /qe0/{id} {\n      allow get: if 'a.b'.replace('\\\\Qa.b\\\\E', 'x') == 'x';\n    }\n    match /qe1/{id} {\n      allow get: if 'axb'.replace('\\\\Qa.b\\\\E', 'x') == 'axb';\n    }\n    match /as0/{id} {\n      allow get: if '😀'.replace('.', 'x') == 'x';\n    }\n    match /as1/{id} {\n      allow get: if '😀'.replace('[^a]', 'x') == 'x';\n    }\n    match /as2/{id} {\n      allow get: if 'a😀b'.split('[^ab]') == ['a', 'b'];\n    }\n    match /as3/{id} {\n      allow get: if '😀'.replace('[\\\\x{1F600}]', 'x') == 'x';\n    }\n    match /as4/{id} {\n      allow get: if '😀'.matches('.');\n    }\n    match /as5/{id} {\n      allow get: if '😀'.size() == 1;\n    }\n    match /as6/{id} {\n      allow get: if '😀'.size() == 2;\n    }\n    match /as7/{id} {\n      allow get: if 'a😀b'.split('').size() == 3;\n    }\n    match /za0/{id} {\n      allow get: if 'a\\nb'.replace('(?m)a\\\\z', 'x') == 'a\\nb';\n    }\n    match /za1/{id} {\n      allow get: if 'a\\nb'.replace('(?m)\\\\Ab', 'x') == 'a\\nb';\n    }\n    match /za2/{id} {\n      allow get: if !'a\\nb'.matches('(?m)a\\\\z.*');\n    }\n    match /em0/{id} {\n      allow get: if 'abc'.replace('b*', '-') == '-a-c-';\n    }\n    match /em1/{id} {\n      allow get: if 'abc'.replace('b*', '-') == '-a--c-';\n    }\n    match /em2/{id} {\n      allow get: if 'abc'.replace('', '-') == '-a-b-c-';\n    }\n    match /tp0/{id} {\n      allow get: if 'ab'.replace('(?P<n>a)', '${n}x') == 'axb';\n    }\n    match /tp1/{id} {\n      allow get: if 'ab'.replace('(a)', '$1$1') == 'aab';\n    }\n    match /tp2/{id} {\n      allow get: if 'a'.replace('a', '$0$0') == 'aa';\n    }\n  }\n}\n",
};
