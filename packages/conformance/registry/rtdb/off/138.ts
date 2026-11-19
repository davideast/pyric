import { row } from './section.ts';

export default row({
  order: 10,
  api: "Public API",
  behavior: "`off(ref)` removes ALL listeners at that ref (any event type, any callback)",
  status: "conforms",
  evidence: "oracle: `packages/conformance/observations/rtdb-modular/rtdb-modular-off-stops-child-fires.json` — after `off(ref)` with no eventType, a subsequent write produced `postOffFires: 0` against an `onChildAdded` registration.",
  risk: ["specific-field","listener"],
  riskScore: 3,
  riskReasons: ["asserts a specific field/property value","asserts listener semantics"],
  automation: "oracle-backed",
  oracleObservations: ["rtdb-modular-off-stops-child-fires"],
  aliases: ["rtdb#138"],
});
