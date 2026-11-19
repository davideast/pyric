import { cddLifecycleTests } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 60,
  featureKeys: ["getDatabase"],
  api: "pyric verify --rules rtdb:<instance>=<path>",
  behavior: "The verify capture records every instance a session held: the default instance's rules, data and URL, and each named instance's active rules and data under its name, on the SharedWorker, the Node host and the in-page runtime. RTDB events name the instance they hit. `pyric verify` replays each instance the session used on its own: only that instance's events, into the tree the session left it with, under that instance's candidate rules, so a write to one instance is never checked against another's rules or tree. Candidate rules come from `--rules rtdb=<path>` for the default instance and `--rules rtdb:<instance>=<path>` for a named one (a name or a database URL), else from `firebase.json` as `firebase deploy` resolves it: an array entry's `instance`, a `target` that `.firebaserc` maps for the project, and `database.rules.json` when there is no `database` key. The project's default instance name selects the default instance, and so does `<projectId>` or its `https://<projectId>.firebaseio.com` URL. A divergence on a named instance names it. An instance the session used with no candidate rules is an error that names it, with the reason a deploy target did not resolve; rules for an instance the session never used are refused with the instances it did use.",
  status: "conforms",
  automation: "oracle-backed",
  oracleObservations: ["rtdb-modular-multiple-instances", "rtdb-modular-database-url-instance"],
  evidence: "Oracle captures `rtdb-modular-multiple-instances` and `rtdb-modular-database-url-instance` record per-instance rules/tree isolation and instance URL forms, replayed across in-process, SharedWorker, and Node host `.pyric/last-session.json` captures and `pyric verify --rules rtdb:<instance>=` (`verify-and-assurance-replay.test.ts`). Also pinned by `packages/cli/test/verify/rtdb-instances.test.ts`, `verify-rtdb-instances.test.ts`, `verify-rtdb-legacy-default.test.ts`, `serve-init.test.ts`, `test/apps/rtdb-named-instance-tools`, and CDD assertion `rtdb-modular#MI6`.",
  conformanceTests: ["packages/conformance/test/rtdb-multi-instance/verify-and-assurance-replay.test.ts", "packages/cli/test/verify/rtdb-instances.test.ts", "packages/cli/test/cli/verify-rtdb-instances.test.ts", "packages/cli/test/cli/verify-rtdb-legacy-default.test.ts", "packages/cli/test/serve/worker/serve-init.test.ts", ...cddLifecycleTests],
});
