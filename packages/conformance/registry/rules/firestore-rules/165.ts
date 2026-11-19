import { row } from './section.ts';

export default row({
  order: 60,
  featureKeys: [],
  behavior: "`get()` of a missing document (RULES-B8) in rules — resource identity (`id`/`__name__`) exposure on a mocked/missing get() result",
  status: "conforms",
  evidence: "`oracle:rules-firestore-get-missing-doc` — production Firestore Rules Test API verdicts for corpus scenario \"get-missing-doc\", replayed verdict-for-verdict against the local rules simulator by `unit:rules/oracle-conformance.test.ts`. Serializable `functionMocks` now retain their production data-only shape, so mocked `get()` results leave `id`/`__name__` absent and both identity reads error to DENY; real DocStore lookups retain their separate identity-bearing path. All 8 cases match production.",
  risk: ["specific-value","rules-denial"],
  riskScore: 3,
  riskReasons: ["asserts 1 specific value(s)","asserts rules-denial behavior"],
  oracleObservations: ["rules-firestore-get-missing-doc"],
  constructs: ["firestore.function.get","firestore.function.exists"],
});
