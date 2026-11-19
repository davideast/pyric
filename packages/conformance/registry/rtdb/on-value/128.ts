import { row } from './section.ts';

export default row({
  order: 10,
  behavior: "Subscribing to a path with **existing data** fires the listener once with the current snapshot (the \"initial fire\")",
  status: "conforms",
  evidence: "oracle: `packages/conformance/observations/rtdb-modular/rtdb-modular-onvalue-initial-with-data.json` — observed exactly 1 initial fire within ~46ms of subscribe, snapshot.val() === the seeded payload.",
  risk: ["specific-field","listener"],
  riskScore: 3,
  riskReasons: ["asserts a specific field/property value","asserts listener semantics"],
  automation: "oracle-backed",
  oracleObservations: ["rtdb-modular-onvalue-initial-with-data"],
  aliases: ["rtdb#128"],
});
