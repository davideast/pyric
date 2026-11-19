import { row } from './section.ts';

export default row({
  order: 40,
  behavior: "Setting a key to `null` inside `update` removes that key — same equivalence as `set(ref, null)`",
  status: "conforms",
  evidence: "oracle: `packages/conformance/observations/rtdb-modular/rtdb-modular-update-null-removes-key.json` — after `set({a:1,b:2})` then `update({a:null})`, observed `final: {b:2}` with `a` absent.",
  automation: "oracle-backed",
  oracleObservations: ["rtdb-modular-update-null-removes-key"],
  aliases: ["rtdb#119"],
});
