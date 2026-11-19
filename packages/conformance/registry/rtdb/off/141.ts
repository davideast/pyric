import { row } from './section.ts';

export default row({
  order: 40,
  api: "Public API",
  behavior: "The returned unsubscribe function from `onValue(ref, cb)` is equivalent to `off(ref, 'value', cb)`",
  status: "conforms",
  evidence: "Sandbox aligned (M48); oracle: `packages/conformance/observations/rtdb/rtdb-onvalue-unsub-equivalence.json` — `unsubReturnType: 'function'`, `unsubReturnedFnStopsListener: true` (the captured return value halted fires on write), `offRefValueCbStopsListener: true` (the same effect via `off(ref, 'value', cb)`), `bothFormsEquivalent: true`.",
  risk: ["specific-field","listener"],
  riskScore: 3,
  riskReasons: ["asserts a specific field/property value","asserts listener semantics"],
  automation: "oracle-backed",
  oracleObservations: ["rtdb-onvalue-unsub-equivalence"],
  aliases: ["rtdb#141"],
});
