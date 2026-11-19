import { row } from './section.ts';

export default row({
  order: 560,
  featureKeys: ["getDatabase"],
  behavior: "Backend identity is per-`Sandbox` and per database instance name: two `getDatabase(sandbox)` calls on the same sandbox share data, two on different sandboxes don't, every database URL form the SDK maps to one instance name (`<name>.firebaseio.com`, `<name>.<region>.firebasedatabase.app`, `?ns=<name>`) shares one tree, and a URL `getDatabase(app, url)` rejects throws the SDK's `Error` and message. For an app whose options name the project, `<projectId>-default-rtdb` and `<projectId>`, the default instance of a project created before about 2020 (`https://<projectId>.firebaseio.com`), both name the default instance, on any host and in `?ns=`; one shared check, `isDefaultDatabaseInstance`, decides it for every plane",
  status: "conforms",
  evidence: "Oracle `rtdb-modular-database-url-instance` records the instance name and root URL the production SDK derives for each URL form, the error it throws for malformed URLs, and the `<projectId>-default-rtdb` default; `instances.test.ts` replays every recorded URL through the shared instance identity. `unit:modular/database-instances-cdd.test.ts` proves same-sandbox sharing and independent-sandbox isolation, and `multi-instance.test.ts` proves per-instance trees, rules, persistence and URL-form routing. `default-instance-names.test.ts` pins the shared default-instance check for both names and every URL form, and `legacy-default-url.test.ts` asserts an app on `https://<projectId>.firebaseio.com` gets the default instance's rules and data in the in-page sandbox (#1062).",
  automation: "oracle-backed",
  oracleObservations: ["rtdb-modular-database-url-instance"],
  conformanceTests: [
    "packages/pyric/test/database/modular/database-instances-cdd.test.ts",
    "packages/pyric/test/database/multi-instance.test.ts",
    "packages/pyric/test/sandbox/internal/instances.test.ts",
    "packages/pyric/test/sandbox/internal/default-instance-names.test.ts",
    "packages/pyric/test/database/legacy-default-url.test.ts",
  ],
  rowNumber: 39,
});
