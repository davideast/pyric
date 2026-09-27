import { describe, expect, it } from 'bun:test';
import { parseStorageRules } from '../../../src/storage/sandbox/rules.js';
import { evaluateStorageRules } from '../../../src/storage/sandbox/rules-evaluator.js';

// ─── string literal escapes ──────────────────────────────────────
//
// Storage rules evaluate string literal escapes to the values production
// gives them. Verdicts match production, captured in the string escape cases
// of corpus scenario stdlib-string-bytes-hashing
// (rules-storage-stdlib-string-bytes-hashing).

describe('evaluateStorageRules: string literal escapes', () => {
  function allowed(condition: string): boolean {
    const rules = parseStorageRules(`rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /x/{file} { allow get: if ${condition}; }
  }
}`);
    return evaluateStorageRules(rules, {
      request: {
        auth: { uid: 'alice' },
        method: 'get',
        path: 'b/pyric-default/o/x/a.txt',
      },
      resource: { name: 'x/a.txt', bucket: 'pyric-default', size: 2, contentType: 'text/plain' },
    }).allowed;
  }

  const cases: Array<[string, boolean]> = [
    ["'\\x41' == 'A' && '\\x4a' == 'J' && '\\x4A' == 'J'", true],
    ["'\\x411' == 'A1' && '\\x41'.size() == 1", true],
    ["'\\xe9' == 'é' && '\\xe9'.toUtf8() == b'\\xc3\\xa9'", true],
    ["'\\xc3\\xa9' == 'é'", false],
    ["'\\xc3\\xa9'.size() == 2", true],
    ["'\\u0041' == 'A' && \"\\u0041\" == 'A' && '\\u00411' == 'A1'", true],
    ["'\\u00e9' == 'é' && '\\u00E9' == 'é' && '\\u00e9'.size() == 1", true],
    ["'\\u00e9'.toUtf8().toHexString() == 'C3A9'", true],
    ["'\\u00e9'.size() == 2", false],
    ["'\\u65e5\\u672c' == '日本'", true],
    ["'\\ud83d\\ude00' == '😀' && '\\ud83d\\ude00'.size() == 2", true],
    ["'\\101' == 'A' && '\\101'.size() == 1 && '\\012' == '\\n'", true],
    ["'\\377' == '\\u00ff' && '\\377' == '\\xff' && '\\377'.toUtf8().toHexString() == 'C3BF'", true],
    ["'\\000'.size() == 1 && '\\000' == '\\u0000'", true],
    ["'\\b' == '\\u0008' && '\\f' == '\\u000c' && '\\b\\f'.toUtf8().toHexString() == '080C'", true],
    ["'\\\\\\'\\\"\\n\\r\\t'.toUtf8().toHexString() == '5C27220A0D09'", true],
    ["\"\\x41\\u0041\\101\" == 'AAA'", true],
    ["'a\tb'.size() == 3 && 'a\tb' == 'a\\tb'", true],
  ];

  for (const [condition, expected] of cases) {
    it(`${condition} → ${expected ? 'ALLOW' : 'DENY'}`, () => {
      expect(allowed(condition)).toBe(expected);
    });
  }

  it("rejects the ruleset for '\\/'", () => {
    expect(() => parseStorageRules(`rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /x/{file} { allow get: if '\\/' == '/'; }
  }
}`)).toThrow();
  });
});
