import { row } from './section.ts';

export default row({
  order: 30,
  behavior: "Nested objects overwrite — `set(ref, {a: 1})` after `set(ref, {a: 1, b: 2})` leaves `{a: 1}` only, NOT a merge (RTDB `set` is replacement, not merge)",
  status: "conforms",
  evidence: "oracle: `packages/conformance/observations/rtdb-modular/rtdb-modular-set-replaces-not-merges.json` — observed `final: {a: 1}` with `b` absent after the second set.",
  automation: "oracle-backed",
  oracleObservations: ["rtdb-modular-set-replaces-not-merges"],
  aliases: ["rtdb#113"],
});
