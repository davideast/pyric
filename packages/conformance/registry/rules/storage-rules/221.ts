import { row } from './section.ts';

export default row({
  order: 590,
  featureKeys: ["request", "resource", "match"],
  behavior: "A path wildcard named `request` or `resource` reads as the wildcard inside its block, not as the global of the same name (ST3-D-2)",
  status: "conforms",
  automation: "oracle-backed",
  evidence: "`oracle:rules-storage-st3-wildcard-shadows-global` (captured 2026-11-04 by the Storage rules engine defect hunt, 3 cases) records production ALLOWING `request == 'q'` under `match /pr/{request}` and `resource == 'q'` under `match /ps/{resource}` for a get of the segment `q`, and DENYING `request.method == 'get'` under `match /pt/{request}`. The Storage evaluator now resolves an identifier as a `let` binding or function parameter, then a path wildcard, then the `request` and `resource` globals, the order the Firestore simulator already uses (`resolveIdentifier` in `rules/simulator/evaluator.ts`), so it agrees on all 3; before #1886 it read the globals first and all 3 differed. `unit:storage/rules-oracle-conformance.test.ts` replays them with no pin, and `unit:storage/sandbox/rules-wildcard-shadows-global.test.ts` runs the three shapes through `getMetadata` and their Firestore twins through `getDoc`.",
  risk: ["rules-denial"],
  riskScore: 3,
  riskReasons: ["a ruleset that names a wildcard request or resource reads the global instead, so pyric can allow what production denies"],
  oracleObservations: ["rules-storage-st3-wildcard-shadows-global"],
  conformanceTests: [
    "packages/rules/test/storage/rules-oracle-conformance.test.ts",
    "packages/pyric/test/storage/sandbox/rules-wildcard-shadows-global.test.ts",
  ],
  constructs: ["storage.binding.request", "storage.binding.resource"],
});
