import { row } from './section.ts';

export default row({
  order: 60,
  featureKeys: ["count"],
  behavior: "Aggregates count documents server-side without paying read cost per doc in prod; sandbox computes locally (no cost model)",
  status: "diverged-documented",
  evidence: "divergence: cost behavior differs, observable shape identical. Oracle-locked: `packages/conformance/observations/firestore/firestore-count-aggregate-shape.json` — `getCountFromServer().data()` returns `{ count: <number> }` (single key, no other fields). Empty query returns `count: 0` (not `null`/`undefined`); seeded 3 docs returns `count: 3`; filtered query honors the `where` constraint (`count: 2`).",
  risk: ["specific-field"],
  riskScore: 1,
  riskReasons: ["asserts a specific field/property value"],
  automation: "oracle-backed",
  oracleObservations: ["firestore-count-aggregate-shape"],
});
