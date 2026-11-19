import { row } from './section.ts';

export default row({
  order: 30,
  behavior: "`push(ref, value)` writes the value AND returns the new child ref (both behaviors in one call); `push(ref)` mints the ref without writing",
  evidence: "oracle: `packages/conformance/observations/rtdb-modular/rtdb-modular-push-with-value.json` — `await push(parent, {hello:'world'})` returned a ref with a 20-char key; subsequent `get(r)` returned `{hello:'world'}`.",
  oracleObservations: ["rtdb-modular-push-with-value"],
  aliases: ["rtdb#126"],
});
