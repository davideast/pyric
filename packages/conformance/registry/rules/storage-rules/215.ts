import { row } from './section.ts';

export default row({
  order: 530,
  featureKeys: ["firestore.exists"],
  behavior: "`$(rest)` from a `{rest=**}` capture interpolates its segments into a `firestore.exists()` path (ST-H2-9)",
  status: "conforms",
  automation: "oracle-backed",
  evidence: "`oracle:rules-storage-storage-lookup-path-interpolation` (captured 2026-10-27, 4 cases) records production ALLOWING a single-segment and a three-segment path capture interpolated into the lookup path, and DENYING the two `string()` forms. The evaluator agrees on all 4: a `path` value splices in as its segments, while `string(rest)` is one segment holding `/` and errors (`buildFirestoreDocPath` in `rules-firestore-lookup.ts`, #1330). `unit:storage/rules-oracle-conformance.test.ts` replays them with no pin, and `unit:storage/sandbox/rules-firestore-lookup-paths.test.ts` covers captures and `path()`.",
  risk: ["rules-denial"],
  riskScore: 2,
  riskReasons: ["asserts rules-denial behavior"],
  oracleObservations: ["rules-storage-storage-lookup-path-interpolation"],
  conformanceTests: [
    "packages/rules/test/storage/rules-oracle-conformance.test.ts",
    "packages/rules/test/storage/sandbox/rules-firestore-lookup-paths.test.ts",
  ],
  constructs: ["storage.function.firestore.exists"],
});
