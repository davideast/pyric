import { row } from './section.ts';

export default row({
  order: 20,
  featureKeys: [],
  queryable: false,
  api: "pyric verify (RTDB denied operations)",
  behavior: "Every `set` (with the priority it would have written), `remove`, `update`, `setPriority`, `runTransaction`, `get` and listener attach an application user made and the rules denied is decided under the candidate rules against the tree as it stood at that point in the session, through the backend's non-mutating checks: nothing is written and no event is emitted. A denied `update` is decided as one request with every path written with it: its denial records the whole patch (`detail.patch`, with `detail.rootPath`). Still denied is no divergence; allowed is a `now-allowed` divergence. A `now-allowed` fails `pyric verify` (exit 1), as `now-denied` does. A listener the rules revoke after it attached, because of a write or a rules change, is recorded with `detail.revoked` and is not checked: it follows from the write or rules change, and its attach was checked as an allowed read.",
  statusNote: "a denied transaction is checked without the node's existing priority; the capture does not record the priority of a node the session never wrote",
  evidence: "Oracles `rtdb-rules-data-newdata-and-snapshot-methods`, `rtdb-rules-default-deny-and-runtime-errors` and `rtdb-modular-multipath-update-and-write-order` are replayed through `packages/conformance/test/rtdb-verify/session-verify-reads-and-denials-replay.test.ts` across in-process session capture, `SharedWorker` capture delivery, and Node host `.pyric/last-session.json` (`runVerify`), checking denied `set`, `setWithPriority`, `remove`, atomic multi-path `update` (`detail.patch` + `detail.rootPath`), `setPriority`, `runTransaction`, `get`, and listener attaches against point-in-time state before later admin deletes while skipping `detail.revoked` post-attach revocations. `packages/pyric/test/database/replay.test.ts`, `packages/cli/test/verify/verify.test.ts`, `test/apps/rtdb-verify-reads-and-denials` and CDD assertion `rtdb-modular#VR2` pin the unit and browser scenarios.",
  notes: "A denied update in a capture recorded before denials carried their patch is reported as an `unsupported` divergence, since its other paths are not in the capture.",
  oracleObservations: ["rtdb-rules-data-newdata-and-snapshot-methods", "rtdb-rules-default-deny-and-runtime-errors", "rtdb-modular-multipath-update-and-write-order"],
  conformanceTests: ["packages/conformance/test/rtdb-verify/session-verify-reads-and-denials-replay.test.ts", "packages/pyric/test/database/replay.test.ts", "packages/cli/test/verify/verify.test.ts", "test/apps/rtdb-verify-reads-and-denials/scenario.ts", "packages/pyric/test/database/cdd/lifecycle-and-identity.test.ts"],
});
