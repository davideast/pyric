import { row } from './section.ts';

export default row({
  order: 20,
  behavior: "`set(ref, null)` removes the path entirely — equivalent to `remove(ref)`, subsequent `get` returns `null`-val snapshot",
  status: "conforms",
  evidence: "oracle: `packages/conformance/observations/rtdb-modular/rtdb-modular-set-null-equals-remove.json` — observed `beforeExists: true → afterExists: false, afterVal: null` after `set(ref, null)`.",
  automation: "oracle-backed",
  oracleObservations: ["rtdb-modular-set-null-equals-remove"],
  aliases: ["rtdb#112"],
});
