import { row } from './section.ts';

export default row({
  order: 150,
  featureKeys: ["initializeServerApp"],
  section: "`initializeApp(config, name?)` - the app registry",
  api: "initializeServerApp(options?, settings?)",
  behavior: "Initializes a reference-counted `FirebaseServerApp` isolated from `getApp()` / `getApps()`, deterministic 32-bit hash naming (ignoring `releaseOnDeref`), browser `Window` refusal (`app/invalid-server-app-environment`), `deleteApp` refcount teardown (`app/server-app-deleted`), and `validateTokenTTL` console diagnostics",
  status: "conforms",
  evidence: "unit: `packages/pyric/test/app/server-app.test.ts` (differential against upstream `firebase/app` 13.4.0) + `packages/cli/test/register/server-app-app-check.test.ts`",
  risk: ["structural"],
  automation: "unit-backed",
  conformanceTests: [
    "packages/pyric/test/app/server-app.test.ts",
    "packages/cli/test/register/server-app-app-check.test.ts",
  ],
});
