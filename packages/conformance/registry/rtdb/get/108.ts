import { row } from './section.ts';

export default row({
  order: 30,
  behavior: "`snap.exists()` is `false` when `val() === null`, `true` otherwise",
  evidence: "oracle: `packages/conformance/observations/rtdb-modular/rtdb-modular-get-missing-path.json` — observed `exists: false` for `val: null`.",
  risk: ["specific-field"],
  riskScore: 1,
  riskReasons: ["asserts a specific field/property value"],
  oracleObservations: ["rtdb-modular-get-missing-path"],
  aliases: ["rtdb#108"],
});
