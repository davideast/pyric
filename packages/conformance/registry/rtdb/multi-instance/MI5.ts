import { cddLifecycleTests } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 50,
  featureKeys: ["getDatabase"],
  api: "database tool and pyric database <method> --instance",
  behavior: "Every method of the `database` service tool, and `pyric database <method>`, takes an optional `instance`: a bare instance name, any database URL, or `default`, parsed with the SDK's URL rules, so a malformed URL is refused with the message `getDatabase` throws. The project's `<projectId>-default-rtdb`, and `<projectId>` with its `https://<projectId>.firebaseio.com` URL, select the default instance, as `getDatabase(app)` and that URL reach one instance. A call reads and writes only the instance it names, under the held identity and that instance's own rules, on the in-process sandbox and on the Node host. An instance `firebase.json` does not declare and the sandbox holds no data for is refused with the instances the project has, rather than opened empty. A summary names the instance when it is not the default.",
  status: "conforms",
  automation: "oracle-backed",
  oracleObservations: ["rtdb-modular-multiple-instances", "rtdb-modular-database-url-instance"],
  evidence: "Oracle captures `rtdb-modular-database-url-instance` and `rtdb-modular-multiple-instances` record every accepted database URL form, malformed URL error message, and per-instance rule/data isolation, replayed across the `database` tool on both in-process sandbox and Node host (`firebase-json-and-tools-replay.test.ts`). Also pinned by `packages/cli/test/bridge/surface/methods/database/instance.test.ts`, `database-instance.test.ts`, `database-instance-catalog.test.ts`, `database-instance-catalog-legacy-default.test.ts`, `surface-method-runner.test.ts`, `hosted-sqlite.test.ts`, `test/apps/rtdb-named-instance-tools`, and CDD assertion `rtdb-modular#MI5`.",
  conformanceTests: ["packages/conformance/test/rtdb-multi-instance/firebase-json-and-tools-replay.test.ts", "packages/cli/test/bridge/surface/methods/database/instance.test.ts", "packages/cli/test/bridge/surface/database-instance.test.ts", "packages/cli/test/bridge/surface/database-instance-catalog.test.ts", "packages/cli/test/bridge/surface/database-instance-catalog-legacy-default.test.ts", "packages/cli/test/cli/surface-method-runner.test.ts", "packages/cli/test/serve/hosted-sqlite.test.ts", ...cddLifecycleTests],
});
