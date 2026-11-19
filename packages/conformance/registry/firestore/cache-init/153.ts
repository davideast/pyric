import { row } from './section.ts';

export default row({
  order: 90,
  featureKeys: ["loadBundle", "namedQuery", "LoadBundleTask"],
  api: "loadBundle / namedQuery",
  behavior: "Decodes string/ArrayBuffer bundle payloads into local sandbox store and registers named queries",
  status: "conforms",
  automation: "unit-backed",
  conformanceTests: ["packages/pyric/test/firestore/bundles.test.ts"],
});
