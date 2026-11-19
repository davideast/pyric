import { row } from './section.ts';

export default row({
  order: 180,
  featureKeys: ["unsupportedBuiltins"],
  behavior: "Explicit `UNSUPPORTED` reporting for unimplemented built-ins (Item 0.A) in rules — an unimplemented built-in abstains rather than silently DENYing",
  status: "conforms",
  evidence: "`oracle:rules-firestore-unsupported-feature-witness` — production Firestore Rules Test API verdicts for corpus scenario \"unsupported-feature-witness\", replayed verdict-for-verdict against the local rules simulator by `unit:rules/oracle-conformance.test.ts`; all cases match production.",
  oracleObservations: ["rules-firestore-unsupported-feature-witness"],
});
