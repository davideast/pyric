import { row } from './section.ts';

export default row({
  order: 40,
  featureKeys: ["onChildRemoved"],
  behavior: "`onChildRemoved` fires when a child is deleted (via `remove(child)` or `set(child, null)`); snapshot carries the PRIOR value",
  status: "conforms",
  evidence: "oracle: `packages/conformance/observations/rtdb-modular/rtdb-modular-onchildremoved-fires-on-delete.json` — observed `firedOnDelete: 1, removedSnapCarriesPriorValue: true` (snapshot.val() was the pre-delete value).",
  risk: ["listener"],
  riskScore: 2,
  riskReasons: ["asserts listener semantics"],
  oracleObservations: ["rtdb-modular-onchildremoved-fires-on-delete"],
  aliases: ["rtdb#136"],
});
