import { row } from './section.ts';

export default row({
  order: 390,
  featureKeys: ["hashing.md5", "hashing.sha256", "hashing.crc32", "hashing.crc32c", "toUtf8"],
  behavior: "Bytes from a bytes literal `b'...'`, from `toUtf8()`, and from `hashing.md5`, `hashing.sha256`, `hashing.crc32`, and `hashing.crc32c` over a string or Bytes: `size()` counts bytes, `toBase64()` is padded base64url, `toHexString()` is uppercase hexadecimal, Bytes compare by value, a string hashes like its UTF-8 bytes, and CRC digests serialize least-significant byte first. Hashing an int is an error",
  status: "conforms",
  automation: "oracle-backed",
  evidence: "CONFORMS, 2026-09-24: `oracle:rules-storage-stdlib-string-bytes-hashing` pins the md5, sha256, crc32, and crc32c digests of `abc` as hexadecimal, the base64url and hexadecimal encodings of `hi`, Bytes equality, and the production diagnostic `Unsupported operation error. Received: hashing.md5(int).` These are the representations the Firestore capture rules-firestore-bytes-toutf8-and-hashing pins for `cloud.firestore` (row #161), and the Storage evaluator computes them with the same shared Bytes wrapper and built-in hashing functions, whose MD5 and SHA-256 `unit:rules/simulator/hashing-builtins.test.ts` checks against the RFC 1321 and FIPS 180-4 vectors and `node:crypto`. `unit:storage/rules-oracle-conformance.test.ts` replays the verdicts and `unit:storage/sandbox/rules-hashing-methods.test.ts` pins the digests, encodings, and errors. ROW EXTENDED, 2026-09-27: `oracle:rules-storage-bytes-literal` captures 22 production verdicts for the bytes literal in Storage rules, the same cases and verdicts as the bytes literal cases of the Firestore capture rules-firestore-bytes-toutf8-and-hashing. The prefix is `b` or `B` directly before a single- or double-quoted body. A plain character contributes its UTF-8 encoding. A backslash escapes a backslash, either quote, `n`, `r`, `t`, `b`, or `f`; `x` with exactly two hexadecimal digits of either case, or three octal digits up to 377, is one byte. A bytes literal equals only bytes, orders lexicographically, is `in` a list by value, and hashes like the string it encodes; `+` on two bytes values and `[]` on bytes are error values that `|| true` absorbs. Production rejects the Storage ruleset for the same malformed forms as the Firestore one, including a `u` escape (\"Invalid bytes literal\"), and the shared grammar rejects them. The grammar previously had no bytes literal, so a Storage ruleset that used one failed to parse. The Storage evaluator now converts the literal to the Bytes value `toUtf8()` produces; `unit:storage/rules-oracle-conformance.test.ts` replays all 22 verdicts and `unit:storage/sandbox/rules-bytes-literal.test.ts` pins them.",
  risk: ["specific-value", "rules-denial"],
  riskScore: 3,
  riskReasons: ["asserts 4 specific value(s)", "asserts rules-denial behavior"],
  oracleObservations: ["rules-storage-stdlib-string-bytes-hashing", "rules-storage-bytes-literal"],
  conformanceTests: [
    "packages/rules/test/storage/rules-oracle-conformance.test.ts",
    "packages/rules/test/storage/sandbox/rules-hashing-methods.test.ts",
    "packages/rules/test/simulator/hashing-builtins.test.ts",
    "packages/rules/test/storage/sandbox/rules-bytes-literal.test.ts",
    "packages/rules/test/grammar/bytes-literal.test.ts",
  ],
  constructs: ["storage.method.size", "storage.operator.eq"],
});
