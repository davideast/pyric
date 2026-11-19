import { row } from './section.ts';

export default row({
  order: 260,
  featureKeys: [],
  behavior: "A ruleset with NO `rules_version` declaration — production accepts it and defaults to v1",
  status: "conforms",
  evidence: "NEW ROW, 2026-07-17: production capture proves a version-less ruleset deploys and evaluates (production defaults `rules_version` to v1; the shared grammar previously rejected the file at parse — PR #333 grammar fix, the same evidence that reclassified corpus file 001-missing-version.rules from invalid to edge-cases). `oracle:rules-firestore-optional-rules-version` matches the local simulator verdict-for-verdict on all 3 cases.",
  oracleObservations: ["rules-firestore-optional-rules-version"],
  constructs: ["firestore.rule-kind.rules_version"],
});
