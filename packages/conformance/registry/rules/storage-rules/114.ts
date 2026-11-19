import { row } from './section.ts';

export default row({
  order: 140,
  featureKeys: ["resource.metadata"],
  behavior: "`resource.metadata.<key>` custom-metadata access in dotted (`resource.metadata.owner`) and bracket (`resource.metadata['owner']`) form, including missing-key deny",
  status: "conforms",
  evidence: "NEW ROW, 2026-07-10: production capture proves dotted and bracket metadata access resolve identically, and a missing key denies. `oracle:rules-storage-metadata-access` matches production verdict-for-verdict on all 5 cases. RECAPTURED, 2026-09-28: the scenario adds 6 production cases (11 in all) for a missing key under bracket access on `resource.metadata` and `request.resource.metadata`: `!= 'x'`, `== null` and `!(... == 'x')` deny and `|| true` allows, as for a missing key under dot access. The evaluator already matched all 11.",
  risk: ["metadata"],
  riskScore: 1,
  riskReasons: ["asserts metadata shape"],
  automation: "oracle-backed",
  oracleObservations: ["rules-storage-metadata-access"],
  conformanceTests: ["packages/rules/test/storage/rules-oracle-conformance.test.ts"],
});
