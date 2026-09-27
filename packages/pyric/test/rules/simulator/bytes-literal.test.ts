/**
 * Firestore rules evaluate a bytes literal to the Bytes value `toUtf8()`
 * produces. Verdicts match production, captured in the bytes literal cases of
 * corpus scenario bytes-toutf8-and-hashing
 * (rules-firestore-bytes-toutf8-and-hashing).
 */
import { describe, expect, test } from 'bun:test';
import { SimulateFirestoreRulesHandler } from '../../../src/rules/simulator/handler.js';

function verdict(condition: string): 'ALLOW' | 'DENY' {
  const rules = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /x/{id} { allow create: if ${condition}; }
  }
}`;
  const result = new SimulateFirestoreRulesHandler().simulate(rules, [{
    description: condition,
    expectation: 'ALLOW',
    method: 'create',
    path: 'x/d',
    auth: { uid: 'alice' },
    data: {},
  }]);
  if (!result.success) throw new Error(`${result.error.code} ${result.error.message}`);
  return result.data.results[0]!.decision as 'ALLOW' | 'DENY';
}

describe('Firestore rules: bytes literal', () => {
  const cases: Array<[string, 'ALLOW' | 'DENY']> = [
    ["b'abc' == 'abc'.toUtf8()", 'ALLOW'],
    ["b\"abc\" == 'abc'.toUtf8()", 'ALLOW'],
    ["B'abc' == b\"abc\"", 'ALLOW'],
    ["b''.size() == 0 && b'' == ''.toUtf8()", 'ALLOW'],
    ["b'\\x00\\x01'.size() == 2", 'ALLOW'],
    ["b'\\x00\\x01'.size() == 8", 'DENY'],
    ["b'\\x00\\x01'.toHexString() == '0001'", 'ALLOW'],
    ["b'\\101' == 'A'.toUtf8() && b'\\377' == b'\\xff'", 'ALLOW'],
    ["b'\\\\\\'\\\"\\n\\r\\t\\b\\f'.toHexString() == '5C27220A0D09080C'", 'ALLOW'],
    ["b'é' == 'é'.toUtf8() && b'é' == b'\\xc3\\xa9'", 'ALLOW'],
    ["b'\\xe9' == 'é'.toUtf8()", 'DENY'],
    ["b'abc' is bytes", 'ALLOW'],
    ["b'\\xff'.toBase64() == '_w=='", 'ALLOW'],
    ["b'abc' == 'abc'", 'DENY'],
    ["b'abc' == b'abd'", 'DENY'],
    ["b'abc' < b'abd' && b'abc' > b'ab'", 'ALLOW'],
    ["b'abc' in [b'abc'] && !(b'abd' in [b'abc'])", 'ALLOW'],
    ["hashing.md5(b'abc') == hashing.md5('abc')", 'ALLOW'],
    ["b'abc' + b'd' == b'abcd'", 'DENY'],
    ["(b'abc' + b'd' == b'abcd') || true", 'ALLOW'],
    ["b'abc'[0] == 97", 'DENY'],
  ];

  for (const [condition, expected] of cases) {
    test(`${condition} → ${expected}`, () => {
      expect(verdict(condition)).toBe(expected);
    });
  }
});
