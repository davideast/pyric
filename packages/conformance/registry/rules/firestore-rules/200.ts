import { row } from './section.ts';

export default row({
  order: 380,
  featureKeys: ["rules_version"],
  behavior: "Without `rules_version = '2'`, a recursive wildcard does not match an empty path: `/cities/{city}/{document=**}` does not match `cities/SF` (FS2-SIM-12)",
  status: "conforms",
  evidence: "`oracle:rules-firestore-rules-version-1-recursive-glob` (captured 2026-10-27, 3 cases) records production DENYING `get` on `cities/SF` under a version-1 `match /cities/{city}/{document=**}` and ALLOWING `cities/SF/landmarks/x` and `top/a` under `/top/{document=**}`. `unit:rules/oracle-conformance.test.ts` replays all 3 cases against the local simulator, whose match resolver reads the ruleset's version and needs one or more segments for a recursive wildcard under version 1 (#1337). `unit:rules/simulator/rules-version-1-glob.test.ts` denies `get` and `list` of the city document with no `rules_version` and with `rules_version = '1'`, through `simulate()` and the in-page sandbox's `getDoc`, covers a nested block under a final glob and a root ending in a glob, and keeps version 2 and `2+modules` matching zero segments. The in-page sandbox's `getDocs` of the bare collection still lists through a widened document path (#1428).",
  oracleObservations: ["rules-firestore-rules-version-1-recursive-glob"],
  conformanceTests: [
    "packages/pyric/test/rules/oracle-conformance.test.ts",
    "packages/pyric/test/rules/simulator/rules-version-1-glob.test.ts",
  ],
  constructs: ["firestore.rule-kind.rules_version", "firestore.semantic.recursive-wildcard"],
});
