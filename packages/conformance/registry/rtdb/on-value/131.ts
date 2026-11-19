import { row } from './section.ts';

export default row({
  order: 40,
  behavior: "Unsubscribe — the returned unsubscribe function stops further fires; subsequent writes produce 0 additional fires after `unsub()`",
  status: "conforms",
  evidence: "oracle: `packages/conformance/observations/rtdb-modular/rtdb-modular-onvalue-unsubscribe.json` — observed `preUnsubFires: 2, postUnsubFires: 2` (a write performed after `unsub()` produced 0 additional fires within a 500ms settle window).",
  risk: ["listener"],
  riskScore: 2,
  riskReasons: ["asserts listener semantics"],
  automation: "oracle-backed",
  oracleObservations: ["rtdb-modular-onvalue-unsubscribe"],
  aliases: ["rtdb#131"],
});
