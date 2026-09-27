/**
 * Firestore rules evaluate string literal escapes to the values production
 * gives them. Verdicts match production, captured in the string escape cases
 * of corpus scenario string-literals-and-regex
 * (rules-firestore-string-literals-and-regex).
 */
import { describe, expect, test } from 'bun:test';
import { SimulateFirestoreRulesHandler } from '../../../src/rules/simulator/handler.js';

function verdict(condition: string): 'ALLOW' | 'DENY' {
  const rules = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /x/{id} { allow get: if ${condition}; }
  }
}`;
  const result = new SimulateFirestoreRulesHandler().simulate(rules, [{
    description: condition,
    expectation: 'ALLOW',
    method: 'get',
    path: 'x/d',
    auth: { uid: 'alice' },
  }]);
  if (!result.success) throw new Error(`${result.error.code} ${result.error.message}`);
  return result.data.results[0]!.decision as 'ALLOW' | 'DENY';
}

describe('Firestore rules: string literal escapes', () => {
  const cases: Array<[string, 'ALLOW' | 'DENY']> = [
    ["'\\x41' == 'A' && '\\x4a' == 'J' && '\\x4A' == 'J'", 'ALLOW'],
    ["'\\x411' == 'A1' && '\\x41'.size() == 1", 'ALLOW'],
    ["'\\xe9' == 'é' && '\\xe9'.toUtf8() == b'\\xc3\\xa9'", 'ALLOW'],
    ["'\\xc3\\xa9' == 'é'", 'DENY'],
    ["'\\xc3\\xa9'.size() == 2", 'ALLOW'],
    ["'\\u0041' == 'A' && \"\\u0041\" == 'A' && '\\u00411' == 'A1'", 'ALLOW'],
    ["'\\u00e9' == 'é' && '\\u00E9' == 'é' && '\\u00e9'.size() == 1", 'ALLOW'],
    ["'\\u00e9'.toUtf8().toHexString() == 'C3A9'", 'ALLOW'],
    ["'\\u00e9'.size() == 2", 'DENY'],
    ["'\\u65e5\\u672c' == '日本'", 'ALLOW'],
    ["'\\ud83d\\ude00' == '😀' && '\\ud83d\\ude00'.size() == 2", 'ALLOW'],
    ["'\\101' == 'A' && '\\101'.size() == 1 && '\\012' == '\\n'", 'ALLOW'],
    ["'\\377' == '\\u00ff' && '\\377' == '\\xff' && '\\377'.toUtf8().toHexString() == 'C3BF'", 'ALLOW'],
    ["'\\000'.size() == 1 && '\\000' == '\\u0000'", 'ALLOW'],
    ["'\\b' == '\\u0008' && '\\f' == '\\u000c' && '\\b\\f'.toUtf8().toHexString() == '080C'", 'ALLOW'],
    ["'\\\\\\'\\\"\\n\\r\\t'.toUtf8().toHexString() == '5C27220A0D09'", 'ALLOW'],
    ["\"\\x41\\u0041\\101\" == 'AAA'", 'ALLOW'],
    ["'a\tb'.size() == 3 && 'a\tb' == 'a\\tb'", 'ALLOW'],
  ];

  for (const [condition, expected] of cases) {
    test(`${condition} → ${expected}`, () => {
      expect(verdict(condition)).toBe(expected);
    });
  }
});
