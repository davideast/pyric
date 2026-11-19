import { row } from './section.ts';

export default row({
  order: 100,
  featureKeys: ["documentSnapshotFromJSON", "querySnapshotFromJSON", "onSnapshotResume"],
  api: "documentSnapshotFromJSON / querySnapshotFromJSON / onSnapshotResume",
  behavior: "Deserializes JSON snapshot objects into active Pyric snapshot wrappers and attaches resume listener",
  status: "conforms",
  automation: "unit-backed",
  conformanceTests: ["packages/pyric/test/firestore/ssr-snapshots.test.ts"],
});
