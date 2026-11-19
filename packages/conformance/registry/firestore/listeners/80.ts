import { row } from './section.ts';

export default row({
  order: 10,
  behavior: "`onSnapshot(docRef, cb)` fires the initial snapshot **asynchronously** — never synchronously during the registering call. Prod empirically lands after a `setTimeout(0)` macrotask (the fire travels the network listener channel); the sandbox defers through its delivery scheduler (microtask). The matrix contract is \"asynchronous, never during register\", not \"exactly the next microtask\"",
  evidence: "Aligned via the listener delivery scheduler (`src/sandbox/firestore/local-environment.ts`): the initial fire is enqueued and delivered on a microtask, never during register — closing the divergence this row previously documented (the sandbox used to fire synchronously during registration; the sync-body tests were migrated to the flush/await idiom). Machine-checked against `packages/conformance/observations/firestore/firestore-row-80-onsnapshot-fires-initial.json` (`firstFireSyncDuringRegister: false`, fire count + contents) in `oracle-conformance.test.ts`; also `unit:sandbox-target.test.ts`, `playground:firestore-onsnapshot` (bundled) + `playground:firestore-row-80-onsnapshot-fires-initial` (one-claim).",
  risk: ["specific-field","listener","timing"],
  riskScore: 5,
  riskReasons: ["asserts a specific field/property value","asserts listener semantics","asserts timing semantics"],
  automation: "oracle-backed",
  oracleObservations: ["firestore-row-80-onsnapshot-fires-initial"],
  conformanceTests: ["packages/pyric/test/firestore/sandbox-target.test.ts"],
  exceptionReason: "playground / preview behavior — no firebase-js-sdk counterpart to observe",
});
