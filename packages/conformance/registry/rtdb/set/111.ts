import { row } from './section.ts';

export default row({
  order: 10,
  behavior: "Replaces the value at the path entirely; resolves to `undefined` (unlike `setDoc` which resolves to `void`, RTDB's `set` is documented as `Promise<void>`)",
  status: "conforms",
  evidence: "Oracle `rtdb-modular-write-return-validation` captures `null` in JSON for the resolved `undefined` value; sandbox row assertion `rtdb-modular#111` matches it.",
  automation: "oracle-backed",
  oracleObservations: ["rtdb-modular-write-return-validation"],
  conformanceTests: ["packages/pyric/test/database/modular/oracle-conformance-reference-writes.test.ts"],
  aliases: ["rtdb#111"],
});
