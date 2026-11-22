import { row } from './section.ts';

export default row({
  order: 440,
  featureKeys: ["match", "path"],
  behavior: "A root `match /{path=**}` binds its wildcard to the request's full resource name as a path, so `path == path('databases/(default)/documents/c/1')` holds for get `c/1` (FS3-ROOT-1)",
  status: "conforms",
  evidence: "`oracle:rules-firestore-root-recursive-path-value` (captured 2026-11-04, 1 case) records production ALLOWING get `c/1` under `allow get: if path == path('databases/(default)/documents/c/1')` on the root `/{path=**}`. The simulator binds recursive wildcards as `rules.Path` and splices multi-segment `$(rest)` bindings into lookup paths (#1894), pinned by `unit:rules/simulator/root-recursive-own-allow.test.ts`.",
  risk: ["rules-denial"],
  riskScore: 2,
  riskReasons: ["a rule comparing a root recursive wildcard with a path is denied where production allows it"],
  oracleObservations: ["rules-firestore-root-recursive-path-value"],
  conformanceTests: [
    "packages/rules/test/simulator/root-recursive-own-allow.test.ts",
  ],
  constructs: ["firestore.binding.path-variable"],
});
