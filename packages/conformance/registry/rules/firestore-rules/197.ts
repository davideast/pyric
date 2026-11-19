import { row } from './section.ts';

export default row({
  order: 350,
  featureKeys: ["exists", "get"],
  behavior: "Rules Test API `functionMocks`: `get` and `exists` are separate service functions, so an `exists` mock never supplies a `get()` document, mock order does not matter, and a mock path is normalized like a lookup path (leading slash). Also, a sibling `{document=**}` read deny does not revoke a `match /menuItems/{id}` `list` grant (OR across matching blocks)",
  status: "conforms",
  automation: "oracle-backed",
  evidence: "NEW ROW, 2026-10-17: `oracle:rules-firestore-simcase-mock-and-path-fidelity` captures 6 production verdicts (5 ALLOW, 1 DENY) for FS-CON-6 / FS-COV-6a / FS-MET-6b / FS-COV-6b. An exists-only mock plus `get()` DENIES (\"Function not found error: Name: [get].\"), `exists: false` next to a `get` mock makes `!exists()` ALLOW, `[exists, get]` and `[get, exists]` both ALLOW, a `'/other/x'` mock path ALLOWS, and a doc-path `list` beside a `{document=**}` read deny ALLOWS. `unit:rules/oracle-conformance.test.ts` replays all 6, and `unit:rules/simulator/simcase-fidelity.test.ts` pins the simulator's `functionMocks` handling and the collection-path `list` form.",
  risk: ["rules-denial"],
  riskScore: 3,
  riskReasons: ["a mis-modelled mock or list widening flips simulate() verdicts both ways"],
  oracleObservations: ["rules-firestore-simcase-mock-and-path-fidelity"],
  conformanceTests: [
    "packages/pyric/test/rules/oracle-conformance.test.ts",
    "packages/rules/test/simulator/simcase-fidelity.test.ts",
  ],
  constructs: [
    "firestore.function.get",
    "firestore.function.exists",
    "firestore.semantic.recursive-wildcard",
  ],
});
