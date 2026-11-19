import { row } from './section.ts';

export default row({
  order: 30,
  behavior: "Retry behavior — a read-document conflict reruns the callback against fresh data; `maxAttempts` bounds persistent contention",
  status: "conforms",
  evidence: "Oracle: `packages/conformance/observations/firestore/firestore-transaction-contention-retries.json` — two production Web SDK clients force one retry (`[0, 40]`, final `42`) and persistent contention with `maxAttempts: 2` runs exactly twice then throws `failed-precondition`. `packages/pyric/test/firestore/oracle-conformance.test.ts` replays both cases through the sandbox.",
  risk: ["specific-value","error-code","atomicity"],
  riskScore: 5,
  riskReasons: ["asserts 1 specific value(s)","asserts Firebase error code(s): `failed-precondition`","asserts transaction/batch atomicity"],
  automation: "oracle-backed",
  oracleObservations: ["firestore-transaction-contention-retries"],
  conformanceTests: ["packages/pyric/test/firestore/oracle-conformance.test.ts","packages/pyric/test/firestore/sandbox-target.test.ts"],
  conformanceChecks: [{
    finding: "FS-93",
    observation: "firestore-transaction-contention-retries",
    expect: {
      retryAttempts: 2,
      retryObservedCounts: [0, 40],
      retryFinalCount: 42,
      exhaustedMaxAttempts: 2,
      exhaustedAttempts: 2,
      exhaustedThrew: true,
      exhaustedCode: "failed-precondition",
      exhaustedFinalCount: 2,
    },
    probe: "packages/pyric/test/firestore/oracle-conformance.test.ts",
    guards: "Conflict retries use a fresh snapshot and persistent contention honors maxAttempts with production's terminal error code.",
  }],
});
