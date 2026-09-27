/**
 * ─── Scenario: stdlib-string-bytes-hashing ──────────────────────────────────
 * String methods `lower()`, `upper()`, `trim()`, `replace()`, and `toUtf8()`,
 * the Bytes values `toUtf8()` and `hashing.*` return, and the hashing digests
 * themselves, in Storage rules.
 *
 * The replace cases separate a regular-expression replace from a literal one
 * (`'.'` matches every character as a pattern, one character as a literal) and
 * a replace-all from a replace-first. The replacement string follows Java
 * `Matcher` template rules: `$1` expands a numbered group and `\$` inserts a
 * dollar sign. A replacement of `$&` makes the Rules Test API answer HTTP 500
 * for the whole request, so no case pins it. Negative controls pin the
 * receiver and argument types: an int has no string methods and does not
 * hash, and an uncompilable pattern is an error.
 *
 * The string-escape cases cover the escapes production accepts in a string
 * literal, one `allow get` condition per path, the same cases and verdicts as
 * the stringEscape cases of the Firestore scenario string-literals-and-regex.
 * A backslash escapes a backslash, either quote, `n`, `r`, `t`, `b`, or `f`.
 * `\x` takes exactly two hexadecimal digits of either case and `\` takes three
 * octal digits up to `\377`; each is the code point of that value, not a
 * byte. `\u` takes exactly four hexadecimal digits of either case and is one
 * UTF-16 code unit: two `\u` escapes form a surrogate pair, and `size()`
 * counts code units. A raw tab is a plain character.
 *
 * Production rejects these forms when the ruleset is submitted, so they
 * cannot appear in a scenario: `'\/'` ("Missing 'match' keyword before
 * path"), `'\a'`, `'\v'`, `'\?'`, `'\d'`, `'\.'`, a backslash before a
 * backtick, `'\0'`, `'\12'`, `'\400'`, `'\x4'`, `'\x4g'`, `'\X41'`, `\u` with
 * fewer than four hexadecimal digits or none, `'\u{41}'`, `'\U0001F600'`, and
 * a raw line feed or carriage return inside the quotes.
 */
import type { StorageScenarioRecord } from './types.ts';

interface StringEscapeCase {
  key: string;
  condition: string;
  expectation: 'ALLOW' | 'DENY';
}

const stringEscapes: StringEscapeCase[] = [
  { key: 'hexEscape', condition: "'\\x41' == 'A' && '\\x4a' == 'J' && '\\x4A' == 'J'", expectation: 'ALLOW' },
  { key: 'hexEscapeTwoDigits', condition: "'\\x411' == 'A1' && '\\x41'.size() == 1", expectation: 'ALLOW' },
  { key: 'hexEscapeCodePoint', condition: "'\\xe9' == 'é' && '\\xe9'.toUtf8() == b'\\xc3\\xa9'", expectation: 'ALLOW' },
  { key: 'hexEscapeNotUtf8', condition: "'\\xc3\\xa9' == 'é'", expectation: 'DENY' },
  { key: 'hexEscapeSize', condition: "'\\xc3\\xa9'.size() == 2", expectation: 'ALLOW' },
  { key: 'unicodeEscape', condition: "'\\u0041' == 'A' && \"\\u0041\" == 'A' && '\\u00411' == 'A1'", expectation: 'ALLOW' },
  { key: 'unicodeEscapeNonAscii', condition: "'\\u00e9' == 'é' && '\\u00E9' == 'é' && '\\u00e9'.size() == 1", expectation: 'ALLOW' },
  { key: 'unicodeEscapeUtf8', condition: "'\\u00e9'.toUtf8().toHexString() == 'C3A9'", expectation: 'ALLOW' },
  { key: 'unicodeEscapeOneUnit', condition: "'\\u00e9'.size() == 2", expectation: 'DENY' },
  { key: 'unicodeEscapeCjk', condition: "'\\u65e5\\u672c' == '日本'", expectation: 'ALLOW' },
  { key: 'unicodeSurrogatePair', condition: "'\\ud83d\\ude00' == '😀' && '\\ud83d\\ude00'.size() == 2", expectation: 'ALLOW' },
  { key: 'octalEscape', condition: "'\\101' == 'A' && '\\101'.size() == 1 && '\\012' == '\\n'", expectation: 'ALLOW' },
  { key: 'octalEscapeMax', condition: "'\\377' == '\\u00ff' && '\\377' == '\\xff' && '\\377'.toUtf8().toHexString() == 'C3BF'", expectation: 'ALLOW' },
  { key: 'octalEscapeZero', condition: "'\\000'.size() == 1 && '\\000' == '\\u0000'", expectation: 'ALLOW' },
  { key: 'backspaceFormFeed', condition: "'\\b' == '\\u0008' && '\\f' == '\\u000c' && '\\b\\f'.toUtf8().toHexString() == '080C'", expectation: 'ALLOW' },
  { key: 'simpleEscapes', condition: "'\\\\\\'\\\"\\n\\r\\t'.toUtf8().toHexString() == '5C27220A0D09'", expectation: 'ALLOW' },
  { key: 'doubleQuotedMix', condition: "\"\\x41\\u0041\\101\" == 'AAA'", expectation: 'ALLOW' },
  { key: 'rawTab', condition: "'a\tb'.size() == 3 && 'a\tb' == 'a\\tb'", expectation: 'ALLOW' },
];

const stringEscapeBlocks = stringEscapes
  .map(({ key, condition }) => `    match /string-escape/${key}/{id} {
      allow get: if ${condition};
    }`)
  .join('\n');

const ALICE_SHA256_HEX = '2bd806c97f0e00af1a1fc3328fa763a9269723c8db8fac4f93af71db186d6e90';

