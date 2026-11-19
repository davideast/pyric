import { row } from './section.ts';

export default row({
  order: 130,
  behavior: "Simulator's allow/deny decision matches the real RTDB rules engine for the same `{ rules, mockData, auth, operation, path, newData }` tuple",
  status: "conforms",
  evidence: "oracle: `packages/conformance/observations/rtdb/rtdb-simulator-vs-prod-agreement.json` - 8 test rules x 29 (rule, op) tuples; 28 agreements, 1 disagreement at capture time (`r4-validate-structure`: the simulator did not evaluate `.validate` on writes). The `.validate` walk is now implemented (`src/rules/rtdb/simulation/handler.ts`, reached from all backend write sites; grammar array-literals + `hasChildren(keys)` fixed alongside), closing the recorded disagreement - replayed as prod-conforming denial in `oracle-conformance.test.ts`. The frozen capture documents the historical divergence",
  risk: ["specific-field"],
  riskScore: 1,
  riskReasons: ["asserts a specific field/property value"],
  automation: "oracle-backed",
  oracleObservations: ["rtdb-simulator-vs-prod-agreement"],
});
