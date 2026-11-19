import { row } from './section.ts';

export default row({
  order: 110,
  featureKeys: ["getStorage","getStorageSandbox"],
  behavior: "Unrecognized handle (not produced by a factory) → `TypeError` \"not a FirebaseStorage handle\"",
  status: "conforms",
  evidence: "`unit:service.test.ts` (\"rejects an object that was not produced by a factory\")",
  conformanceTests: ["packages/pyric/test/storage/service.test.ts"],
});
