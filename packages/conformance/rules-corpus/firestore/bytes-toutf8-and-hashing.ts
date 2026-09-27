/**
 * ─── Scenario 9: bytes-toutf8-and-hashing ─────────────────────────────────────
 * Targets Item 5.3 — Bytes wrapper + String.toUtf8() + hashing.*. Pre-fix:
 * hashing.* threw UnsupportedError ('Unknown method on undefined' because
 * `hashing` resolved to undefined), and String.toUtf8 threw UnsupportedError.
 * Each case here exercises a wrapper-level invariant (size/round-trip) and
 * a hash with a well-known reference value. Picked rules where the literal
 * outputs are stable across runs (no random/time inputs).
 *
 * The bytesLiteral cases cover the bytes literal `b'...'`, one `allow create`
 * condition per path. The prefix is `b` or `B` and the quotes are single or
 * double. The literal's bytes are the UTF-8 encoding of its characters, so
 * `b'abc'` equals `'abc'.toUtf8()` and `b'é'` is two bytes. The escapes are
 * `\\`, `\'`, `\"`, `\n`, `\r`, `\t`, `\b`, `\f`, `\x` followed by exactly two
 * hexadecimal digits of either case, and `\` followed by three octal digits
 * from `\000` to `\377`. A hex or octal escape is one byte, not a UTF-8
 * encoded code point, so `b'\xe9'` is one byte and differs from
 * `'é'.toUtf8()`. A bytes literal equals only bytes: `b'abc' == 'abc'` is
 * false. Bytes order lexicographically, belong to a list by value, and hash
 * like the string they encode. `+` on two bytes values and `[]` on a bytes
 * value are error values, which `|| true` absorbs.
 *
 * Production rejects these forms when the ruleset is submitted, so they
 * cannot appear in a scenario: `b'\u0041'` ("Invalid bytes literal"),
 * `b'\/'`, `b'\a'`, `b'\v'`, `b'\?'`, `b'\d'`, `b'\X41'`, `b'\x0'`, `b'\0'`,
 * `b'\12'`, `b'\400'`, `b'\U0001F600'`, a raw line break inside the quotes,
 * whitespace between the prefix and the quote (`b 'abc'`), and the prefixes
 * `rb`, `br`, and `bb`.
 */
import type { ScenarioRecord } from './types.ts';

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

const bytesLiteralBlocks = bytesLiterals
  .map(({ key, condition }) => `    match /bytesLiteral/${key}/{id} {
      allow create: if ${condition};
    }`)
  .join('\n');

