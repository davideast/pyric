import { row } from './section.ts';

export default row({
  order: 155,
  featureKeys: ["initializeServerApp"],
  section: "`initializeApp(config, name?)` - the app registry",
  api: "FirebaseServerAppSettings.appCheckToken / authIdToken",
  behavior: "Forwards `settings.appCheckToken` through the AI Logic App Check gate across in-process and `@pyric/cli/register` Node planes without `initializeAppCheck`, and hydrates validated `settings.authIdToken` sessions for service requests",
  status: "conforms",
  evidence: "unit: `packages/pyric/test/app/server-app.test.ts` + `packages/cli/test/register/server-app-app-check.test.ts` (#1644)",
  risk: ["structural"],
  automation: "unit-backed",
  conformanceTests: [
    "packages/pyric/test/app/server-app.test.ts",
    "packages/cli/test/register/server-app-app-check.test.ts",
  ],
});
