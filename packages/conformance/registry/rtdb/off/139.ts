import { row } from './section.ts';

export default row({
  order: 20,
  api: "Public API",
  behavior: "`off(ref, 'value')` removes only `value` listeners at that ref",
  status: "conforms",
  evidence: "Sandbox aligned (M48); oracle: `packages/conformance/observations/rtdb/rtdb-off-eventtype-precision.json` — registered TWO `value` listeners + one `child_added` at the same ref; after `off(ref, 'value')` (no callback), `valueListenersStopped: true` (neither value cb fired on subsequent writes) AND `childListenerStillFiringAfterOffValue: true` (the child listener kept firing). `offValueClearsAllValueListeners: true` confirms the no-callback variant removes ALL value listeners at the ref.",
  risk: ["specific-field","listener"],
  riskScore: 3,
  riskReasons: ["asserts a specific field/property value","asserts listener semantics"],
  automation: "oracle-backed",
  oracleObservations: ["rtdb-modular-off-stops-child-fires","rtdb-off-eventtype-precision"],
  aliases: ["rtdb#139"],
});
