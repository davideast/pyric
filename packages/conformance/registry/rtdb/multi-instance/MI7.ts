import { cddLifecycleTests } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 70,
  featureKeys: ["getDatabase"],
  api: "pyric assurance / pyric.assurance.target.v1",
  behavior: "Assurance campaigns (local-sandbox targets) declare named RTDB instances in `rules.rtdbInstances` and `state.rtdbInstances`, alongside the default instance. Operations name an `instance` (a name, URL, or `default`). The runner sets each instance's rules and data, executing operations on their target instance so mutations and access checks are isolated. An operation naming an instance the target does not declare is an invalid-input refusal listing the declared instances.",
  status: "conforms",
  automation: "oracle-backed",
  oracleObservations: ["rtdb-modular-multiple-instances", "rtdb-modular-database-url-instance"],
  evidence: "Oracle captures `rtdb-modular-multiple-instances` and `rtdb-modular-database-url-instance` record signed-out and signed-in per-instance verdicts and URL-to-instance resolution, replayed through `runAuthorizationCampaign` across `rules.rtdbInstances` and `state.rtdbInstances` (`verify-and-assurance-replay.test.ts`). Also pinned by `packages/cli/test/assurance/rtdb-instances.test.ts`, `test/apps/rtdb-named-instance-assurance/scenario.ts`, and CDD assertion `rtdb-modular#MI7`.",
  conformanceTests: ["packages/conformance/test/rtdb-multi-instance/verify-and-assurance-replay.test.ts", "packages/cli/test/assurance/rtdb-instances.test.ts", "test/apps/rtdb-named-instance-assurance/scenario.ts", ...cddLifecycleTests],
});
