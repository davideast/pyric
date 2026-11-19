import { row } from './section.ts';

export default row({
  order: 390,
  featureKeys: [],
  behavior: "Pyric's load-time check refuses an `.indexOn` entry naming a child with a `.` in it, as production refuses to deploy it (CS-17)",
  evidence: "`oracle:rules-rtdb-r51-deploy-anchor-index-and-length-probes` (captured 2026-10-26) records production REJECTING `\".indexOn\": [\"x.y\"]` (\"Invalid key: x.y. Index must be either .value or declared on a valid path\") and ACCEPTING an empty entry `[\"\"]` and a nested path `[\"x/y\"]`. Pyric's load-time check refuses the dotted entry with production's text and accepts the other two; `unit:conformance/rules-rtdb-replay.test.ts` replays all three. Fixed in #1247 stream S5 (CS-17).",
  risk: ["rules-denial"],
  riskScore: 2,
  riskReasons: ["an index that loads and lints clean locally fails firebase deploy"],
  oracleObservations: ["rules-rtdb-r51-deploy-anchor-index-and-length-probes"],
  conformanceTests: ["packages/conformance/src/rules-rtdb-replay.test.ts"],
  constructs: ["rtdb.rule-kind.indexOn"],
});
