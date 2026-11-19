import { row } from './section.ts';

export default row({
  order: 20,
  featureKeys: [],
  behavior: "`Bytes`, the bytes literal `b'...'`, `String.toUtf8()`, and `hashing.{md5,sha256,crc32,crc32c}()` (Item 5.3) in rules",
  status: "conforms",
  evidence: "`oracle:rules-firestore-bytes-toutf8-and-hashing`: a 2026-09-26 production Firestore Rules Test API capture supplies 29 verdicts, including paired negative and positive witnesses for padded base64url, the URL-safe alphabet, uppercase hexadecimal MD5/SHA-256, and production's little-endian CRC32/CRC32C byte serialization. Nine of them pin MD5 and SHA-256 digests past a single block: the RFC 1321 80-byte message, 55-, 56-, and 64-byte inputs at the padding boundaries, the FIPS 180-4 448-bit and 896-bit messages, a 120-byte Bytes input, and a non-ASCII string hashed as its UTF-8 bytes. `unit:rules/oracle-conformance.test.ts` replays all verdicts against the local simulator; `unit:rules/simulator/hashing-builtins.test.ts` checks the built-in MD5 and SHA-256 against the RFC 1321 suite, the FIPS 180-4 examples including one million `a` characters, and `node:crypto` for every input length from 0 to 300 bytes as Bytes, hexadecimal, base64url, and strings; `unit:rules/simulator/wrappers/bytes.test.ts` pins the exact representations and reference digests. ROW EXTENDED, 2026-09-27: the same capture adds 22 production verdicts for the bytes literal, 51 in all. The prefix is `b` or `B` directly before a single- or double-quoted body. A plain character contributes its UTF-8 encoding. A backslash escapes a backslash, either quote, `n`, `r`, `t`, `b`, or `f`; `x` with exactly two hexadecimal digits of either case, or three octal digits up to 377, is one byte, so a literal holding the single byte E9 differs from `'é'.toUtf8()`. A bytes literal equals only bytes, orders lexicographically, is `in` a list by value, and hashes like the string it encodes; `+` on two bytes values and `[]` on bytes are error values that `|| true` absorbs. Production rejects the ruleset for a `u` escape (\"Invalid bytes literal\"), for `U`, `/`, `a`, `v`, `?`, and `X` escapes, a hex escape with one digit, an octal escape with fewer than three digits or above 377, a raw line break, whitespace after the prefix, and the prefixes `rb`, `br`, and `bb`; the shared grammar rejects the same forms, pinned by `unit:rules/grammar/bytes-literal.test.ts`. The grammar previously had no bytes literal, so a ruleset that used one failed to parse. The literal now evaluates to the Bytes value `toUtf8()` produces; `unit:rules/oracle-conformance.test.ts` replays all 51 verdicts and `unit:rules/simulator/bytes-literal.test.ts` pins the bytes literal cases.",
  risk: ["specific-value","rules-denial"],
  riskScore: 3,
  riskReasons: ["asserts 1 specific value(s)","asserts rules-denial behavior"],
  oracleObservations: ["rules-firestore-bytes-toutf8-and-hashing"],
  conformanceTests: [
    "packages/pyric/test/rules/oracle-conformance.test.ts",
    "packages/rules/test/simulator/hashing-builtins.test.ts",
    "packages/rules/test/simulator/wrappers/bytes.test.ts",
    "packages/rules/test/grammar/bytes-literal.test.ts",
    "packages/rules/test/simulator/bytes-literal.test.ts",
  ],
  constructs: ["firestore.method.string.toUtf8","firestore.function.hashing.md5","firestore.function.hashing.sha256","firestore.function.hashing.crc32","firestore.function.hashing.crc32c","firestore.method.bytes.size","firestore.method.bytes.toBase64","firestore.method.bytes.toHexString"],
});
