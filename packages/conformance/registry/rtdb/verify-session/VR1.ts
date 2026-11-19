import { row } from './section.ts';

export default row({
  order: 10,
  featureKeys: [],
  queryable: false,
  api: "pyric verify (RTDB reads and listener attaches)",
  behavior: "Every `get` and every listener attach (`onValue`, `onChildAdded`, `onChildChanged`, `onChildRemoved`, `onChildMoved`) an application user made and the rules allowed is decided again under the candidate rules, by its `.read` rules and the `query.*` expressions of the query it carried, against the replay tree at its point in the session. The read is not run, so a listener on a query with no `.indexOn`, which only warns, is not refused for its index. A read the candidate rules deny is a `now-denied` divergence with method `get` or `listen`. An admin read is not checked. A listener's attach and denial events carry its query (`request.query`) for value and child listeners alike.",
  evidence: "Oracles `rtdb-rules-cascade-bindings-and-auth-context`, `rules-rtdb-r30-query-rules` and `rtdb-modular-query-index-enforcement` are replayed through `packages/conformance/test/rtdb-verify/session-verify-reads-and-denials-replay.test.ts` across in-process session capture (`buildLiveSessionCaptureFixture` + `verifyFixture`), `SharedWorker` capture delivery (`applyServeInit`), and Node host `.pyric/last-session.json` (`runVerify`), checking allowed `get` and all five listener kinds (`onValue`, `onChildAdded`, `onChildChanged`, `onChildRemoved`, `onChildMoved`) with `query.*` constraints, unindexed query listeners, admin-read skipping, and `now-denied` divergences. `packages/pyric/test/database/replay.test.ts`, `packages/cli/test/verify/verify.test.ts`, `test/apps/rtdb-verify-reads-and-denials` and CDD assertion `rtdb-modular#VR1` pin the unit and browser scenarios.",
  oracleObservations: ["rtdb-rules-cascade-bindings-and-auth-context", "rules-rtdb-r30-query-rules", "rtdb-modular-query-index-enforcement"],
  conformanceTests: ["packages/conformance/test/rtdb-verify/session-verify-reads-and-denials-replay.test.ts", "packages/pyric/test/database/replay.test.ts", "packages/cli/test/verify/verify.test.ts", "test/apps/rtdb-verify-reads-and-denials/scenario.ts", "packages/pyric/test/database/cdd/lifecycle-and-identity.test.ts"],
});
