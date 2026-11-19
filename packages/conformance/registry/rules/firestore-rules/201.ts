import { row } from './section.ts';

export default row({
  order: 390,
  featureKeys: ["match"],
  behavior: "The literal segments of the service's root `match` path are compared with the request path: a ruleset rooted at another collection grants nothing outside it (FS2-ENF-1)",
  status: "conforms",
  evidence: "`oracle:rules-firestore-service-root-match-path` (captured 2026-10-27, 3 cases) records production DENYING `get` and `create` outside the root collection and ALLOWING the control inside it, under the root `/databases/{database}/documents/z`. `unit:rules/oracle-conformance.test.ts` replays all 3 cases against the local simulator, which matches the root against `/databases/(default)/documents/<path>` before resolving its children (#1327). `unit:rules/simulator/root-match-path.test.ts` denies `get`, `create`, `list` and a collection-group query of `c/1` under the roots `/databases/other/documents`, `/databases/{db}/documents/z`, `/databases/{db}/documentz` and `/b/{bucket}/o`, through `simulate()` and the in-page sandbox, and keeps the standard root, a root ending in a collection and a root ending in a recursive wildcard granting.",
  oracleObservations: ["rules-firestore-service-root-match-path"],
  conformanceTests: [
    "packages/pyric/test/rules/oracle-conformance.test.ts",
    "packages/pyric/test/rules/simulator/root-match-path.test.ts",
  ],
  constructs: ["firestore.rule-kind.match"],
});