export const scenario: ScenarioRecord = {
  fm: 'Item 5.3',
  rationale: 'Sim must implement Bytes + String.toUtf8() + hashing.{md5,sha256,crc32,crc32c}. Pre-fix: every reference hashing rule denied silently and toUtf8 threw UnsupportedError.',
  rules: `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    // toUtf8 → Bytes, .size() returns byte count
    match /utf8SizeAllow/{id} {
      allow create: if request.auth != null
        && 'hello'.toUtf8().size() == 5;
    }
    // multi-byte UTF-8 length
    match /utf8MultibyteAllow/{id} {
      allow create: if request.auth != null
        && 'é'.toUtf8().size() == 2;
    }
    // toBase64 round-trip (no padding, URL-safe)
    match /base64Allow/{id} {
      allow create: if request.auth != null
        && 'hi'.toUtf8().toBase64() == 'aGk';
    }
    // toHexString round-trip
    match /hexAllow/{id} {
      allow create: if request.auth != null
        && 'hi'.toUtf8().toHexString() == '6869';
    }
    // is bytes
    match /isBytesAllow/{id} {
      allow create: if request.auth != null
        && 'x'.toUtf8() is bytes;
    }
    // md5 of empty string — well-known reference
    match /md5EmptyAllow/{id} {
      allow create: if request.auth != null
        && hashing.md5('').toHexString() == 'd41d8cd98f00b204e9800998ecf8427e';
    }
    // sha256 of 'abc' — NIST FIPS 180-4 reference
    match /sha256AbcAllow/{id} {
      allow create: if request.auth != null
        && hashing.sha256('abc').toHexString() == 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';
    }
    // crc32 reference (IEEE 802.3, '123456789' → 0xCBF43926)
    match /crc32RefAllow/{id} {
      allow create: if request.auth != null
        && hashing.crc32('123456789').toHexString() == 'cbf43926';
    }
    // crc32c reference (Castagnoli, '123456789' → 0xE3069283)
    match /crc32cRefAllow/{id} {
      allow create: if request.auth != null
        && hashing.crc32c('123456789').toHexString() == 'e3069283';
    }
    // hashing accepts pre-encoded Bytes too
    match /hashAcceptsBytesAllow/{id} {
      allow create: if request.auth != null
        && hashing.md5('hello'.toUtf8()) == hashing.md5('hello');
    }
    // Production Bytes encodings preserve base64url padding and use uppercase
    // hexadecimal output. These positive witnesses distinguish representation
    // fidelity from merely denying the historical lowercase/unpadded cases.
    match /base64PaddedAllow/{id} {
      allow create: if request.auth != null
        && 'hi'.toUtf8().toBase64() == 'aGk=';
    }
    match /base64UrlAlphabetAllow/{id} {
      allow create: if request.auth != null
        && '~~~'.toUtf8().toBase64() == 'fn5-';
    }
    match /base64StandardAlphabetDeny/{id} {
      allow create: if request.auth != null
        && '~~~'.toUtf8().toBase64() == 'fn5+';
    }
    match /md5UpperAllow/{id} {
      allow create: if request.auth != null
        && hashing.md5('').toHexString() == 'D41D8CD98F00B204E9800998ECF8427E';
    }
    match /sha256UpperAllow/{id} {
      allow create: if request.auth != null
        && hashing.sha256('abc').toHexString() == 'BA7816BF8F01CFEA414140DE5DAE2223B00361A396177A9CB410FF61F20015AD';
    }
    match /crc32UpperAllow/{id} {
      allow create: if request.auth != null
        && hashing.crc32('123456789').toHexString() == 'CBF43926';
    }
    match /crc32cUpperAllow/{id} {
      allow create: if request.auth != null
        && hashing.crc32c('123456789').toHexString() == 'E3069283';
    }
    match /crc32LittleEndianAllow/{id} {
      allow create: if request.auth != null
        && hashing.crc32('123456789').toHexString() == '2639F4CB';
    }
    match /crc32cLittleEndianAllow/{id} {
      allow create: if request.auth != null
        && hashing.crc32c('123456789').toHexString() == '839206E3';
    }
    // Multi-block, padding-boundary, Bytes, and non-ASCII digests. Each
    // expected value is the uppercase hexadecimal digest of the UTF-8 input.
    match /md5TwoBlockAllow/{id} {
      allow create: if request.auth != null
        && hashing.md5('12345678901234567890123456789012345678901234567890123456789012345678901234567890').toHexString() == '57EDF4A22BE3C955AC49DA2E2107B67A';
    }
    match /md5FiftyFiveBytesAllow/{id} {
      allow create: if request.auth != null
        && hashing.md5('xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx').toHexString() == '04364420E25C512FD958A70738AA8F72';
    }
    match /md5FiftySixBytesAllow/{id} {
      allow create: if request.auth != null
        && hashing.md5('xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx').toHexString() == '668A72D5BA17F08E62DABCAFAD6DB14B';
    }
    match /md5SixtyFourBytesInputAllow/{id} {
      allow create: if request.auth != null
        && hashing.md5('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'.toUtf8()).toHexString() == '014842D480B571495A4A0363793F7367';
    }
    match /md5NonAsciiAllow/{id} {
      allow create: if request.auth != null
        && hashing.md5('naïve café 日本語').toHexString() == '2204EF5849F3257174545026F61FFD01';
    }
    match /sha256FiftySixBytesAllow/{id} {
      allow create: if request.auth != null
        && hashing.sha256('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq').toHexString() == '248D6A61D20638B8E5C026930C3E6039A33CE45964FF2167F6ECEDD419DB06C1';
    }
    match /sha256OneTwelveBytesAllow/{id} {
      allow create: if request.auth != null
        && hashing.sha256('abcdefghbcdefghicdefghijdefghijkefghijklfghijklmghijklmnhijklmnoijklmnopjklmnopqklmnopqrlmnopqrsmnopqrstnopqrstu').toHexString() == 'CF5B16A778AF8380036CE59E7B0492370B249B11E8F07A51AFAC45037AFEE9D1';
    }
    match /sha256OneTwentyBytesInputAllow/{id} {
      allow create: if request.auth != null
        && hashing.sha256('xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'.toUtf8()).toHexString() == '13F05A0B594787F5ECD315EDC96141BD3243203D1B7D4F0836F37308B276BA98';
    }
    match /sha256NonAsciiAllow/{id} {
      allow create: if request.auth != null
        && hashing.sha256('naïve café 日本語').toHexString() == '7EDCE543470723527A9A231BD4C4EFA1B626CE8232318DCB1AA1AE9B43766867';
    }
    // DENY witness — wrong digest
    match /md5WrongDeny/{id} {
      allow create: if request.auth != null
        && hashing.md5('hello').toHexString() == 'deadbeef';
    }
${bytesLiteralBlocks}
  }
}`,
  cases: [
    {
      description: "toUtf8().size() == 5 ALLOW",
      expectation: 'ALLOW',
      method: 'create',
      path: 'utf8SizeAllow/d1',
      auth: { uid: 'alice' },
      data: {},
    },
    {
      description: "multi-byte UTF-8 size ALLOW",
      expectation: 'ALLOW',
      method: 'create',
      path: 'utf8MultibyteAllow/d2',
      auth: { uid: 'alice' },
      data: {},
    },
    {
      description: 'toBase64 round-trip DENY',
      expectation: 'DENY',
      method: 'create',
      path: 'base64Allow/d3',
      auth: { uid: 'alice' },
      data: {},
    },
    {
      description: 'toHexString round-trip ALLOW',
      expectation: 'ALLOW',
      method: 'create',
      path: 'hexAllow/d4',
      auth: { uid: 'alice' },
      data: {},
    },
    {
      description: 'is bytes ALLOW',
      expectation: 'ALLOW',
      method: 'create',
      path: 'isBytesAllow/d5',
      auth: { uid: 'alice' },
      data: {},
    },
    {
      description: 'md5 empty string DENY',
      expectation: 'DENY',
      method: 'create',
      path: 'md5EmptyAllow/d6',
      auth: { uid: 'alice' },
      data: {},
    },
    {
      description: 'sha256 abc DENY',
      expectation: 'DENY',
      method: 'create',
      path: 'sha256AbcAllow/d7',
      auth: { uid: 'alice' },
      data: {},
    },
    {
      description: 'crc32 IEEE 802.3 ref DENY',
      expectation: 'DENY',
      method: 'create',
      path: 'crc32RefAllow/d8',
      auth: { uid: 'alice' },
      data: {},
    },
    {
      description: 'crc32c Castagnoli ref DENY',
      expectation: 'DENY',
      method: 'create',
      path: 'crc32cRefAllow/d9',
      auth: { uid: 'alice' },
      data: {},
    },
    {
      description: 'hashing accepts Bytes input ALLOW',
      expectation: 'ALLOW',
      method: 'create',
      path: 'hashAcceptsBytesAllow/d10',
      auth: { uid: 'alice' },
      data: {},
    },
    {
      description: 'toBase64 padded production representation ALLOW',
      expectation: 'ALLOW',
      method: 'create',
      path: 'base64PaddedAllow/d12',
      auth: { uid: 'alice' },
      data: {},
    },
    {
      description: 'toBase64 URL-safe alphabet production representation ALLOW',
      expectation: 'ALLOW',
      method: 'create',
      path: 'base64UrlAlphabetAllow/d12u',
      auth: { uid: 'alice' },
      data: {},
    },
    {
      description: 'toBase64 standard alphabet representation DENY',
      expectation: 'DENY',
      method: 'create',
      path: 'base64StandardAlphabetDeny/d12s',
      auth: { uid: 'alice' },
      data: {},
    },
    {
      description: 'md5 uppercase production representation ALLOW',
      expectation: 'ALLOW',
      method: 'create',
      path: 'md5UpperAllow/d13',
      auth: { uid: 'alice' },
      data: {},
    },
    {
      description: 'sha256 uppercase production representation ALLOW',
      expectation: 'ALLOW',
      method: 'create',
      path: 'sha256UpperAllow/d14',
      auth: { uid: 'alice' },
      data: {},
    },
    {
      description: 'crc32 uppercase production representation DENY',
      expectation: 'DENY',
      method: 'create',
      path: 'crc32UpperAllow/d15',
      auth: { uid: 'alice' },
      data: {},
    },
    {
      description: 'crc32c uppercase production representation DENY',
      expectation: 'DENY',
      method: 'create',
      path: 'crc32cUpperAllow/d16',
      auth: { uid: 'alice' },
      data: {},
    },
    {
      description: 'crc32 little-endian production representation ALLOW',
      expectation: 'ALLOW',
      method: 'create',
      path: 'crc32LittleEndianAllow/d17',
      auth: { uid: 'alice' },
      data: {},
    },
    {
      description: 'crc32c little-endian production representation ALLOW',
      expectation: 'ALLOW',
      method: 'create',
      path: 'crc32cLittleEndianAllow/d18',
      auth: { uid: 'alice' },
      data: {},
    },
    {
      description: 'wrong md5 digest DENY',
      expectation: 'DENY',
      method: 'create',
      path: 'md5WrongDeny/d11',
      auth: { uid: 'alice' },
      data: {},
    },
    {
      description: 'md5 RFC 1321 two-block message ALLOW',
      expectation: 'ALLOW',
      method: 'create',
      path: 'md5TwoBlockAllow/d19',
      auth: { uid: 'alice' },
      data: {},
    },
    {
      description: 'md5 55-byte message ALLOW',
      expectation: 'ALLOW',
      method: 'create',
      path: 'md5FiftyFiveBytesAllow/d20',
      auth: { uid: 'alice' },
      data: {},
    },
    {
      description: 'md5 56-byte message ALLOW',
      expectation: 'ALLOW',
      method: 'create',
      path: 'md5FiftySixBytesAllow/d21',
      auth: { uid: 'alice' },
      data: {},
    },
    {
      description: 'md5 64-byte Bytes input ALLOW',
      expectation: 'ALLOW',
      method: 'create',
      path: 'md5SixtyFourBytesInputAllow/d22',
      auth: { uid: 'alice' },
      data: {},
    },
    {
      description: 'md5 non-ASCII string ALLOW',
      expectation: 'ALLOW',
      method: 'create',
      path: 'md5NonAsciiAllow/d23',
      auth: { uid: 'alice' },
      data: {},
    },
    {
      description: 'sha256 FIPS 180-4 448-bit message ALLOW',
      expectation: 'ALLOW',
      method: 'create',
      path: 'sha256FiftySixBytesAllow/d24',
      auth: { uid: 'alice' },
      data: {},
    },
    {
      description: 'sha256 FIPS 180-4 896-bit message ALLOW',
      expectation: 'ALLOW',
      method: 'create',
      path: 'sha256OneTwelveBytesAllow/d25',
      auth: { uid: 'alice' },
      data: {},
    },
    {
      description: 'sha256 120-byte Bytes input ALLOW',
      expectation: 'ALLOW',
      method: 'create',
      path: 'sha256OneTwentyBytesInputAllow/d26',
      auth: { uid: 'alice' },
      data: {},
    },
    {
      description: 'sha256 non-ASCII string ALLOW',
      expectation: 'ALLOW',
      method: 'create',
      path: 'sha256NonAsciiAllow/d27',
      auth: { uid: 'alice' },
      data: {},
    },
    ...bytesLiterals.map(({ key, condition, expectation }) => ({
      description: `bytes literal: ${condition} → ${expectation}`,
      expectation,
      method: 'create' as const,
      path: `bytesLiteral/${key}/d`,
      auth: { uid: 'alice' },
      data: {},
    })),
  ],
  group: 'stress',
};
