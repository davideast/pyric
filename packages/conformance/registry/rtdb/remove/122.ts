import { row } from './section.ts';

export default row({
  order: 20,
  behavior: "Idempotent — `remove` on a path that's already absent resolves successfully (no-throw)",
  evidence: "oracle: `packages/conformance/observations/rtdb-modular/rtdb-modular-remove-idempotent.json` — `remove` on a never-written path observed `threw: false, afterExists: false`.",
  oracleObservations: ["rtdb-modular-remove-idempotent"],
  aliases: ["rtdb#122"],
});
