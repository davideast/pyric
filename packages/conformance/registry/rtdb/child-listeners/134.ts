import { row } from './section.ts';

export default row({
  order: 20,
  featureKeys: ["onChildAdded"],
  behavior: "After subscribe, adding a child via `push` or `set(child, …)` fires `onChildAdded` exactly once for that key",
  status: "conforms",
  evidence: "oracle: `packages/conformance/observations/rtdb-modular/rtdb-modular-onchildadded-post-subscribe.json` — seeded `{k1,k2}`, observed `postSubscribeFires: 1, lastFire: {key:'k3', val:{v:3}}` after writing the new child.",
  risk: ["listener"],
  riskScore: 2,
  riskReasons: ["asserts listener semantics"],
  oracleObservations: ["rtdb-modular-onchildadded-post-subscribe"],
  aliases: ["rtdb#134"],
});
