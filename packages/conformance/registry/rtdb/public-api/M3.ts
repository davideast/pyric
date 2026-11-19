import { row } from './section.ts';

export default row({
  order: 30,
  featureKeys: ["getDatabase"],
  publishInCompatibilityDocs: false,
  behavior: "An in-module production target is intentionally absent; direct calls with a real `FirebaseApp` reject with package-resolution guidance",
  status: "unsupported",
  evidence: "`unit:modular.test.ts`; production remains the responsibility of the unchanged `firebase/database` package",
  automation: "unsupported",
  exceptionReason: "unsupported / intentionally out of scope",
  rowNumber: 3,
});
