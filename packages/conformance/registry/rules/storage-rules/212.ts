import { row } from './section.ts';

export default row({
  order: 500,
  featureKeys: ["firestore.get", "firestore.exists"],
  behavior: "A `/` inside an interpolated `$(v)` in a `firestore.get()` or `firestore.exists()` path stays inside one segment, so a request value cannot select a deeper document (ST-H1-10)",
  status: "conforms",
  automation: "oracle-backed",
  evidence: "`oracle:rules-storage-h1-lookup-interpolated-slash` (captured 2026-10-27, 3 cases) records production DENYING `get` and `exists` when the interpolated value holds slashes, and ALLOWING the literal-path control. The evaluator agrees on all 3: an interpolated string is one segment, and a segment holding `/` names no document, so the call errors (`buildFirestoreDocPath` in `rules-firestore-lookup.ts`, #1330). `unit:storage/rules-oracle-conformance.test.ts` replays them with no pin, and `unit:storage/sandbox/rules-firestore-lookup-paths.test.ts` covers `get` and `exists`. The capture ran under the Rules Test API, where an unmocked call also errors, so it cannot show whether a real database answers `exists` on a slashed id with false; that the call errors, so `!exists(...)` also denies, is inferred and not captured.",
  risk: ["rules-denial"],
  riskScore: 4,
  riskReasons: ["asserts rules-denial behavior"],
  oracleObservations: ["rules-storage-h1-lookup-interpolated-slash"],
  conformanceTests: [
    "packages/rules/test/storage/rules-oracle-conformance.test.ts",
    "packages/rules/test/storage/sandbox/rules-firestore-lookup-paths.test.ts",
  ],
  constructs: ["storage.function.firestore.get", "storage.function.firestore.exists"],
});