function getCase(description: string, expectation: 'ALLOW' | 'DENY', path: string) {
  return {
    description,
    expectation,
    method: 'get' as const,
    path,
    auth: { uid: 'alice' },
    existingResource: {
      size: 10,
      contentType: 'application/pdf',
      metadata: { name: 'Report.PDF', ownerHash: ALICE_SHA256_HEX },
    },
    requestTime: '2025-06-15T00:00:00Z',
  };
}

export const scenario: StorageScenarioRecord = {
  fm: 'STORAGE-STDLIB-STRING',
  rationale:
    'String case, trim, regular-expression replace-all, and toUtf8, plus Bytes encodings and equality and the md5/sha256/crc32/crc32c digests, with int receivers, int hash input, and an invalid pattern as negative controls. String literals decode the escapes production accepts: \\x and octal as code points, \\u as one UTF-16 code unit, and \\b and \\f.',
  rules: `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /case/{id} {
      allow get: if 'AbC'.lower() == 'abc' && 'AbC'.upper() == 'ABC'
        && '  x y  '.trim() == 'x y';
    }
    match /metadata-case/{id} {
      allow get: if resource.metadata.name.lower() == 'report.pdf';
    }
    match /replace-all/{id} {
      allow get: if 'aXa'.replace('a', 'b') == 'bXb';
    }
    match /replace-pattern/{id} {
      allow get: if 'a.b'.replace('.', '-') == '---';
    }
    match /replace-literal/{id} {
      allow get: if 'a.b'.replace('.', '-') == 'a-b';
    }
    match /replace-class/{id} {
      allow get: if 'a1b22'.replace('[0-9]+', '#') == 'a#b#';
    }
    match /replace-group-reference/{id} {
      allow get: if 'ab'.replace('(a)', '$1$1') == 'aab';
    }
    match /replace-escaped-dollar/{id} {
      allow get: if 'ab'.replace('a', '\\\\$') == '$b';
    }
    match /replace-invalid-pattern/{id} {
      allow get: if 'abc'.replace('(', 'x') == 'abc';
    }
    match /utf8-size/{id} {
      allow get: if 'é'.toUtf8().size() == 2 && 'abc'.toUtf8().size() == 3;
    }
    match /bytes-encodings/{id} {
      allow get: if 'hi'.toUtf8().toBase64() == 'aGk='
        && 'hi'.toUtf8().toHexString() == '6869';
    }
    match /bytes-equality/{id} {
      allow get: if 'hi'.toUtf8() == 'hi'.toUtf8() && 'hi'.toUtf8() != 'ho'.toUtf8();
    }
    match /md5/{id} {
      allow get: if hashing.md5('abc').toHexString() == '900150983CD24FB0D6963F7D28E17F72';
    }
    match /sha256/{id} {
      allow get: if hashing.sha256('abc').toHexString()
        == 'BA7816BF8F01CFEA414140DE5DAE2223B00361A396177A9CB410FF61F20015AD';
    }
    match /crc/{id} {
      allow get: if hashing.crc32('abc').toHexString() == 'C2412435'
        && hashing.crc32c('abc').toHexString() == 'B73F4B36';
    }
    match /hash-bytes-input/{id} {
      allow get: if hashing.sha256('abc'.toUtf8()) == hashing.sha256('abc');
    }
    match /owner-hash/{id} {
      allow get: if hashing.sha256(request.auth.uid).toHexString().lower()
        == resource.metadata.ownerHash;
    }
    match /int-string-method/{id} {
      allow get: if resource.size.lower() == '10';
    }
    match /hash-int/{id} {
      allow get: if hashing.md5(resource.size).size() == 16;
    }
${stringEscapeBlocks}
  }
}`,
  cases: [
    getCase('lower, upper, and trim', 'ALLOW', 'case/a'),
    getCase('lower over custom metadata', 'ALLOW', 'metadata-case/a'),
    getCase('replace replaces every match', 'ALLOW', 'replace-all/a'),
    getCase('replace treats the pattern as a regular expression', 'ALLOW', 'replace-pattern/a'),
    getCase('replace does not treat the pattern as a literal', 'DENY', 'replace-literal/a'),
    getCase('replace with a character class', 'ALLOW', 'replace-class/a'),
    getCase('replace expands a numbered group reference', 'ALLOW', 'replace-group-reference/a'),
    getCase('replace inserts an escaped dollar sign literally', 'ALLOW', 'replace-escaped-dollar/a'),
    getCase('replace with an invalid pattern is an error', 'DENY', 'replace-invalid-pattern/a'),
    getCase('toUtf8 size counts UTF-8 bytes', 'ALLOW', 'utf8-size/a'),
    getCase('bytes toBase64 and toHexString', 'ALLOW', 'bytes-encodings/a'),
    getCase('bytes compare by value', 'ALLOW', 'bytes-equality/a'),
    getCase('md5 digest', 'ALLOW', 'md5/a'),
    getCase('sha256 digest', 'ALLOW', 'sha256/a'),
    getCase('crc32 and crc32c digests', 'ALLOW', 'crc/a'),
    getCase('hashing a string equals hashing its UTF-8 bytes', 'ALLOW', 'hash-bytes-input/a'),
    getCase('sha256 of the caller uid against metadata', 'ALLOW', 'owner-hash/a'),
    getCase('int receiver has no lower() method', 'DENY', 'int-string-method/a'),
    getCase('hashing an int is an error', 'DENY', 'hash-int/a'),
    ...stringEscapes.map(({ key, condition, expectation }) =>
      getCase(`${condition} → ${expectation}`, expectation, `string-escape/${key}/a`)),
  ],
};
