/**
 * ─── Scenario: bytes-literal ─────────────────────────────────────────────────
 * The bytes literal `b'...'` in Storage rules. Each case is one `allow create`
 * condition on its own path, evaluated against a small text upload.
 *
 * The prefix is `b` or `B` and the quotes are single or double. The literal's
 * bytes are the UTF-8 encoding of its characters, so `b'abc'` equals
 * `'abc'.toUtf8()` and `b'é'` is two bytes. The escapes are `\\`, `\'`, `\"`,
 * `\n`, `\r`, `\t`, `\b`, `\f`, `\x` followed by exactly two hexadecimal digits
 * of either case, and `\` followed by three octal digits from `\000` to `\377`.
 * A hex or octal escape is one byte, not a UTF-8 encoded code point, so
 * `b'\xe9'` is one byte and differs from `'é'.toUtf8()`.
 *
 * A bytes literal equals only bytes: `b'abc' == 'abc'` is false. Bytes order
 * lexicographically, belong to a list by value, and hash like the string they
 * encode. `+` on two bytes values and `[]` on a bytes value are error values,
 * which `|| true` absorbs.
 *
 * Production rejects these forms when the ruleset is submitted, so they
 * cannot appear in a scenario: `b'\u00e9'` ("Invalid bytes literal"),
 * `b'\/'`, `b'\a'`, `b'\v'`, `b'\?'`, `b'\d'`, `b'\X41'`, `b'\x0'`, `b'\0'`,
 * `b'\12'`, `b'\400'`, `b'\U0001F600'`, a raw line break inside the quotes,
 * whitespace between the prefix and the quote (`b 'abc'`), and the prefixes
 * `rb`, `br`, and `bb`.
 */
import type { StorageScenarioRecord, StorageTestCase } from './types.ts';

interface BytesLiteralCase {
  key: string;
  condition: string;
  expectation: 'ALLOW' | 'DENY';
}

const bytesLiterals: BytesLiteralCase[] = [
  { key: 'equalsToUtf8', condition: "b'abc' == 'abc'.toUtf8()", expectation: 'ALLOW' },
  { key: 'doubleQuoted', condition: "b\"abc\" == 'abc'.toUtf8() && b\"it's\" == 'it\\'s'.toUtf8()", expectation: 'ALLOW' },
  { key: 'upperPrefix', condition: "B'abc' == b\"abc\"", expectation: 'ALLOW' },
  { key: 'emptyLiteral', condition: "b''.size() == 0 && b'' == ''.toUtf8()", expectation: 'ALLOW' },
  { key: 'hexEscapeSize', condition: "b'\\x00\\x01'.size() == 2", expectation: 'ALLOW' },
  { key: 'hexEscapeNotText', condition: "b'\\x00\\x01'.size() == 8", expectation: 'DENY' },
  { key: 'hexEscapeValue', condition: "b'\\x00\\x01'.toHexString() == '0001' && b'\\xFf\\xfF'.toHexString() == 'FFFF'", expectation: 'ALLOW' },
  { key: 'hexEscapeTwoDigits', condition: "b'\\x411' == b'A1'", expectation: 'ALLOW' },
  { key: 'octalEscape', condition: "b'\\101' == 'A'.toUtf8() && b'\\012' == b'\\n' && b'\\377' == b'\\xff'", expectation: 'ALLOW' },
  { key: 'simpleEscapes', condition: "b'\\\\\\'\\\"\\n\\r\\t\\b\\f'.toHexString() == '5C27220A0D09080C'", expectation: 'ALLOW' },
  { key: 'nonAsciiUtf8', condition: "b'é' == 'é'.toUtf8() && b'é' == b'\\xc3\\xa9' && b'日本'.size() == 6", expectation: 'ALLOW' },
  { key: 'highByteNotUtf8', condition: "b'\\xe9' == 'é'.toUtf8()", expectation: 'DENY' },
  { key: 'isBytes', condition: "b'abc' is bytes", expectation: 'ALLOW' },
  { key: 'toBase64', condition: "b'\\xff'.toBase64() == '_w=='", expectation: 'ALLOW' },
  { key: 'notEqualString', condition: "b'abc' == 'abc'", expectation: 'DENY' },
  { key: 'notEqualBytes', condition: "b'abc' == b'abd'", expectation: 'DENY' },
  { key: 'ordering', condition: "b'abc' < b'abd' && b'abc' > b'ab' && b'\\x00' < b'\\xff'", expectation: 'ALLOW' },
  { key: 'inList', condition: "b'abc' in [b'abc'] && !(b'abd' in [b'abc'])", expectation: 'ALLOW' },
  { key: 'hashing', condition: "hashing.md5(b'abc') == hashing.md5('abc')", expectation: 'ALLOW' },
  { key: 'concatError', condition: "b'abc' + b'd' == b'abcd'", expectation: 'DENY' },
  { key: 'concatErrorOrTrue', condition: "(b'abc' + b'd' == b'abcd') || true", expectation: 'ALLOW' },
  { key: 'indexError', condition: "b'abc'[0] == 97", expectation: 'DENY' },
];

function uploadCase(key: string, description: string, expectation: 'ALLOW' | 'DENY'): StorageTestCase {
  return {
    description,
    expectation,
    method: 'create',
    path: `${key}/a.txt`,
    auth: { uid: 'alice' },
    resource: { size: 2, contentType: 'text/plain' },
  };
}

const matchBlocks = bytesLiterals
  .map(({ key, condition }) => `    match /${key}/{file} {
      allow create: if ${condition};
    }`)
  .join('\n');

export const scenario: StorageScenarioRecord = {
  fm: 'Coverage: bytes literal',
  rationale:
    "A bytes literal b'...' or B\"...\" is the UTF-8 encoding of its characters, with \\x hex and \\ooo octal escapes that each produce one byte; it equals only bytes, orders lexicographically, and hashes like its string, and + and [] on bytes are error values that || true absorbs.",
  rules: `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
${matchBlocks}
  }
}`,
  cases: bytesLiterals.map(({ key, condition, expectation }) =>
    uploadCase(key, `${condition} → ${expectation}`, expectation)),
};
