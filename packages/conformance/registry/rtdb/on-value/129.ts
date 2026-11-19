import { row } from './section.ts';

export default row({
  order: 20,
  behavior: "Subscribing to a **nonexistent path** still fires the listener once — with a `null`-val snapshot AND `exists() === false`. Matches Firestore's `onSnapshot`-on-missing-doc semantics: prod RTDB does NOT silently skip the initial fire for empty paths.",
  status: "conforms",
  evidence: "oracle: `packages/conformance/observations/rtdb-modular/rtdb-modular-onvalue-initial-no-data.json` — observed 1 initial fire on a never-written path with `firstFire.val: null, firstFire.exists: false` (~55ms after subscribe).",
  risk: ["specific-field","listener"],
  riskScore: 3,
  riskReasons: ["asserts a specific field/property value","asserts listener semantics"],
  automation: "oracle-backed",
  oracleObservations: ["rtdb-modular-onvalue-initial-no-data"],
  aliases: ["rtdb#129"],
});
