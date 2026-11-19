import { row } from './section.ts';

export default row({
  order: 40,
  featureKeys: ["getDocFromCache","getDocsFromCache"],
  api: "getDocFromCache / getDocsFromCache",
  behavior: "Explicit cache reads distinguish cold and warm state: cold document reads reject with `unavailable`, cold queries return empty, and server/default reads populate subsequent cache reads",
  status: "conforms",
  evidence: "Real Chromium: `firestore-browser-lifecycle.json` captures cold and warm document and query cache behavior; replayed across in-page sandbox, SharedWorker, Node-hosted WebSocket, and served surface planes by `oracle-conformance.test.ts` and `firestore-browser-lifecycle.test.ts`.",
  risk: ["error-code","specific-value"],
  riskScore: 4,
  riskReasons: ["asserts Firebase error code(s): `unavailable`","asserts 1 specific value(s)"],
  automation: "oracle-backed",
  oracleObservations: ["firestore-browser-lifecycle"],
  conformanceTests: ["packages/pyric/test/firestore/oracle-conformance.test.ts","packages/pyric/test/firestore/tier1-cache-init-align.test.ts","packages/cli/test/serve/worker/oracle-captures/firestore-served-surface.test.ts","packages/cli/test/serve/worker/oracle-captures/firestore-browser-lifecycle.test.ts"],
  conformanceChecks: [{
    finding: "FS-148",
    observation: "firestore-browser-lifecycle",
    expect: { coldCacheThrew: true, coldCacheCode: "unavailable", warmCacheValue: "warm", coldQueryCacheSize: 0, serverQuerySize: 1, warmQueryCacheSize: 1 },
    probe: "packages/pyric/test/firestore/oracle-conformance.test.ts",
    guards: "Cold and warmed document/query cache reads match the browser SDK's externally observable results.",
  }],
});
