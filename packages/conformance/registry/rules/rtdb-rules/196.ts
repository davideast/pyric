import { row } from './section.ts';

export default row({
  order: 530,
  featureKeys: ["root"],
  behavior: "Production refuses `(true ? data.parent() : null).exists()` at deploy with \"Invalid property access: target is not an object.\" Pyric's load-time check refuses it with the same message",
  status: "conforms",
  evidence: "`oracle:rules-rtdb-r62-deploy-ternary-snapshot-member` records the refusal. Production deployed it on 2026-10-15, and Pyric's type checker rejects member access on `NullableSnapshot` (`RuleDataSnapshot | null`) with the same error.",
  risk: ["rules-denial"],
  riskScore: 2,
  riskReasons: ["a ruleset pyric loads can be refused by firebase deploy"],
  oracleObservations: ["rules-rtdb-r62-deploy-ternary-snapshot-member"],
  conformanceTests: ["packages/conformance/src/rules-rtdb-replay.test.ts"],
  constructs: ["rtdb.method.snapshot.parent"],
});
