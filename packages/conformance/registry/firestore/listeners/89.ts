import { row } from './section.ts';

export default row({
  order: 120,
  behavior: "Snapshot's ref is usable in follow-up ops under the new user (the ref is live, the listener identity is frozen — distinct)",
  evidence: "`unit:sandbox-live-identity.test.ts` (\"snapshot ref is usable in subsequent ops under the new user\"), oracle: `packages/conformance/observations/firestore/firestore-row-89-snapshot-ref-usable.json` — captured `snap.ref` from a docRef listener's first fire and `snap.docs[0].ref` from a query listener's first fire; both refs round-trip via `getDoc` (returning the same data) and `setDoc` (writes succeed and a follow-up `getDoc` confirms the new payload). `snap.ref.path` equals the original `doc(coll, id).path`. Both snap-ref shapes are first-class refs in prod, matching sandbox's tagged-ref guarantee.",
  risk: ["listener"],
  riskScore: 2,
  riskReasons: ["asserts listener semantics"],
  automation: "oracle-backed",
  oracleObservations: ["firestore-row-89-snapshot-ref-usable"],
  conformanceTests: ["packages/pyric/test/firestore/sandbox-live-identity.test.ts"],
  exceptionReason: "sandbox-only behavior — no prod equivalent to observe",
});
