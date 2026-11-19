import { row } from './section.ts';

export default row({
  order: 120,
  featureKeys: ["FirebaseError"],
  section: "`FirebaseError` / `SDK_VERSION` / logger seam",
  api: "FirebaseError",
  behavior: "`FirebaseError` is an app-owned Error subclass: `instanceof Error`, `constructor.name` is `'FirebaseError'`, and it preserves `.code` and `.message` without loading `firebase/app`",
  status: "conforms",
  evidence: "oracle: `app-registry-firebaseerror-shape` (firebase 12.19.0) + replay: `oracle-conformance.test.ts`",
  risk: ["structural"],
  automation: "oracle-backed",
  oracleObservations: ["app-registry-firebaseerror-shape"],
  conformanceTests: ["packages/pyric/test/app/oracle-conformance.test.ts"],
});
