import { row } from './section.ts';

export default row({
  order: 460,
  featureKeys: ["get", "exists"],
  behavior: "A `$(value)` in a `get()` or `exists()` path is one segment, whatever it holds: a value holding `/` names no document, so the lookup errors, while a literal deeper path and `path()` of a concatenated string read the deeper document (FS3-SIM-1)",
  status: "conforms",
  evidence: "`oracle:rules-firestore-interpolated-lookup-path-segments` (hunt capture `c7a-interp-lookups`, 2026-11-04, 8 cases) records production DENYING `exists()` with `k: 'x/sub/y'` (ex1), `!exists()` with the same value (ex2) and `get()` with `owner: 'u1/keys/k1'` (ge0), each a service call error whose argument keeps the value as one segment, and ALLOWING the plain-id controls ex0 and ge1, `|| true` (ex3), a literal deeper path (ex4) and `path()` of a concatenated string (ex5), even with the deeper document mocked as existing. `unit:rules/oracle-conformance.test.ts` replays all 8 verdicts. Fixed in #2177 (#1888): the simulator used to read ex1 and ge0 as the deeper document; `unit:sandbox/rules-lookup-path.test.ts` checks the same lookups through `setDoc` and `uploadBytes` on Firestore and Storage.",
  risk: ["rules-denial"],
  riskScore: 4,
  riskReasons: ["asserts that a lookup keyed by request data or a claim holding '/' names no document"],
  oracleObservations: ["rules-firestore-interpolated-lookup-path-segments"],
  conformanceTests: [
    "packages/pyric/test/rules/oracle-conformance.test.ts",
    "packages/pyric/test/sandbox/rules-lookup-path.test.ts",
  ],
  constructs: ["firestore.function.get", "firestore.function.exists"],
});
