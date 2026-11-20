import { row } from './section.ts';

export default row({
  order: 120,
  behavior: "`update` exposes `request.resource.data` / `getAfter()` as the existing doc **merged** with the payload via the `writeMode: { kind: 'update' }` path (the agent-facing `simulate()` opt-in); a sparse no-writeMode payload that drops a field now ERRORS on that field (RULES-B2) rather than silently reading null (RULES-B10)",
  status: "conforms",
  evidence: "`unit:rules/simulator/handler.test.ts` (RULES-B10 block), `oracle:firestore-rules-write-and-cross-doc-verdicts`",
  automation: "oracle-backed",
  oracleObservations: ["firestore-rules-write-and-cross-doc-verdicts"],
  conformanceTests: [
    "packages/rules/test/simulator/handler.test.ts",
    "packages/pyric/test/firestore/oracle-captures/firestore-rules-and-query-proof.test.ts",
    "packages/cli/test/serve/worker/oracle-captures/firestore-rules-and-query-proof.test.ts",
  ],
});
