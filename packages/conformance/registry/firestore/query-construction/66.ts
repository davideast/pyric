import { row } from './section.ts';

export default row({
  order: 170,
  featureKeys: ["query"],
  behavior: "Index validation against `firestore.indexes.json` — sandbox uses `LocalEnvironment`'s lint pass; prod has its own server-side validation",
  status: "diverged-documented",
  evidence: "divergence: sandbox can mis-pass a query that prod would reject at the server with `failed-precondition` if no index exists",
  risk: ["specific-value","error-code"],
  riskScore: 5,
  riskReasons: ["asserts 1 specific value(s)","asserts Firebase error code(s): `failed-precondition`"],
  automation: "unverified",
});
