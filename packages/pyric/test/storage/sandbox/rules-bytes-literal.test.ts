import { describe, expect, it } from 'bun:test';
import { parseStorageRules } from '../../../src/storage/sandbox/rules.js';
import { evaluateStorageRules } from '../../../src/storage/sandbox/rules-evaluator.js';

// ─── bytes literal ───────────────────────────────────────────────
//
// Storage rules evaluate a bytes literal to the Bytes value `toUtf8()`
// produces. Verdicts match production, captured in corpus scenario
// bytes-literal (rules-storage-bytes-literal).

describe('evaluateStorageRules: bytes literal', () => {
  function allowed(condition: string): boolean {
    const rules = parseStorageRules(`rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /x/{file} { allow create: if ${condition}; }
  }
}`);
    return evaluateStorageRules(rules, {
      request: {
        auth: { uid: 'alice' },
        method: 'create',
        path: 'b/pyric-default/o/x/a.txt',
        resource: { size: 2, contentType: 'text/plain' },
      },
      resource: null,
    }).allowed;
  }

  const cases: Array<[string, boolean]> = [
    ["b'abc' == 'abc'.toUtf8()", true],
    ["b\"abc\" == 'abc'.toUtf8()", true],
    ["B'abc' == b\"abc\"", true],
    ["b''.size() == 0 && b'' == ''.toUtf8()", true],
    ["b'\\x00\\x01'.size() == 2", true],
    ["b'\\x00\\x01'.size() == 8", false],
    ["b'\\x00\\x01'.toHexString() == '0001'", true],
    ["b'\\101' == 'A'.toUtf8() && b'\\377' == b'\\xff'", true],
    ["b'\\\\\\'\\\"\\n\\r\\t\\b\\f'.toHexString() == '5C27220A0D09080C'", true],
    ["b'é' == 'é'.toUtf8() && b'é' == b'\\xc3\\xa9'", true],
    ["b'\\xe9' == 'é'.toUtf8()", false],
    ["b'abc' is bytes", true],
    ["b'\\xff'.toBase64() == '_w=='", true],
    ["b'abc' == 'abc'", false],
    ["b'abc' == b'abd'", false],
    ["b'abc' < b'abd' && b'abc' > b'ab'", true],
    ["b'abc' in [b'abc'] && !(b'abd' in [b'abc'])", true],
    ["hashing.md5(b'abc') == hashing.md5('abc')", true],
    ["b'abc' + b'd' == b'abcd'", false],
    ["(b'abc' + b'd' == b'abcd') || true", true],
    ["b'abc'[0] == 97", false],
  ];

  for (const [condition, expected] of cases) {
    it(`${condition} → ${expected ? 'ALLOW' : 'DENY'}`, () => {
      expect(allowed(condition)).toBe(expected);
    });
  }
});
