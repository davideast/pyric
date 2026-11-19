import { row } from './section.ts';

export default row({
  order: 60,
  behavior: "Returned `Unsubscribe` stops further fires",
  evidence: "`unit:sandbox-target.test.ts`, oracle: `packages/conformance/observations/firestore/firestore-row-83-unsubscribe-stops-fires.json` — pre-unsubscribe write fired the listener (initial fire + write fire = 2 fires); after `unsub()`, a subsequent `setDoc` produced 0 additional fires (`postUnsubFireCount: 0`). Unsubscribe is durable; no fires arrive on the released callback after a 1.5s settle window.",
  risk: ["specific-field","listener"],
  riskScore: 3,
  riskReasons: ["asserts a specific field/property value","asserts listener semantics"],
  automation: "oracle-backed",
  oracleObservations: ["firestore-row-83-unsubscribe-stops-fires"],
  conformanceTests: ["packages/pyric/test/firestore/sandbox-target.test.ts"],
});
