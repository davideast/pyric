import { row } from './section.ts';

export default row({
  order: 40,
  behavior: "`getFirestore(undefined)` is wrapped in the playground preview to default to the sandbox; production's unactivated canonical SDK still throws `app/no-app`, while a direct mirror call rejects the missing sandbox owner",
  statusNote: "(wrap)",
  evidence: "`playground:firestore-bare-getfirestore` — fix from PR #397 + oracle: `packages/conformance/observations/firestore/firestore-bare-getfirestore-no-default-app.json` (`code: 'app/no-app'` against digame-mas, fb-js-sdk 12.19.0 — confirms prod throw shape)",
  risk: ["specific-value","error-code","specific-field"],
  riskScore: 6,
  riskReasons: ["asserts 1 specific value(s)","asserts Firebase error code(s): `app/no-app`","asserts a specific field/property value"],
  automation: "oracle-backed",
  oracleObservations: ["firestore-bare-getfirestore-no-default-app"],
  exceptionReason: "playground / preview behavior — no firebase-js-sdk counterpart to observe",
});
