import { row } from './section.ts';

export default row({
  order: 30,
  featureKeys: ["ref","child"],
  behavior: "`child(ref, 'a/b')` joins a non-empty relative path, including embedded slashes, and synchronously rejects empty or forbidden-character paths with Firebase's captured error shape",
  status: "conforms",
  evidence: "Oracle `rtdb-modular-reference-shape-url`; sandbox row assertion `rtdb-modular#102` replays embedded-path joining plus empty/invalid validation.",
  automation: "oracle-backed",
  oracleObservations: ["rtdb-modular-reference-shape-url"],
  conformanceTests: ["packages/pyric/test/database/modular/oracle-conformance-reference-writes.test.ts"],
  aliases: ["rtdb#102"],
});
