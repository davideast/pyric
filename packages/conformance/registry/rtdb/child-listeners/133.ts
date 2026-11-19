import { row } from './section.ts';

export default row({
  order: 10,
  featureKeys: ["onChildAdded"],
  behavior: "`onChildAdded` replays the existing children on subscribe — one fire per existing child key, in the default priority index with key tie-breaking (unlike `onValue` which fires once with the parent snapshot)",
  status: "conforms",
  evidence: "oracle: `packages/conformance/observations/rtdb-modular/rtdb-modular-onchildadded-initial-replay.json` — seeded `{k1, k2, k3}`, observed 3 initial fires with `firedKeys: ['k1', 'k2', 'k3']`; the default priority/key order is separately pinned by `rtdb-modular-priority-contract`.",
  risk: ["listener-fire-count","listener"],
  riskScore: 4,
  riskReasons: ["asserts a specific listener fire count","asserts listener semantics"],
  oracleObservations: ["rtdb-modular-onchildadded-initial-replay"],
  aliases: ["rtdb#133"],
});
